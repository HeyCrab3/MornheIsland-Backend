/**
 * 学校详情（控制台）。
 *
 * 一屏看清一个学校：有哪些班、共享了哪些资源、哪些设备在线、还有谁在这个学校里。
 * 设备只是通过 班级 → 学校 聚合出来，不写任何设备数据。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { isOnline } from "../../../grpc/clients";
import {
  CI_SCHOOLS,
  CI_SCHOOL_MEMBERS,
  normalizeSchoolName,
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

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

const RESOURCE_FIELDS = [
  { field: "classplanId", collection: "ci_classplans", label: "课表" },
  { field: "timelayoutId", collection: "ci_timelayouts", label: "时间表" },
  { field: "subjectsId", collection: "ci_subjects", label: "课程表" },
  { field: "settingsId", collection: "ci_settings", label: "设置" },
  { field: "policyId", collection: "ci_policies", label: "策略" },
] as const;

/** 校验：学校存在且我是成员 */
async function guard(req: any) {
  const userId = getUserId(req);
  if (!userId) return { error: { status: 401, body: { code: 401, msg: "请先登录" } } };

  const schoolId = toOid(req.params.id);
  if (!schoolId) return { error: { status: 400, body: { code: 400, msg: "schoolId 非法" } } };

  const school = await req.db.collection(CI_SCHOOLS).findOne({ _id: schoolId });
  if (!school) return { error: { status: 404, body: { code: 404, msg: "学校不存在" } } };

  const role = await getSchoolRole(req.db, schoolId, userId);
  if (!role) return { error: { status: 403, body: { code: 403, msg: "你不在这所学校里" } } };

  return { school, schoolId, userId, role, canManage: role === "owner" || role === "admin" };
}

