/**
 * 导入 ClassIsland 的 .cidata 档案包。
 *
 * .cidata 本质是个 zip，里面除插件 DLL 外有：
 *   Profiles/<名字>.json          档案本体：TimeLayouts / ClassPlans / Subjects / ClassPlanGroups
 *   Profiles/<名字>.json.bak      同上（备份，忽略）
 *   Settings.json                 应用设置（198 个键），直接对应我们 ci_settings 的 data
 *   Config/Management/Policy.json 集控策略，直接对应 ci_policies 的 data
 *
 * 与 CES 导入（YAML + 课程网格）不同，这里是**already-structured** 的 ClassIsland 数据，
 * 所以不做任何结构重建，尽量原样搬运：
 *   · 每个时间轴 → 一份 ci_timelayouts（data = {uuid: TimeLayout}）
 *   · 全部科目   → 一份 ci_subjects（data = Subjects 原样，保留 Initial/TeacherName 等字段）
 *   · 按「课表群 + 引用时间轴」→ 一份 ci_classplans（整周合并，和编辑器的模型一致）
 *
 * 关键：**不重建对象**。分割线/行动段、ActionSet、AttachedObjects（上课提醒/放学提醒…）、
 * TimeRule 里的 RestrictsEnableRange 等字段全部原样保留 —— 这些东西我们不懂语义，
 * 重建一次就等于毁一次。
 */

import express from "express";
import AdmZip from "adm-zip";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { normalizeClassPlanData } from "../../../util/ci_data";

const router = express.Router();

const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const LIMITS = {
  profiles: 20,
  timeLayouts: 200,
  subjects: 800,
  classPlans: 400,
  segmentsPerLayout: 2000,
};

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

interface ParsedProfile {
  name: string;
  timeLayouts: Record<string, any>;
  subjects: Record<string, any>;
  classPlans: Record<string, any>;
  groups: Record<string, any>;
}

/** 统计时间轴每一类的段数，供预览展示 */
function summarizeLayouts(timeLayouts: Record<string, any>) {
  const out: any[] = [];
  for (const [uuid, tlm] of Object.entries<any>(timeLayouts || {})) {
    const layouts: any[] = Array.isArray(tlm?.Layouts) ? tlm.Layouts : [];
    const counts = { class: 0, break: 0, divider: 0, action: 0, other: 0 };
    const attachedGuids = new Set<string>();
    for (const l of layouts) {
      const t = Number(l?.TimeType);
      if (t === 0) counts.class++;
      else if (t === 1) counts.break++;
      else if (t === 2) counts.divider++;
      else if (t === 3) counts.action++;
      else counts.other++;
      for (const g of Object.keys(l?.AttachedObjects || {})) attachedGuids.add(g.toLowerCase());
    }
    out.push({
      uuid,
      name: String(tlm?.Name || ""),
      segments: layouts.length,
      ...counts,
      attachedSettings: [...attachedGuids],
    });
  }
  return out;
}

/** 按「群 + 引用时间轴」把 ClassPlans 归拢成一份课表 */
function groupClassPlans(profile: ParsedProfile) {
  const buckets = new Map<string, { groupId: string; groupName: string; timeLayoutId: string; plans: Record<string, any> }>();

  for (const [uuid, cp] of Object.entries<any>(profile.classPlans || {})) {
    const groupId = String(cp?.AssociatedGroup || "00000000-0000-0000-0000-000000000000");
    const timeLayoutId = String(cp?.TimeLayoutId || "");
    // 同组但引用不同时间轴的，拆成两份 —— 我们的课表资源只能绑一个时间表
    const key = `${groupId}::${timeLayoutId}`;
    if (!buckets.has(key)) {
      const g = profile.groups?.[groupId];
      buckets.set(key, {
        groupId,
        groupName: String(g?.Name || (groupId === "00000000-0000-0000-0000-000000000000" ? "全局课表群" : "默认")),
        timeLayoutId,
        plans: {},
      });
    }
    buckets.get(key)!.plans[uuid] = cp;
  }
  return [...buckets.values()];
}

