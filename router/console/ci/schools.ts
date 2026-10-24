/**
 * 学校维度（控制台）。
 *
 * 产品决定（重要）：**不做自动批量迁移**。
 * 用户在「班级管理」页看到提示「建议升级为学校维度聚合管理」，
 * 点了才升级，而且只处理**他自己名下、同一个机构（orgName）**的那几个班。
 *
 * 升级时会自动匹配并带入两项东西：
 *   1. 这几个班**共享的资源**（同一份时间表/科目/设置/策略被 ≥2 个班引用）
 *      → 提升为学校级资源，同校其他班可以直接选；
 *   2. **关联的 gRPC 模式设备**（ci_clients 里 classId 属于这些班的）
 *      → 挂到学校后自动归入学校；其中在线的那批才是能实时遥控的。
 *
 * 注意：设备本来通过 classId → class → school 天然聚合，所以这里"导入"不需要
 * 改设备数据，只要把班级的 schoolId 设好；接口会把清单回报给前端展示。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { isOnline } from "../../../grpc/clients";
import {
  CI_SCHOOLS,
  CI_SCHOOL_MEMBERS,
  normalizeSchoolName,
  listMySchools,
  getSchoolRole,
} from "../../../util/school";

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

/** 班级上可以引用的资源字段 → 集合名 + 中文名 */
const RESOURCE_FIELDS = [
  { field: "classplanId", collection: "ci_classplans", label: "课表" },
  { field: "timelayoutId", collection: "ci_timelayouts", label: "时间表" },
  { field: "subjectsId", collection: "ci_subjects", label: "课程表" },
  { field: "settingsId", collection: "ci_settings", label: "设置" },
  { field: "policyId", collection: "ci_policies", label: "策略" },
] as const;

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/** GET /v1/console/ci/schools —— 我加入的学校 */
router.get("/v1/console/ci/schools", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;

    const schools = await listMySchools(db, userId);
    if (!schools.length) return res.json({ code: 0, msg: "ok", data: [] });

    const ids = schools.map((s) => toOid(s.id)).filter(Boolean) as ObjectId[];

    // 班级数
    const classAgg = await db
      .collection("ci_classes")
      .aggregate([
        { $match: { schoolId: { $in: ids } } },
        { $group: { _id: "$schoolId", count: { $sum: 1 } } },
      ])
      .toArray();
    const classCountBySchool = new Map(classAgg.map((a: any) => [String(a._id), Number(a.count) || 0]));

    // 设备数：班级 → 学校，顺带统计在线
    const schoolClasses = await db
      .collection("ci_classes")
      .find({ schoolId: { $in: ids } })
      .project({ _id: 1, schoolId: 1 })
      .toArray();
    const schoolByClass = new Map(schoolClasses.map((c: any) => [String(c._id), String(c.schoolId)]));
    const clientRows = schoolClasses.length
      ? await db
          .collection("ci_clients")
          .find({ classId: { $in: schoolClasses.map((c: any) => c._id) } })
          .project({ cuid: 1, classId: 1 })
          .toArray()
      : [];
    const deviceCount = new Map<string, number>();
    const onlineCount = new Map<string, number>();
    for (const c of clientRows) {
      const sid = schoolByClass.get(String(c.classId));
      if (!sid) continue;
      deviceCount.set(sid, (deviceCount.get(sid) || 0) + 1);
      if (isOnline(String(c.cuid))) onlineCount.set(sid, (onlineCount.get(sid) || 0) + 1);
    }

    res.json({
      code: 0,
      msg: "ok",
      data: schools.map((s) => ({
        ...s,
        classCount: classCountBySchool.get(s.id) || 0,
        deviceCount: deviceCount.get(s.id) || 0,
        onlineDeviceCount: onlineCount.get(s.id) || 0,
      })),
    });
  } catch (e) {
    log(`[ci/schools] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * GET /v1/console/ci/schools/candidates
 * 「班级管理」页的升级提示数据：把当前账号的班级按机构分组，
 * 只返回**同机构 ≥2 个班**且还没升级的组，并附上将被带入的共享资源与设备。
 */
router.get("/v1/console/ci/schools/candidates", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;

    const classes = await db
      .collection("ci_classes")
      .find({ userId })
      .project({
        orgName: 1, name: 1, identity: 1, schoolId: 1,
        classplanId: 1, timelayoutId: 1, subjectsId: 1, settingsId: 1, policyId: 1,
      })
      .toArray();

    // 按归一化机构名分组；没填 orgName 的班不参与（产品要求：不催用户补）
    const groups = new Map<string, any[]>();
    for (const c of classes) {
      const raw = String(c.orgName ?? "").trim();
      if (!raw) continue;
      const key = normalizeSchoolName(raw) || raw.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }

    const candidates: any[] = [];
    for (const [key, list] of groups) {
      // 已经升级过的组不再提示
      if (list.length < 2) continue;
      if (list.some((c) => c.schoolId)) continue;

      const classIds = list.map((c) => c._id);

      // ── 共享资源：同一份资源被组内 ≥2 个班引用 ──
      const sharedResources: any[] = [];
      for (const rf of RESOURCE_FIELDS) {
        const usage = new Map<string, { id: any; usedBy: string[] }>();
        for (const c of list) {
          const rid = c[rf.field];
          if (!rid) continue;
          const k = String(rid);
          if (!usage.has(k)) usage.set(k, { id: rid, usedBy: [] });
          usage.get(k)!.usedBy.push(c.name || String(c._id));
        }
        for (const [k, u] of usage) {
          if (u.usedBy.length < 2) continue;
          const doc = await db.collection(rf.collection).findOne({ _id: toOid(k) });
          if (!doc) continue;
          sharedResources.push({
            type: rf.collection,
            field: rf.field,
            label: rf.label,
            id: k,
            name: doc.name || "未命名",
            usedByCount: u.usedBy.length,
            usedBy: u.usedBy,
            alreadySchoolLevel: !!doc.schoolId,
          });
        }
      }

      // ── 关联设备：ci_clients.classId 落在这几个班里 ──
      const clientRows = await db
        .collection("ci_clients")
        .find({ classId: { $in: classIds } })
        .project({ cuid: 1, classId: 1, identity: 1, mac: 1, online: 1, lastSeen: 1 })
        .toArray();
      const nameByClassId = new Map(list.map((c: any) => [String(c._id), c.name || ""]));
      const devices = clientRows.map((d: any) => ({
        cuid: String(d.cuid ?? ""),
        classId: String(d.classId ?? ""),
        className: nameByClassId.get(String(d.classId)) || "",
        identity: String(d.identity ?? ""),
        // 以内存里的命令流为准：只有在线才能实时遥控
        online: isOnline(String(d.cuid)),
        lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
      }));

      candidates.push({
        normalizedName: key,
        orgName: String(list[0].orgName ?? "").trim(),
        classCount: list.length,
        classes: list.map((c: any) => ({
          id: String(c._id),
          name: c.name || "",
          identity: c.identity || "",
        })),
        sharedResources,
        devices,
        onlineDeviceCount: devices.filter((d) => d.online).length,
      });
    }

    // 班级多的排前面
    candidates.sort((a, b) => b.classCount - a.classCount);
    res.json({ code: 0, msg: "ok", data: { candidates } });
  } catch (e) {
    log(`[ci/schools/candidates] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/schools/upgrade
 * body: { classIds: string[], schoolName?: string, adoptSharedResources?: boolean }
 *
 * 把用户选中的这几个班升级成学校维度：建/复用学校、加成员、挂班级，
 * 并（默认）把组内共享资源提升为学校级。全部幂等。
 */
router.post("/v1/console/ci/schools/upgrade", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;
    const now = new Date();

    const rawIds: any[] = Array.isArray(req.body?.classIds) ? req.body.classIds : [];
    const classIds = rawIds.map(toOid).filter(Boolean) as ObjectId[];
    if (!classIds.length) return res.status(400).json({ code: 400, msg: "请选择要升级的班级" });

    // 只允许操作自己名下的班
    const classes = await db
      .collection("ci_classes")
      .find({ _id: { $in: classIds }, userId })
      .toArray();
    if (classes.length !== classIds.length) {
      return res.status(403).json({ code: 403, msg: "包含不属于你的班级，已拒绝" });
    }

    // 学校名：显式传入 > 组内最常见的 orgName
    const orgNames = classes.map((c: any) => String(c.orgName ?? "").trim()).filter(Boolean);
    const displayName =
      String(req.body?.schoolName ?? "").trim() ||
      orgNames.sort((a, b) => orgNames.filter((x) => x === b).length - orgNames.filter((x) => x === a).length)[0] ||
      "我的学校";
    const normalizedName = normalizeSchoolName(displayName) || displayName.toLowerCase();

    // 建/复用学校
    //
    // ⚠ 安全关键：**绝不能因为重名就并进别人的学校**。
    // 机构名是用户随手填的自由文本，早先的实现是「同名就复用，并把调用者写成 owner」，
    // 结果任何账号把机构名改成某校名字点一下升级，就能拿到那所学校的 owner 权限，
    // 改删全校共享资源 —— 凭猜名字接管别人的学校，真实的提权漏洞。
    //
    // 现在的规则：
    //   · 不存在同名学校 → 新建，调用者是 owner；
    //   · 存在且**我已经是成员** → 复用，角色不变（不会被自动提权）；
    //   · 存在但我不是成员 → 拒绝，只能通过邀请链接加入。
    let school: any = await db.collection(CI_SCHOOLS).findOne({ normalizedName });
    let created = false;
    let myRole = await (school ? getSchoolRole(db, school._id, userId) : null);

    if (school) {
      if (!myRole) {
        return res.status(409).json({
          code: 409,
          msg:
            `「${school.name}」这所学校已经由其他账号创建，不能靠同名机构直接并入。` +
            `请让该校管理员生成邀请链接，加入后再挂班级。`,
          data: { needInvite: true, schoolName: school.name },
        });
      }
    } else {
      school = {
        _id: new ObjectId(),
        name: displayName,
        normalizedName,
        aliases: [...new Set(orgNames.filter((n) => n !== displayName))],
        ownerUserId: userId,
        createdAt: now,
        updatedAt: now,
      };
      await db.collection(CI_SCHOOLS).insertOne(school);
      created = true;
      myRole = "owner";
    }

    // 只登记调用者自己。以前这里会把「同组涉及的其他账号」也写成成员，
    // 等于替别人做决定，去掉。
    await db.collection(CI_SCHOOL_MEMBERS).updateOne(
      { schoolId: school._id, userId },
      { $setOnInsert: { schoolId: school._id, userId, role: created ? "owner" : myRole, joinedAt: now } },
      { upsert: true },
    );

    // 挂班级
    const linked = await db.collection("ci_classes").updateMany(
      { _id: { $in: classIds } },
      { $set: { schoolId: school._id, updatedAt: now } },
    );

    // 共享资源提升为学校级 —— 只有能管这所学校的人才允许做
    let adopted = 0;
    const canAdopt = myRole === "owner" || myRole === "admin";
    if (req.body?.adoptSharedResources !== false && canAdopt) {
      for (const rf of RESOURCE_FIELDS) {
        const usage = new Map<string, number>();
        for (const c of classes as any[]) {
          const rid = c[rf.field];
          if (!rid) continue;
          usage.set(String(rid), (usage.get(String(rid)) || 0) + 1);
        }
        for (const [rid, count] of usage) {
          if (count < 2) continue;
          const oid = toOid(rid);
          if (!oid) continue;
          // 只提升确实属于本账号的资源，避免误改别人的
          const before = await db
            .collection(rf.collection)
            .findOne({ _id: oid, userId }, { projection: { schoolId: 1 } });
          if (!before) continue;
          // 已经是学校级的就别再算一次（否则重复点升级会重复计数）
          const already = before.schoolId && String(before.schoolId) === String(school._id);
          await db
            .collection(rf.collection)
            .updateOne({ _id: oid, userId }, { $set: { schoolId: school._id, updatedAt: now } });
          if (!already) adopted++;
        }
      }
    }

    // 设备清单（不改设备数据，仅回报）
    const clientRows = await db
      .collection("ci_clients")
      .find({ classId: { $in: classIds } })
      .project({ cuid: 1 })
      .toArray();

    log(
      `[ci/schools] 用户 ${userId} ${created ? "创建" : "复用"}学校「${displayName}」：班级 ${linked.modifiedCount}，提升共享资源 ${adopted}，设备 ${clientRows.length}`,
      "info",
      "auth",
    );

    res.json({
      code: 0,
      msg: "ok",
      data: {
        schoolId: String(school._id),
        schoolName: school.name,
        created,
        role: await getSchoolRole(db, school._id, userId),
        linkedClasses: linked.modifiedCount,
        adoptedResources: adopted,
        devices: clientRows.length,
        onlineDevices: clientRows.filter((d: any) => isOnline(String(d.cuid))).length,
      },
    });
  } catch (e) {
    log(`[ci/schools/upgrade] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