/** GET /v1/console/ci/schools/:id/overview */
router.get("/v1/console/ci/schools/:id/overview", async (req, res) => {
  try {
    const g: any = await guard(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);
    const db = req.db;

    const classes = await db
      .collection("ci_classes")
      .find({ schoolId: g.schoolId })
      .project({
        name: 1, identity: 1, orgName: 1, userId: 1, updatedAt: 1,
        classplanId: 1, timelayoutId: 1, subjectsId: 1, settingsId: 1, policyId: 1,
      })
      .toArray();

    const classIds = classes.map((c: any) => c._id);

    // ── 设备：班级 → 学校 ──
    const clientRows = classIds.length
      ? await db
          .collection("ci_clients")
          .find({ classId: { $in: classIds } })
          .project({ cuid: 1, classId: 1, identity: 1, lastSeen: 1 })
          .toArray()
      : [];
    const classNameById = new Map(classes.map((c: any) => [String(c._id), c.name || c.identity || ""]));
    const devices = clientRows.map((d: any) => ({
      cuid: String(d.cuid ?? ""),
      classId: String(d.classId ?? ""),
      className: classNameById.get(String(d.classId)) || "",
      identity: String(d.identity ?? ""),
      online: isOnline(String(d.cuid)),
      lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
    }));

    const devicesByClass = new Map<string, { total: number; online: number }>();
    for (const d of devices) {
      const cur = devicesByClass.get(d.classId) || { total: 0, online: 0 };
      cur.total += 1;
      if (d.online) cur.online += 1;
      devicesByClass.set(d.classId, cur);
    }

    // ── 资源：学校级 + 学校班级仍在使用的个人资源 ──
    const resources: any[] = [];
    for (const rf of RESOURCE_FIELDS) {
      const usage = new Map<string, string[]>();
      for (const c of classes as any[]) {
        const rid = c[rf.field];
        if (!rid) continue;
        const k = String(rid);
        if (!usage.has(k)) usage.set(k, []);
        usage.get(k)!.push(c.name || c.identity || String(c._id));
      }

      const referencedIds = [...usage.keys()].map(toOid).filter(Boolean) as ObjectId[];

      // 学校级资源全部列出；个人资源只列被学校班级引用的
      const docs = await db
        .collection(rf.collection)
        .find(
          referencedIds.length
            ? { $or: [{ schoolId: g.schoolId }, { _id: { $in: referencedIds } }] }
            : { schoolId: g.schoolId },
        )
        .project({ name: 1, version: 1, schoolId: 1, userId: 1, updatedAt: 1 })
        .toArray();

      for (const d of docs) {
        const usedBy = usage.get(String(d._id)) || [];
        resources.push({
          type: rf.collection,
          field: rf.field,
          label: rf.label,
          id: String(d._id),
          name: d.name || "未命名",
          version: d.version ?? 1,
          schoolLevel: !!d.schoolId,
          usedByCount: usedBy.length,
          usedBy,
          updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
        });
      }
    }
    resources.sort((a, b) => a.label.localeCompare(b.label) || b.usedByCount - a.usedByCount);

    // ── 成员 ──
    const memberships = await db.collection(CI_SCHOOL_MEMBERS).find({ schoolId: g.schoolId }).toArray();
    const userIds = memberships.map((m: any) => m.userId).filter(Boolean);
    const userDocs = userIds.length
      ? await db
          .collection("user")
          .find({ _id: { $in: userIds } })
          .project({ userName: 1 })
          .toArray()
      : [];
    const nameById = new Map(userDocs.map((u: any) => [String(u._id), u.userName || ""]));
    const classCountByUser = new Map<string, number>();
    for (const c of classes as any[]) {
      const k = String(c.userId);
      classCountByUser.set(k, (classCountByUser.get(k) || 0) + 1);
    }
    const members = memberships.map((m: any) => ({
      userId: String(m.userId),
      userName: nameById.get(String(m.userId)) || "（已注销）",
      role: m.role || "member",
      classCount: classCountByUser.get(String(m.userId)) || 0,
      isMe: String(m.userId) === String(g.userId),
      joinedAt: m.joinedAt ? new Date(m.joinedAt).toISOString() : null,
    }));
    members.sort((a, b) => (a.role === b.role ? b.classCount - a.classCount : a.role === "owner" ? -1 : 1));

    // ── 班级列表（带上引用完整性和设备） ──
    const classList = (classes as any[])
      .map((c) => {
        const dev = devicesByClass.get(String(c._id)) || { total: 0, online: 0 };
        const missing: string[] = [];
        if (!c.classplanId) missing.push("课表");
        if (!c.timelayoutId) missing.push("时间表");
        if (!c.subjectsId) missing.push("课程表");
        return {
          id: String(c._id),
          name: c.name || "",
          identity: c.identity || "",
          orgName: c.orgName || "",
          missing,
          deviceCount: dev.total,
          onlineCount: dev.online,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    res.json({
      code: 0,
      msg: "ok",
      data: {
        school: {
          id: String(g.school._id),
          name: g.school.name,
          aliases: Array.isArray(g.school.aliases) ? g.school.aliases : [],
          createdAt: g.school.createdAt ? new Date(g.school.createdAt).toISOString() : null,
        },
        myRole: g.role,
        canManage: g.canManage,
        summary: {
          classCount: classes.length,
          unconfiguredCount: classList.filter((c) => c.missing.length).length,
          memberCount: members.length,
          deviceCount: devices.length,
          onlineDeviceCount: devices.filter((d) => d.online).length,
          schoolResourceCount: resources.filter((r) => r.schoolLevel).length,
          personalResourceCount: resources.filter((r) => !r.schoolLevel).length,
        },
        classes: classList,
        resources,
        devices,
        members,
      },
    });
  } catch (e) {
    log(`[ci/school_overview] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/schools/:id/rename  body { name } */
router.post("/v1/console/ci/schools/:id/rename", async (req, res) => {
  try {
    const g: any = await guard(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);
    if (!g.canManage) return res.status(403).json({ code: 403, msg: "只有学校管理员能改名" });

    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ code: 400, msg: "请填写学校名称" });
    if (name.length > 60) return res.status(400).json({ code: 400, msg: "学校名称最多 60 个字" });

    const normalizedName = normalizeSchoolName(name) || name.toLowerCase();
    const clash = await req.db.collection(CI_SCHOOLS).findOne({
      normalizedName,
      _id: { $ne: g.schoolId },
    });
    if (clash) {
      return res.status(409).json({
        code: 409,
        msg: `已经有一个叫「${clash.name}」的学校了，换个名字`,
      });
    }

    const oldName = g.school.name;
    const aliases = [...new Set([...(g.school.aliases || []), oldName].filter((a: string) => a && a !== name))];
    await req.db.collection(CI_SCHOOLS).updateOne(
      { _id: g.schoolId },
      { $set: { name, normalizedName, aliases, updatedAt: new Date() } },
    );
    log(`[ci/schools] 用户 ${g.userId} 把学校「${oldName}」改名为「${name}」`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { name } });
  } catch (e) {
    log(`[ci/school_overview/rename] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/schools/:id/classes  body { classIds: string[] }
 * 把更多自己名下的班级挂进这所学校（升级之后又新建的班走这里）。
 */
router.post("/v1/console/ci/schools/:id/classes", async (req, res) => {
  try {
    const g: any = await guard(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);
    if (!g.canManage) return res.status(403).json({ code: 403, msg: "只有学校管理员能挂班级" });

    const raw: any[] = Array.isArray(req.body?.classIds) ? req.body.classIds : [];
    const classIds = raw.map(toOid).filter(Boolean) as ObjectId[];
    if (!classIds.length) return res.status(400).json({ code: 400, msg: "请选择班级" });

    // 只能挂自己名下的班，否则等于把别人的班拉进自己学校
    const own = await req.db.collection("ci_classes").find({
      _id: { $in: classIds },
      userId: g.userId,
    }).project({ _id: 1, schoolId: 1 }).toArray();
    if (own.length !== classIds.length) {
      return res.status(403).json({ code: 403, msg: "包含不属于你的班级，已拒绝" });
    }
    const takenElsewhere = own.filter((c: any) => c.schoolId && String(c.schoolId) !== String(g.schoolId));
    if (takenElsewhere.length) {
      return res.status(409).json({
        code: 409,
        msg: `有 ${takenElsewhere.length} 个班级已经属于别的学校，先解绑再挂`,
      });
    }

    const r = await req.db.collection("ci_classes").updateMany(
      { _id: { $in: classIds } },
      { $set: { schoolId: g.schoolId, updatedAt: new Date() } },
    );
    log(`[ci/schools] 用户 ${g.userId} 往学校「${g.school.name}」挂入 ${r.modifiedCount} 个班级`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { linked: r.modifiedCount } });
  } catch (e) {
    log(`[ci/school_overview/classes] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/schools/:id/unlink
 * body { classId } —— 把一个班级移出学校（退回个人模式），资源不做任何改动。
 */
router.post("/v1/console/ci/schools/:id/unlink", async (req, res) => {
  try {
    const g: any = await guard(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);
    if (!g.canManage) return res.status(403).json({ code: 403, msg: "只有学校管理员能移出班级" });

    const classId = toOid(req.body?.classId);
    if (!classId) return res.status(400).json({ code: 400, msg: "classId 非法" });

    const cls = await req.db.collection("ci_classes").findOne({ _id: classId, schoolId: g.schoolId });
    if (!cls) return res.status(404).json({ code: 404, msg: "这个班级不在这所学校里" });

    await req.db.collection("ci_classes").updateOne(
      { _id: classId },
      { $unset: { schoolId: "" }, $set: { updatedAt: new Date() } },
    );
    log(`[ci/schools] 用户 ${g.userId} 把班级「${cls.name || classId}」移出学校「${g.school.name}」`, "info", "auth");
    res.json({ code: 0, msg: "ok" });
  } catch (e) {
    log(`[ci/school_overview/unlink] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
