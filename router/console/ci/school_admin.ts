/**
 * 学校管理：删除 / 合并。
 *
 * 为什么需要：
 *   早期「按机构名升级」会把人名、缩写、手滑拼错都变成学校实体。
 *   实测线上 7 所学校里有 2 所班级数为 0（CLXX_LOD、同心实验），
 *   还有「同心实验」与「同心实验学校」明显是同一所被拆成两个。
 *   没有清理手段的话，这张表只会越攒越脏，学校的"统一管理"价值就废了。
 *
 * 两条铁律（都是防误伤）：
 *   1. 删除只允许**空学校**：还有班级或还有学校级资源时一律拒绝，先让用户自己处理干净。
 *      "级联删一批班"这种操作不该藏在一个删除按钮里。
 *   2. 合并必须**两个学校都是自己的 owner**：否则等于能把别人的学校并走。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { CI_SCHOOLS, CI_SCHOOL_MEMBERS, getSchoolRole } from "../../../util/school";
import { CI_SCHOOL_INVITES } from "../../../util/school_invite";
import { checkReauth, rejectReauth } from "../../../util/reauth.ts";

const router = express.Router();

/** 班级能引用的学校级资源集合 */
const RESOURCE_COLLECTIONS = [
  "ci_classplans",
  "ci_timelayouts",
  "ci_subjects",
  "ci_settings",
  "ci_policies",
] as const;

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

/** 学校当前的占用情况（班级数 + 学校级资源数） */
async function loadUsage(db: any, schoolId: ObjectId) {
  const [classCount, resourceCounts] = await Promise.all([
    db.collection("ci_classes").countDocuments({ schoolId }),
    Promise.all(
      RESOURCE_COLLECTIONS.map((c) => db.collection(c).countDocuments({ schoolId })),
    ),
  ]);
  const resources = RESOURCE_COLLECTIONS.reduce(
    (acc: Record<string, number>, c, i) => ({ ...acc, [c]: resourceCounts[i] }),
     {},
  );
  const resourceTotal = resourceCounts.reduce((a: number, b: number) => a + b, 0);
  return { classCount, resources, resourceTotal };
}

/**
 * POST /v1/console/ci/schools/:id/delete
 * 只允许删除空学校（0 班级、0 学校级资源）。
 */
