/**
 * 学校邀请链接（控制台侧，需登录）。
 *
 * 生成 / 列表 / 吊销邀请，以及**接受**邀请。
 * 接受必须登录 —— 得知道是谁入校，所以不是公开端点。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { siteBaseUrl } from "../../../util/site_url";
import {
  CI_SCHOOL_INVITES,
  createInvite,
  checkInvite,
  revokeInvite,
} from "../../../util/school_invite";
import {
  CI_SCHOOLS,
  CI_SCHOOL_MEMBERS,
  getSchoolRole,
  isSchoolRole,
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

function inviteView(invite: any, req: any) {
  const base = siteBaseUrl(req);
  const expired = invite.expiresAt ? new Date(invite.expiresAt).getTime() < Date.now() : false;
  return {
    id: String(invite._id),
    token: invite.token,
    url: `${base}/schools/join/${invite.token}`,
    role: invite.role,
    createdAt: invite.createdAt ? new Date(invite.createdAt).toISOString() : null,
    expiresAt: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null,
    maxUses: Number(invite.maxUses || 0),
    uses: Number(invite.uses || 0),
    revoked: !!invite.revoked,
    expired,
    usable: !invite.revoked && !expired && Number(invite.uses || 0) < Number(invite.maxUses || 0),
  };
}

/** 学校管理员校验 */
async function guardManage(req: any) {
  const userId = getUserId(req);
  if (!userId) return { error: { status: 401, body: { code: 401, msg: "请先登录" } } };

  const schoolId = toOid(req.params.id);
  if (!schoolId) return { error: { status: 400, body: { code: 400, msg: "schoolId 非法" } } };

  const school = await req.db.collection(CI_SCHOOLS).findOne({ _id: schoolId });
  if (!school) return { error: { status: 404, body: { code: 404, msg: "学校不存在" } } };

  const role = await getSchoolRole(req.db, schoolId, userId);
  if (!role) return { error: { status: 403, body: { code: 403, msg: "你不在这所学校里" } } };
  if (role === "member") {
    return { error: { status: 403, body: { code: 403, msg: "只有学校管理员能管理邀请链接" } } };
  }
  return { userId, schoolId, school, role };
}