/** 从 zip 里读出档案与可选设置，任何异常都抛出可读信息 */
function parseCidata(
  buf: Buffer,
  wantedProfile?: string,
): {
  profiles: ParsedProfile[];
  profileFiles: string[];
  settings?: any;
  policy?: any;
} {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch (e: any) {
    throw new Error("不是有效的 zip / .cidata 文件");
  }

  const entries = zip.getEntries();
  const profileEntries = entries.filter(
    (e) => !e.isDirectory && /^Profiles\/[^/]+\.json$/i.test(e.entryName),
  );
  if (!profileEntries.length) {
    throw new Error("这个包里没有 Profiles/*.json，可能不是 ClassIsland 的档案包");
  }
  if (profileEntries.length > LIMITS.profiles) {
    throw new Error(`档案数量超过限制（${profileEntries.length} > ${LIMITS.profiles}）`);
  }

  const profileFiles = profileEntries.map((e) => e.entryName);
  const wanted = String(wantedProfile || "").trim();
  const chosen = wanted
    ? profileEntries.filter((e) => e.entryName.toLowerCase() === `profiles/${wanted.toLowerCase()}.json`.toLowerCase())
    : profileEntries.filter((e) => /^Profiles\/Default\.json$/i.test(e.entryName));

  const targets = chosen.length ? chosen : profileEntries;

  const profiles: ParsedProfile[] = [];
  for (const e of targets) {
    let raw: any;
    try {
      raw = JSON.parse(zip.readAsText(e));
    } catch (err: any) {
      throw new Error(`${e.entryName} 不是合法 JSON：${err?.message ?? err}`);
    }

    const timeLayouts = raw?.TimeLayouts;
    const subjects = raw?.Subjects;
    const classPlans = raw?.ClassPlans;
    if (!timeLayouts || typeof timeLayouts !== "object") {
      throw new Error(`${e.entryName} 里没有 TimeLayouts，无法导入`);
    }
    if (Object.keys(timeLayouts).length > LIMITS.timeLayouts) throw new Error("时间轴数量超过限制");
    if (subjects && Object.keys(subjects).length > LIMITS.subjects) throw new Error("科目数量超过限制");
    if (classPlans && Object.keys(classPlans).length > LIMITS.classPlans) throw new Error("课表数量超过限制");
    for (const tlm of Object.values<any>(timeLayouts)) {
      if (Array.isArray(tlm?.Layouts) && tlm.Layouts.length > LIMITS.segmentsPerLayout) {
        throw new Error(`时间轴「${tlm?.Name ?? "?"}」段数超过限制`);
      }
    }

    profiles.push({
      name: e.entryName.replace(/^Profiles\//i, "").replace(/\.json$/i, ""),
      timeLayouts: timeLayouts || {},
      subjects: subjects && typeof subjects === "object" ? subjects : {},
      classPlans: classPlans && typeof classPlans === "object" ? classPlans : {},
      groups: raw?.ClassPlanGroups && typeof raw.ClassPlanGroups === "object" ? raw.ClassPlanGroups : {},
    });
  }

  const findEntry = (re: RegExp) => entries.find((e) => !e.isDirectory && re.test(e.entryName));
  const readJsonSafe = (re: RegExp) => {
    const e = findEntry(re);
    if (!e) return undefined;
    try {
      return JSON.parse(zip.readAsText(e));
    } catch {
      return undefined;
    }
  };

  return {
    profiles,
    profileFiles,
    settings: readJsonSafe(/^Settings\.json$/i),
    policy: readJsonSafe(/^Config\/Management\/Policy\.json$/i),
  };
}

/**
 * POST /v1/console/ci/import/cidata
 * body: { fileBase64, fileName?, profileName?, preview?,
 *         includeSettings?, includePolicy?, prefix? }
 *
 * preview: true 时只解析并回报「会创建什么」，不写库。
 */
router.post("/v1/console/ci/import/cidata", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const body = req.body || {};
    const fileBase64 = String(body.fileBase64 || "");
    if (!fileBase64) return res.status(400).json({ code: 400, msg: "缺少文件内容" });

    // base64 → Buffer
    let buf: Buffer;
    try {
      buf = Buffer.from(fileBase64, "base64");
    } catch {
      return res.status(400).json({ code: 400, msg: "文件内容不是合法 base64" });
    }
    if (!buf.length) return res.status(400).json({ code: 400, msg: "文件为空" });
    if (buf.length > MAX_ZIP_BYTES) {
      return res.status(413).json({ code: 413, msg: `文件太大（上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB）` });
    }
    // zip magic
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
      return res.status(400).json({ code: 400, msg: "这不是 zip 格式的 .cidata 文件" });
    }

    let parsed: ReturnType<typeof parseCidata>;
    try {
      parsed = parseCidata(buf, body.profileName);
    } catch (e: any) {
      return res.status(400).json({ code: 400, msg: e?.message || "解析失败" });
    }

    const prefix = String(body.prefix || "导入").slice(0, 30);
    const includeSettings = body.includeSettings !== false && !!parsed.settings;
    const includePolicy = body.includePolicy !== false && !!parsed.policy;

    // ── 预览：只回报结构，不落库 ──
    if (body.preview === true) {
      const summary = parsed.profiles.map((p) => {
        const groups = groupClassPlans(p);
        return {
          profile: p.name,
          timeLayouts: summarizeLayouts(p.timeLayouts),
          subjects: Object.values<any>(p.subjects).map((s) => String(s?.Name ?? "")).filter(Boolean),
          subjectCount: Object.keys(p.subjects).length,
          classPlans: groups.map((g) => ({
            groupId: g.groupId,
            groupName: g.groupName,
            timeLayoutId: g.timeLayoutId,
            timeLayoutName: String(p.timeLayouts[g.timeLayoutId]?.Name || ""),
            planCount: Object.keys(g.plans).length,
            weekDays: [...new Set(Object.values<any>(g.plans).map((cp) => Number(cp?.TimeRule?.WeekDay)))]
              .filter((n) => !Number.isNaN(n))
              .sort((a, b) => a - b),
            names: Object.values<any>(g.plans).map((cp) => String(cp?.Name ?? "")).slice(0, 10),
          })),
        };
      });

      return res.json({
        code: 0,
        msg: "ok",
        data: {
          fileName: String(body.fileName || ""),
          availableProfiles: parsed.profileFiles.map((f) => f.replace(/^Profiles\//i, "").replace(/\.json$/i, "")),
          importedProfiles: summary,
          hasSettings: !!parsed.settings,
          settingsKeys: parsed.settings ? Object.keys(parsed.settings).length : 0,
          hasPolicy: !!parsed.policy,
          willCreate: {
            settings: includeSettings ? 1 : 0,
            policy: includePolicy ? 1 : 0,
            subjects: summary.filter((s) => s.subjectCount > 0).length,
            timeLayouts: summary.reduce((n, s) => n + s.timeLayouts.length, 0),
            classPlans: summary.reduce((n, s) => n + s.classPlans.length, 0),
          },
        },
      });
    }

    // ── 正式导入 ──
    const db = req.db;
    const now = new Date();
    const created: any = { settings: null, policy: null, subjects: [], timeLayouts: [], classPlans: [] };

    // 设置 / 策略：直接原样搬运（对应 /v1/ci/:id/settings.json 与 policy.json 的下发体）
    if (includeSettings) {
      const doc = {
        _id: new ObjectId(),
        userId,
        name: `${prefix} 设置`,
        data: parsed.settings,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await db.collection("ci_settings").insertOne(doc);
      created.settings = String(doc._id);
    }
    if (includePolicy) {
      const doc = {
        _id: new ObjectId(),
        userId,
        name: `${prefix} 策略`,
        data: parsed.policy,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await db.collection("ci_policies").insertOne(doc);
      created.policy = String(doc._id);
    }

    for (const p of parsed.profiles) {
      // 科目：整份档案一份资源，字段原样保留
      let subjectsId: ObjectId | null = null;
      if (Object.keys(p.subjects).length) {
        const doc = {
          _id: new ObjectId(),
          userId,
          name: `${prefix} 课程表${parsed.profiles.length > 1 ? `（${p.name}）` : ""}`,
          data: p.subjects,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await db.collection("ci_subjects").insertOne(doc);
        subjectsId = doc._id;
        created.subjects.push({ id: String(doc._id), name: doc.name, count: Object.keys(p.subjects).length });
      }

      // 时间轴：一份资源一个时间轴，data = { uuid: TimeLayout }
      const tlDocIdByUuid = new Map<string, ObjectId>();
      for (const [uuid, tlm] of Object.entries<any>(p.timeLayouts)) {
        const doc = {
          _id: new ObjectId(),
          userId,
          name: `${prefix} ${String(tlm?.Name || "时间表")}`,
          data: { [uuid]: tlm },
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await db.collection("ci_timelayouts").insertOne(doc);
        tlDocIdByUuid.set(uuid, doc._id);
        created.timeLayouts.push({
          id: String(doc._id),
          name: doc.name,
          sourceUuid: uuid,
          segments: Array.isArray(tlm?.Layouts) ? tlm.Layouts.length : 0,
        });
      }

      // 课表：按「群 + 时间轴」合并成一份
      for (const g of groupClassPlans(p)) {
        const tlDocId = tlDocIdByUuid.get(g.timeLayoutId);
        if (!tlDocId) {
          log(
            `[ci/import/cidata] 跳过课表群「${g.groupName}」：引用的时间轴 ${g.timeLayoutId} 不在档案里`,
            "warn",
            "auth",
          );
          continue;
        }
        const doc = {
          _id: new ObjectId(),
          userId,
          name: `${prefix} ${g.groupName} 课表`,
          data: {
            classPlans: g.plans,
            timelayoutId: tlDocId,
            ...(subjectsId ? { subjectsId } : {}),
          },
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        // 兜底：即使来源档案里有 null Guid，也别把坏数据搬进来
        const fixRes = normalizeClassPlanData(doc.data);
        if (fixRes.fixed) {
          log(
            `[ci/import/cidata] 课表群「${g.groupName}」里有 ${fixRes.fixed} 处 null Guid，已规范化为 Guid.Empty`,
            "warn",
            "auth",
          );
        }
        await db.collection("ci_classplans").insertOne(doc);
        created.classPlans.push({
          id: String(doc._id),
          name: doc.name,
          plans: Object.keys(g.plans).length,
          timeLayoutResourceId: String(tlDocId),
          subjectsResourceId: subjectsId ? String(subjectsId) : null,
        });
      }
    }

    const total =
      (created.settings ? 1 : 0) +
      (created.policy ? 1 : 0) +
      created.subjects.length +
      created.timeLayouts.length +
      created.classPlans.length;

    log(
      `[ci/import/cidata] 用户 ${userId} 导入 ${body.fileName || ".cidata"}：` +
        `设置 ${created.settings ? 1 : 0}、策略 ${created.policy ? 1 : 0}、` +
        `科目 ${created.subjects.length}、时间轴 ${created.timeLayouts.length}、课表 ${created.classPlans.length}`,
      "info",
      "auth",
    );

    res.json({ code: 0, msg: "ok", data: { created, total } });
  } catch (e) {
    log(`[ci/import/cidata] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导入失败：" + (e as any)?.message });
  }
});

export default router;
