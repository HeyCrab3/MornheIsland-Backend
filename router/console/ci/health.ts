/**
 * 档案体检：检查「班级 ↔ 课表 ↔ 时间表 ↔ 科目」引用链是否自洽，并支持一键修复。
 *
 * 起因是实测故障：档案库显示"时间表已关联"（看的是班级字段），
 * 而课表资源里记录的是**另一份**时间表（ClassPlan.TimeLayoutId 指向它），
 * 那份还是个没有 Layouts 的空壳 —— 结果 ClassIsland 报"未配置时间表"，
 * 下发的时间表也没有名字。这类问题在界面上完全看不出来，只能靠体检暴露。
 *
 * ⚠ 修复方向很重要：不能无脑"让班级跟课表走"。
 * 实测里课表侧指向的是空壳、班级侧才是真有内容的（23 段）那份，
 * 那样"修复"等于把空壳正式固化下来，比不修更糟。
 * 所以统一目标是**有内容的那一份**，两侧都指过去。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { getSchoolRole } from "../../../util/school";
import { countNullGuids, normalizeClassPlanData, normalizeTimeLayoutData } from "../../../util/ci_data";
import { snapshotDoc } from "../../../util/ci_snapshot";

const router = express.Router();

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

interface Issue {
  type: string;
  level: "error" | "warn";
  message: string;
  fixable: boolean;
}

/** data 里所有时间轴对象的 Layouts 总数 */
function countLayouts(data: any): number {
  if (!data || typeof data !== "object") return 0;
  return Object.values<any>(data).reduce(
    (n, v) => n + (Array.isArray(v?.Layouts) ? v.Layouts.length : 0),
    0,
  );
}

/**
 * 旧格式（导入遗留）：只有 TimePoints，没有 Layouts。
 *
 * 实测 45 个配了时间表的班级里有 20 份是这样。
 * **客户端只认 Layouts**（router/ci/timelayout.ts、util/cw2_schedule.ts 都只读 Layouts），
 * 所以这些班在 ClassIsland 里看到的是一张空白时间表 —— 这是真实故障，不是误报。
 * 但它不能自动修：TimePoints 没有上课/课间分段和名称，硬转出来只会得到错的时间表。
 */
function countTimePoints(data: any): number {
  if (!data || typeof data !== "object") return 0;
  return Object.values<any>(data).reduce(
    (n, v) => n + (Array.isArray(v?.TimePoints) ? v.TimePoints.length : 0),
    0,
  );
}

function countEntries(data: any): number {
  if (!data || typeof data !== "object") return 0;
  return Object.keys(data).length;
}