/** GET /v1/console/ci/schools/:id/invites —— 邀请列表 */
router.get("/v1/console/ci/schools/:id/invites", async (req, res) => {
  try {
    const g: any = await guardManage(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);

    const docs = await req.db
      .collection(CI_SCHOOL_INVITES)
      .find({ schoolId: g.schoolId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.json({
      code: 0,
      msg: "ok",
      data: docs.map((d) => inviteView(d, req)),
    });
  } catch (e) {
    log(`[school-invite/list] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/schools/:id/invites —— 生成邀请 */
router.post("/v1/console/ci/schools/:id/invites", async (req, res) => {
  try {
    const g: any = await guardManage(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);

    const wantRole = req.body?.role === "admin" ? "admin" : "member";
    // 只有创建者能发管理员邀请，避免管理员互相提权
    if (wantRole === "admin" && g.role !== "owner") {
      return res.status(403).json({ code: 403, msg: "只有创建者能邀请管理员" });
    }

    const invite = await createInvite(req.db, g.schoolId, g.userId, {
      expiresInHours: req.body?.expiresInHours,
      maxUses: req.body?.maxUses,
      role: wantRole,
    });
    res.json({ code: 0, msg: "ok", data: inviteView(invite, req) });
  } catch (e) {
    log(`[school-invite/create] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/schools/:id/invites/:inviteId/revoke —— 吊销 */
router.post("/v1/console/ci/schools/:id/invites/:inviteId/revoke", async (req, res) => {
  try {
    const g: any = await guardManage(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);

    const inviteId = toOid(req.params.inviteId);
    if (!inviteId) return res.status(400).json({ code: 400, msg: "邀请 id 非法" });

    const ok = await revokeInvite(req.db, inviteId, g.schoolId);
    if (!ok) return res.status(404).json({ code: 404, msg: "邀请不存在" });
    res.json({ code: 0, msg: "ok" });
  } catch (e) {
    log(`[school-invite/revoke] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** GET /v1/console/ci/school-invites/:token —— 接受页预览 */
router.get("/v1/console/ci/school-invites/:token", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const chk = await checkInvite(req.db, req.params.token);
    if (!chk.ok) return res.status(404).json({ code: 404, msg: chk.reason });

    const school = await req.db.collection(CI_SCHOOLS).findOne({ _id: chk.invite.schoolId });
    if (!school) return res.status(404).json({ code: 404, msg: "学校已不存在" });

    const alreadyRole = await getSchoolRole(req.db, chk.invite.schoolId, userId);
    const classCount = await req.db
      .collection("ci_classes")
      .countDocuments({ schoolId: chk.invite.schoolId });

    res.json({
      code: 0,
      msg: "ok",
      data: {
        school: { id: String(school._id), name: school.name },
        role: chk.invite.role,
        classCount,
        alreadyMember: !!alreadyRole,
        myRole: alreadyRole,
        expiresAt: chk.invite.expiresAt ? new Date(chk.invite.expiresAt).toISOString() : null,
      },
    });
  } catch (e) {
    log(`[school-invite/preview] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/school-invites/:token/accept  body { classIds?: string[] }
 *
 * 接受邀请 = 成为该校成员（角色由邀请决定），可选把自己的班级一并挂进来。
 * 注意：不会改任何资源的归属，共享资源要自己再点「共享」。
 */
router.post("/v1/console/ci/school-invites/:token/accept", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const chk = await checkInvite(req.db, req.params.token);
    if (!chk.ok) return res.status(404).json({ code: 404, msg: chk.reason });
    const invite = chk.invite;
    const db = req.db;
    const now = new Date();

    const school = await db.collection(CI_SCHOOLS).findOne({ _id: invite.schoolId });
    if (!school) return res.status(404).json({ code: 404, msg: "学校已不存在" });

    // ── 入校 ──
    const existingRole = await getSchoolRole(db, invite.schoolId, userId);
    if (!existingRole) {
      await db.collection(CI_SCHOOL_MEMBERS).insertOne({
        schoolId: invite.schoolId,
        userId,
        role: invite.role,
        joinedAt: now,
        invitedBy: invite.createdByUserId,
        inviteId: invite._id,
      });
      await db
        .collection(CI_SCHOOL_INVITES)
        .updateOne({ _id: invite._id }, { $inc: { uses: 1 }, $set: { lastUsedAt: now } });
    }

    // ── 可选：把自己的班级挂进来 ──
    let linked = 0;
    const rawIds: any[] = Array.isArray(req.body?.classIds) ? req.body.classIds : [];
    const classIds = rawIds.map(toOid).filter(Boolean) as ObjectId[];
    if (classIds.length) {
      const own = await db
        .collection("ci_classes")
        .find({ _id: { $in: classIds }, userId })
        .project({ _id: 1, schoolId: 1 })
        .toArray();
      if (own.length !== classIds.length) {
        return res.status(403).json({ code: 403, msg: "包含不属于你的班级，已拒绝" });
      }
      const taken = own.filter(
        (c: any) => c.schoolId && String(c.schoolId) !== String(invite.schoolId),
      );
      if (taken.length) {
        return res.status(409).json({
          code: 409,
          msg: `有 ${taken.length} 个班级已经属于别的学校，先解绑再挂`,
        });
      }
      const r = await db
        .collection("ci_classes")
        .updateMany(
          { _id: { $in: classIds } },
          { $set: { schoolId: invite.schoolId, updatedAt: now } },
        );
      linked = r.modifiedCount;
    }

    log(
      `[school-invite] 用户 ${userId} 通过邀请加入学校「${school.name}」` +
        `${existingRole ? "（已是成员）" : `（角色 ${invite.role}）`}，挂入班级 ${linked}`,
      "info",
      "auth",
    );

    res.json({
      code: 0,
      msg: "ok",
      data: {
        schoolId: String(school._id),
        schoolName: school.name,
        role: existingRole || invite.role,
        alreadyMember: !!existingRole,
        linked,
      },
    });
  } catch (e) {
    log(`[school-invite/accept] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/schools/:id/members/:userId/role  body { role }
 * 只有创建者能调整成员角色；不能改自己的角色（避免把最后一个 owner 降级）。
 */
router.post("/v1/console/ci/schools/:id/members/:userId/role", async (req, res) => {
  try {
    const g: any = await guardManage(req);
    if (g.error) return res.status(g.error.status).json(g.error.body);
    if (g.role !== "owner") {
      return res.status(403).json({ code: 403, msg: "只有创建者能调整成员角色" });
    }

    const targetId = toOid(req.params.userId);
    if (!targetId) return res.status(400).json({ code: 400, msg: "userId 非法" });
    if (String(targetId) === String(g.userId)) {
      return res.status(400).json({ code: 400, msg: "不能修改自己的角色" });
    }

    const role = req.body?.role;
    if (!isSchoolRole(role) || role === "owner") {
      return res.status(400).json({ code: 400, msg: "角色只能是 admin 或 member" });
    }

    const r = await req.db
      .collection(CI_SCHOOL_MEMBERS)
      .updateOne({ schoolId: g.schoolId, userId: targetId }, { $set: { role } });
    if (!r.matchedCount) return res.status(404).json({ code: 404, msg: "这个人不在学校里" });

    log(`[school-invite] 用户 ${g.userId} 把学校 ${g.schoolId} 成员 ${targetId} 设为 ${role}`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { role } });
  } catch (e) {
    log(`[school-invite/role] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