router.post("/v1/console/ci/schools/:id/delete", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const schoolId = toOid(req.params.id);
    if (!schoolId) return res.status(400).json({ code: 400, msg: "schoolId 非法" });

    const school = await req.db.collection(CI_SCHOOLS).findOne({ _id: schoolId });
    if (!school) return res.status(404).json({ code: 404, msg: "学校不存在" });

    const role = await getSchoolRole(req.db, schoolId, userId);
    if (role !== "owner") {
      return res.status(403).json({ code: 403, msg: "只有学校创建者能删除学校" });
    }

    // 删学校是不可撤销操作：要求 10 分钟内重新登录过，或刚通过一次二步验证
    if (!checkReauth(req).ok) {
      return rejectReauth(res, "删除学校需要重新验证账户");
    }

    const usage = await loadUsage(req.db, schoolId);
    if (usage.classCount > 0 || usage.resourceTotal > 0) {
      const parts: string[] = [];
      if (usage.classCount) parts.push(`${usage.classCount} 个班级`);
      if (usage.resourceTotal) parts.push(`${usage.resourceTotal} 份学校级资源`);
      return res.status(409).json({
        code: 409,
        msg: `这所学校里还有${parts.join("和")}，不能直接删除。请先把班级移出、把资源共享收回，再来删。`,
        data: usage,
      });
    }

    await Promise.all([
      req.db.collection(CI_SCHOOL_INVITES).deleteMany({ schoolId }),
      req.db.collection(CI_SCHOOL_MEMBERS).deleteMany({ schoolId }),
      req.db.collection(CI_SCHOOLS).deleteOne({ _id: schoolId }),
    ]);

    log(`[ci/school-admin] 用户 ${userId} 删除了空学校「${school.name}」`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { deleted: school.name } });
  } catch (e) {
    log(`[ci/school-admin/delete] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * GET /v1/console/ci/schools/:id/merge-preview?intoId=xxx
 * 合并前先看清楚会搬多少东西，避免按完才发现不对。
 */
router.get("/v1/console/ci/schools/:id/merge-preview", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const fromId = toOid(req.params.id);
    const intoId = toOid(req.query?.intoId);
    if (!fromId || !intoId) return res.status(400).json({ code: 400, msg: "缺少学校 id" });
    if (String(fromId) === String(intoId)) {
      return res.status(400).json({ code: 400, msg: "不能合并到自己" });
    }

    const [from, into] = await Promise.all([
      req.db.collection(CI_SCHOOLS).findOne({ _id: fromId }),
      req.db.collection(CI_SCHOOLS).findOne({ _id: intoId }),
    ]);
    if (!from || !into) return res.status(404).json({ code: 404, msg: "学校不存在" });

    const [fromRole, intoRole] = await Promise.all([
      getSchoolRole(req.db, fromId, userId),
      getSchoolRole(req.db, intoId, userId),
    ]);
    if (fromRole !== "owner" || intoRole !== "owner") {
      return res.status(403).json({ code: 403, msg: "两个学校都得是你的（创建者）才能合并" });
    }

    const [fromUsage, intoUsage] = await Promise.all([
      loadUsage(req.db, fromId),
      loadUsage(req.db, intoId),
    ]);

    // 已被 from 的班级引用、但 into 里同名同类型已有的资源 —— 提示可能出现"重名"
    const dupNames: string[] = [];
    for (const col of RESOURCE_COLLECTIONS) {
      const [fromDocs, intoDocs] = await Promise.all([
        req.db.collection(col).find({ schoolId: fromId }).project({ name: 1 }).toArray(),
        req.db.collection(col).find({ schoolId: intoId }).project({ name: 1 }).toArray(),
      ]);
      const intoNames = new Set(intoDocs.map((d: any) => String(d.name ?? "")));
      for (const d of fromDocs) {
        if (intoNames.has(String(d.name ?? ""))) dupNames.push(String(d.name));
      }
    }

    res.json({
      code: 0,
      msg: "ok",
      data: {
        from: { id: String(from._id), name: from.name, ...fromUsage },
        into: { id: String(into._id), name: into.name, ...intoUsage },
        duplicateNames: [...new Set(dupNames)],
      },
    });
  } catch (e) {
    log(`[ci/school-admin/preview] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * POST /v1/console/ci/schools/:id/merge   body { intoId }
 * 把 :id 这所学校整个并入 intoId，然后删掉 :id。
 * 班级、学校级资源、邀请链接、成员关系全部搬过去；资源内容不动。
 */
router.post("/v1/console/ci/schools/:id/merge", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const fromId = toOid(req.params.id);
    const intoId = toOid(req.body?.intoId);
    if (!fromId || !intoId) return res.status(400).json({ code: 400, msg: "缺少学校 id" });
    if (String(fromId) === String(intoId)) {
      return res.status(400).json({ code: 400, msg: "不能合并到自己" });
    }

    const db = req.db;
    const [from, into] = await Promise.all([
      db.collection(CI_SCHOOLS).findOne({ _id: fromId }),
      db.collection(CI_SCHOOLS).findOne({ _id: intoId }),
    ]);
    if (!from || !into) return res.status(404).json({ code: 404, msg: "学校不存在" });

    const [fromRole, intoRole] = await Promise.all([
      getSchoolRole(db, fromId, userId),
      getSchoolRole(db, intoId, userId),
    ]);
    if (fromRole !== "owner" || intoRole !== "owner") {
      return res.status(403).json({ code: 403, msg: "两个学校都得是你的（创建者）才能合并" });
    }

    if (!checkReauth(req).ok) {
      return rejectReauth(res, "合并学校需要重新验证账户");
    }

    const now = new Date();

    // 1) 班级
    const classMove = await db
      .collection("ci_classes")
      .updateMany({ schoolId: fromId }, { $set: { schoolId: intoId, updatedAt: now } });

    // 2) 学校级资源
    const resourceMoves: Record<string, number> = {};
    for (const col of RESOURCE_COLLECTIONS) {
      const r = await db
        .collection(col)
        .updateMany({ schoolId: fromId }, { $set: { schoolId: intoId, updatedAt: now } });
      resourceMoves[col] = r.modifiedCount;
    }

    // 3) 邀请链接（搬到新学校，仍由原创建者持有）
    const inviteMove = await db
      .collection(CI_SCHOOL_INVITES)
      .updateMany({ schoolId: fromId }, { $set: { schoolId: intoId } });

    // 4) 成员：已经在 into 里的保持原角色，不降级；新来的保留原角色但 owner 降为 admin
    const fromMembers = await db.collection(CI_SCHOOL_MEMBERS).find({ schoolId: fromId }).toArray();
    let memberAdded = 0;
    for (const m of fromMembers) {
      const existing = await db
        .collection(CI_SCHOOL_MEMBERS)
        .findOne({ schoolId: intoId, userId: m.userId });
      if (existing) continue;
      await db.collection(CI_SCHOOL_MEMBERS).insertOne({
        schoolId: intoId,
        userId: m.userId,
        role: m.role === "owner" ? "admin" : m.role,
        joinedAt: m.joinedAt || now,
        mergedFrom: fromId,
      });
      memberAdded++;
    }

    // 5) 归档旧名字，方便以后按旧名再被识别成同一所
    const aliases = [
      ...new Set([...(into.aliases || []), from.name, ...(from.aliases || [])].filter(Boolean)),
    ];
    await db
      .collection(CI_SCHOOLS)
      .updateOne({ _id: intoId }, { $set: { aliases, updatedAt: now } });

    // 6) 删掉旧学校
    await Promise.all([
      db.collection(CI_SCHOOL_INVITES).deleteMany({ schoolId: fromId }),
      db.collection(CI_SCHOOL_MEMBERS).deleteMany({ schoolId: fromId }),
      db.collection(CI_SCHOOLS).deleteOne({ _id: fromId }),
    ]);

    log(
      `[ci/school-admin] 用户 ${userId} 把学校「${from.name}」合并进「${into.name}」：` +
        `班级 ${classMove.modifiedCount}，资源 ${Object.values(resourceMoves).reduce((a, b) => a + b, 0)}，` +
        `邀请 ${inviteMove.modifiedCount}，新成员 ${memberAdded}`,
      "info",
      "auth",
    );

    res.json({
      code: 0,
      msg: "ok",
      data: {
        intoSchoolId: String(intoId),
        intoSchoolName: into.name,
        movedClasses: classMove.modifiedCount,
        movedResources: resourceMoves,
        movedInvites: inviteMove.modifiedCount,
        addedMembers: memberAdded,
        removedSchool: from.name,
      },
    });
  } catch (e) {
    log(`[ci/school-admin/merge] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