/** 体检单个班级 */
async function inspectClass(db: any, cls: any) {
  const issues: Issue[] = [];

  const cpId = toOid(cls.classplanId);
  if (!cpId) {
    issues.push({ type: "no-classplan", level: "error", message: "班级还没有关联课表", fixable: false });
    return { issues, fix: null };
  }

  const cp = await db.collection("ci_classplans").findOne({ _id: cpId });
  if (!cp) {
    issues.push({ type: "classplan-missing", level: "error", message: "关联的课表资源已被删除", fixable: false });
    return { issues, fix: null };
  }

  const plans = cp.data?.classPlans || cp.data || {};
  const classTlId = toOid(cls.timelayoutId);
  const cpTlId = toOid(cp.data?.timelayoutId);

  // ── 1. 两份时间表各自是否存在、有没有内容 ──
  const classTlDoc = classTlId ? await db.collection("ci_timelayouts").findOne({ _id: classTlId }) : null;
  const cpTlDoc = cpTlId ? await db.collection("ci_timelayouts").findOne({ _id: cpTlId }) : null;

  const classHas = !!(classTlDoc && countLayouts(classTlDoc.data) > 0);
  const cpHas = !!(cpTlDoc && countLayouts(cpTlDoc.data) > 0);

  const onlyClassHas = classHas && !cpHas;
  const onlyCpHad = cpHas && !classHas;

  if (classTlId && cpTlId && String(classTlId) !== String(cpTlId)) {
    if (onlyClassHas) {
      issues.push({
        type: "timelayout-mismatch",
        level: "error",
        message:
          "课表里记录的时间表是个空壳（没有任何时间段），真正有时间段的是班级关联的那份；" +
          "客户端按课表的记录去取，于是报「未配置时间表」",
        fixable: true,
      });
    } else if (onlyCpHad) {
      issues.push({
        type: "timelayout-mismatch",
        level: "warn",
        message: "班级关联的时间表是空壳，课表里记录的那份才有内容，两边指的不是同一份",
        fixable: true,
      });
    } else if (!classHas && !cpHas) {
      issues.push({
        type: "timelayout-mismatch",
        level: "error",
        message: "班级和课表关联的是两份不同的时间表，而且客户端都用不了（空壳或旧格式），会拿到空白时间表",
        fixable: false,
      });
    } else {
      issues.push({
        type: "timelayout-mismatch",
        level: "warn",
        message: "班级与课表关联的是两份不同的时间表，且都有内容，客户端只会用到课表里记录的那份",
        fixable: true,
      });
    }
  }

  const bestTlDoc = classHas ? classTlDoc : cpHas ? cpTlDoc : null;

  if (!classTlId && !cpTlId) {
    issues.push({ type: "no-timelayout", level: "error", message: "课表和班级都没有关联时间表", fixable: false });
  } else if (!bestTlDoc) {
    // 区分「真空白」和「旧格式」：旧格式有数据但客户端读不出来，提示要不一样才有用
    const legacyTp = Math.max(countTimePoints(classTlDoc?.data), countTimePoints(cpTlDoc?.data));
    if (legacyTp > 0) {
      issues.push({
        type: "timelayout-legacy-format",
        level: "error",
        message: `时间表是导入时留下的旧格式（只有 ${legacyTp} 个时间段 TimePoints、没有 Layouts），客户端只认 Layouts，所以会显示一张空白时间表；需要按标准格式重建时间表`,
        fixable: false,
      });
    } else {
      issues.push({
        type: "timelayout-empty",
        level: "error",
        message: "关联的时间表里没有任何有效时间段（空壳），下发后客户端会显示一张空白时间表",
        fixable: false,
      });
    }
  }

  // ── 2. ClassPlan 引用的 TimeLayoutId 是否存在于目标时间表 ──
  if (bestTlDoc) {
    const referencedTl = [
      ...new Set(
        Object.values<any>(plans)
          .map((p) => String(p?.TimeLayoutId ?? ""))
          .filter(Boolean),
      ),
    ];
    const tlKeys = Object.keys(bestTlDoc.data || {});
    const missing = referencedTl.filter((u) => !tlKeys.includes(u));
    if (missing.length) {
      issues.push({
        type: "classplan-timelayout-not-found",
        level: "warn",
        message: `课表里有 ${missing.length} 处引用的时间表 id 不在目标时间表里（${missing[0].slice(0, 8)}…），下发时会被自动对齐到唯一那份`,
        fixable: false,
      });
    }

    // ── 3. Classes 数量 vs 课时数 ──
    const tl = (bestTlDoc.data as any)[tlKeys[0]];
    const layouts: any[] = Array.isArray(tl?.Layouts) ? tl.Layouts : [];
    const classSlots = layouts.filter((l) => Number(l?.TimeType) === 0 || l?.TimeType === undefined).length;
    const bad = Object.values<any>(plans).filter((p) => {
      const n = Array.isArray(p?.Classes) ? p.Classes.length : 0;
      return n !== 0 && n !== layouts.length && n !== classSlots;
    });
    if (bad.length) {
      issues.push({
        type: "classes-count-mismatch",
        level: "warn",
        message: `${bad.length} 份课表的课时数与时间表对不上（时间表 ${layouts.length} 段 / 课时 ${classSlots} 节），可能导致科目错位`,
        fixable: false,
      });
    }
  }

  // ── 4. 科目引用 ──
  const classSubId = toOid(cls.subjectsId);
  const cpSubId = toOid(cp.data?.subjectsId);
  const classSubDoc = classSubId ? await db.collection("ci_subjects").findOne({ _id: classSubId }) : null;
  const cpSubDoc = cpSubId ? await db.collection("ci_subjects").findOne({ _id: cpSubId }) : null;
  const classSubHas = !!(classSubDoc && countEntries(classSubDoc.data) > 0);
  const cpSubHas = !!(cpSubDoc && countEntries(cpSubDoc.data) > 0);

  if (classSubId && cpSubId && String(classSubId) !== String(cpSubId)) {
    issues.push({
      type: "subjects-mismatch",
      level: classSubHas || cpSubHas ? "warn" : "error",
      message: "班级与课表关联的课程表（科目）不是同一份",
      fixable: classSubHas || cpSubHas,
    });
  }
  if (!classSubId && !cpSubId) {
    issues.push({ type: "no-subjects", level: "warn", message: "没有关联课程表（科目）", fixable: false });
  } else if (!classSubHas && !cpSubHas) {
    issues.push({
      type: "subjects-empty",
      level: "warn",
      message: "关联的课程表（科目）是空的或已被删除，课时会没有科目名称",
      fixable: false,
    });
  }

  const bestSubDoc = classSubHas ? classSubDoc : cpSubHas ? cpSubDoc : null;
  if (bestSubDoc) {
    const known = new Set(Object.keys(bestSubDoc.data || {}));
    const dangling = new Set<string>();
    for (const p of Object.values<any>(plans)) {
      for (const c of p?.Classes || []) {
        const sid = c?.SubjectId;
        if (sid && !known.has(String(sid))) dangling.add(String(sid));
      }
    }
    if (dangling.size) {
      issues.push({
        type: "dangling-subject",
        level: "warn",
        message: `课表里有 ${dangling.size} 个科目在当前科目表中不存在，这些课时会没有科目`,
        fixable: false,
      });
    }
  }

  // ── 6. 课表数据里的 null Guid（会让 ClassIsland 反序列化直接失败）──
  //
  // 客户端的 SubjectId 是非空 Guid 且带 GuidEmptyFallbackConverter，
  // 那个转换器只容忍 ""，遇到 null 会在 GetString() 抛异常 ——
  // 表现为课表直接爆炸。线上实测 95 份课表里有 28 份中招。
  const nullGuidCount = countNullGuids(cp.data);
  if (nullGuidCount > 0) {
    issues.push({
      type: "null-guid",
      level: "error",
      message:
        `课表里有 ${nullGuidCount} 处 Guid 字段是 null（空课时最常见），` +
        `ClassIsland 反序列化时会直接抛异常 —— 客户端课表会崩。可以一键修成 00000000-0000-0000-0000-000000000000`,
      fixable: true,
    });
  }

  const fix: any = {};
  if (bestTlDoc && String(cls.timelayoutId ?? "") !== String(bestTlDoc._id)) fix.timelayoutId = bestTlDoc._id;
  if (bestSubDoc && String(cls.subjectsId ?? "") !== String(bestSubDoc._id)) fix.subjectsId = bestSubDoc._id;

  return { issues, fix, cp, bestTlDoc, bestSubDoc, nullGuidCount };
}

/**
 * GET /v1/console/ci/health/resources
 *
 * `?schoolId=` 时检查**整所学校**的班级（含其他账号的班），
 * 但只有我自己建的班才给「可自动修复」—— 别人的班我能看能提示，
 * 不动手改，避免越权改别人的数据。
 */
router.get("/v1/console/ci/health/resources", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;

    // 作用域：自己的全部班级，或某所学校的全部班级
    const rawSchoolId = String(req.query?.schoolId ?? "").trim();
    let filter: any = { userId };
    let schoolName = "";
    if (rawSchoolId) {
      const schoolId = toOid(rawSchoolId);
      if (!schoolId) return res.status(400).json({ code: 400, msg: "schoolId 非法" });
      const role = await getSchoolRole(db, schoolId, userId);
      if (!role) return res.status(403).json({ code: 403, msg: "你不在这所学校里" });
      const school = await db.collection("ci_schools").findOne({ _id: schoolId });
      if (!school) return res.status(404).json({ code: 404, msg: "学校不存在" });
      schoolName = school.name;
      filter = { schoolId };
    }

    const classes = await db
      .collection("ci_classes")
      .find(filter)
      .project({ name: 1, identity: 1, classplanId: 1, timelayoutId: 1, subjectsId: 1, userId: 1 })
      .toArray();

    const result: any[] = [];
    let errorCount = 0;
    let warnCount = 0;

    for (const cls of classes) {
      const { issues, fix, nullGuidCount } = await inspectClass(db, cls);
      if (!issues.length) continue;
      errorCount += issues.filter((i) => i.level === "error").length;
      warnCount += issues.filter((i) => i.level === "warn").length;
      const mine = String(cls.userId) === String(userId);
      result.push({
        classId: String(cls._id),
        className: cls.name || "",
        identity: cls.identity || "",
        issues,
        mine,
        // 不是我的班：即使有可修项也不给按钮，后端也会拒。
        // null Guid 也归"可修" —— 它是格式问题，不是内容问题。
        canFix:
          mine &&
          (nullGuidCount > 0 || !!(fix && (fix.timelayoutId || fix.subjectsId))),
      });
    }

    res.json({
      code: 0,
      msg: "ok",
      data: {
        schoolId: rawSchoolId || null,
        schoolName,
        classes: result,
        summary: {
          classCount: classes.length,
          issueClassCount: result.length,
          errorCount,
          warnCount,
          otherOwnerCount: result.filter((r) => !r.mine).length,
        },
      },
    });
  } catch (e) {
    log(`[ci/health] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/health/fix  body { classId }
 *
 * 把班级字段**和课表内部记录**统一指向那份真正有内容的资源（空壳永远不会被选为目标）。
 * 目标资源必须存在且有内容，否则不动手。
 */
router.post("/v1/console/ci/health/fix", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const clsId = toOid(req.body?.classId);
    if (!clsId) return res.status(400).json({ code: 400, msg: "classId 非法" });

    const db = req.db;
    const cls = await db.collection("ci_classes").findOne({ _id: clsId, userId });
    if (!cls) {
      // 区分「不存在」和「不是你的班」：学校里能看到别人的班，但只能改自己的
      const other = await db.collection("ci_classes").findOne({ _id: clsId }, { projection: { name: 1 } });
      if (other) {
        return res.status(403).json({
          code: 403,
          msg: `「${other.name || "这个班"}」不是你的班级，只能由它的创建者登录后修复`,
        });
      }
      return res.status(404).json({ code: 404, msg: "班级不存在" });
    }

    const { fix, cp, bestTlDoc, bestSubDoc, nullGuidCount } = await inspectClass(db, cls);

    // ① null Guid 修复：这是格式问题，优先级最高 —— 不修的话客户端直接崩，
    //    时间表指向对不对都轮不到它发挥作用。
    let nullGuidFixed = 0;
    if (cp && nullGuidCount > 0) {
      // 先留档再改：normalizeClassPlanData 是就地修改 cp.data 的
      await snapshotDoc({
        db,
        collection: "ci_classplans",
        doc: cp,
        reason: "health-fix",
        userId,
        detail: `体检修复 ${nullGuidCount} 处 null Guid 之前`,
      });
      const r = normalizeClassPlanData(cp.data);
      nullGuidFixed = r.fixed;
      if (r.fixed) {
        await db.collection("ci_classplans").updateOne(
          { _id: cp._id },
          { $set: { data: cp.data, updatedAt: new Date() } },
        );
      }
    }

    if (!fix || (!fix.timelayoutId && !fix.subjectsId)) {
      if (nullGuidFixed) {
        log(`[ci/health] 用户 ${userId} 修复班级「${cls.name || clsId}」的 ${nullGuidFixed} 处 null Guid`, "info", "auth");
        return res.json({
          code: 0,
          msg: "ok",
          data: { fixed: ["nullGuid"], nullGuidFixed },
        });
      }
      return res.json({ code: 0, msg: "ok", data: { fixed: [], message: "没有可自动修复的项" } });
    }

    const set: any = { updatedAt: new Date() };
    if (fix.timelayoutId) set.timelayoutId = fix.timelayoutId;
    if (fix.subjectsId) set.subjectsId = fix.subjectsId;
    await db.collection("ci_classes").updateOne({ _id: clsId }, { $set: set });

    // 课表内部记录的引用也一起对齐，否则下次体检还是不一致
    const cpSet: any = { updatedAt: new Date() };
    if (bestTlDoc && String(cp?.data?.timelayoutId ?? "") !== String(bestTlDoc._id)) {
      cpSet["data.timelayoutId"] = bestTlDoc._id;
    }
    if (bestSubDoc && String(cp?.data?.subjectsId ?? "") !== String(bestSubDoc._id)) {
      cpSet["data.subjectsId"] = bestSubDoc._id;
    }
    if (Object.keys(cpSet).length > 1) {
      await db.collection("ci_classplans").updateOne({ _id: cp._id }, { $set: cpSet });
    }

    const fixed = Object.keys(fix);
    log(
      `[ci/health] 用户 ${userId} 修复班级「${cls.name || clsId}」：${fixed.join(", ")}` +
        `${nullGuidFixed ? `，另修 ${nullGuidFixed} 处 null Guid` : ""}` +
        `（目标时间表 ${bestTlDoc?._id ?? "-"} / 科目 ${bestSubDoc?._id ?? "-"}）`,
      "info",
      "auth",
    );
    res.json({ code: 0, msg: "ok", data: { fixed, nullGuidFixed } });
  } catch (e) {
    log(`[ci/health/fix] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/health/fix-null-guid
 *
 * 批量修我名下**所有**课表资源里的 null Guid。
 *
 * 为什么单独一个接口：档案体检是按「班级」遍历的，而没有挂到任何班级上的
 * 孤儿课表资源不会出现在体检结果里。线上实测 95 份课表里有 28 份中招，
 * 其中不少就是这类孤儿资源，用户根本看不到它们有问题。
 *
 * 只动 `userId = 我` 的资源；学校共享且不是我创建的一律不碰。
 * 幂等：修过的再跑就是 0。
 */
router.post("/v1/console/ci/health/fix-null-guid", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;

    const docs = await db
      .collection("ci_classplans")
      .find({ userId })
      .project({ name: 1, data: 1 })
      .toArray();

    let fixedDocs = 0;
    let fixedFields = 0;
    const details: any[] = [];

    for (const doc of docs) {
      const before = countNullGuids(doc.data);
      if (!before) continue;
      await snapshotDoc({
        db,
        collection: "ci_classplans",
        doc,
        reason: "health-fix",
        userId,
        detail: `批量修复 ${before} 处 null Guid 之前`,
      });
      const r = normalizeClassPlanData(doc.data);
      if (!r.fixed) continue;
      await db.collection("ci_classplans").updateOne(
        { _id: doc._id },
        { $set: { data: doc.data, updatedAt: new Date() } },
      );
      fixedDocs++;
      fixedFields += r.fixed;
      details.push({ id: String(doc._id), name: doc.name || "", fixed: r.fixed, remaining: r.remaining });
    }

    // 时间表那边也顺手过一遍（DefaultClassId 为 null 的情况）
    const tlDocs = await db
      .collection("ci_timelayouts")
      .find({ userId })
      .project({ name: 1, data: 1 })
      .toArray();
    let fixedTlDocs = 0;
    for (const doc of tlDocs) {
      const before = countNullGuids(doc.data);
      if (!before) continue;
      await snapshotDoc({
        db,
        collection: "ci_timelayouts",
        doc,
        reason: "health-fix",
        userId,
        detail: `批量修复 ${before} 处 null Guid 之前`,
      });
      const r = normalizeTimeLayoutData(doc.data);
      if (!r.fixed) continue;
      await db.collection("ci_timelayouts").updateOne(
        { _id: doc._id },
        { $set: { data: doc.data, updatedAt: new Date() } },
      );
      fixedTlDocs++;
      fixedFields += r.fixed;
    }

    if (fixedDocs || fixedTlDocs) {
      log(
        `[ci/health] 用户 ${userId} 批量修复 null Guid：课表 ${fixedDocs} 份（${fixedFields} 处）、时间表 ${fixedTlDocs} 份`,
        "info",
        "auth",
      );
    }

    res.json({
      code: 0,
      msg: "ok",
      data: {
        scannedClassPlans: docs.length,
        scannedTimeLayouts: tlDocs.length,
        fixedClassPlans: fixedDocs,
        fixedTimeLayouts: fixedTlDocs,
        fixedFields,
        details: details.slice(0, 50),
      },
    });
  } catch (e) {
    log(`[ci/health/fix-null-guid] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
