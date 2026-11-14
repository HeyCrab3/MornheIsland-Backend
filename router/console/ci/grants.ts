/**
 * 班级委托（IAM 第一阶段）：把班级的运维权按「能力位 + 有效期 + 人数」交出去。
 *
 * 设计取舍见 util/ci_grant.ts 顶部注释。这里只做 HTTP 层：
 *   · 发出授权必须重新验证身份（checkReauth）—— 委托等于交出权限，是敏感操作
 *   · 接受授权必须登录（不是匿名链接），这样每个被授权人都是一个可追责的账号
 *   · 撤销 = 删成员记录，权限每次现查，所以立即生效
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { authLog } from "../../../util/auth_log";
import { checkReauth, rejectReauth } from "../../../util/reauth";
import {
  CI_GRANTS,
  CAP_LABELS,
  GRANT_CAPS,
  acceptGrant,
  activeGrantsReceived,
  grantUsable,
  isGrantCap,
  leaveGrant,
  listGrantMembers,
  listIssuedGrants,
  memberCounts,
  delegateCodeHash,
  killDelegateSessions,
  newDelegateCode,
  newGrantToken,
  normalizeCaps,
  revokeGrant,
  type GrantCap,
} from "../../../util/ci_grant";

const router = express.Router();

const MAX_CLASSES = 20;
const MAX_HOURS = 24 * 30;
const MAX_USES = 50;

/** 代登录进来的影子账号不能再往下发权（否则一个人就能把权限传出去） */
function isDelegate(req: any): boolean {
  return req.auth?.delegate === true;
}

function rejectDelegate(res: any, msg = "代登录账号不能进行这项操作") {
  return res.status(403).json({ code: 403, msg });
}

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid || !ObjectId.isValid(String(uid))) return null;
  return new ObjectId(String(uid));
}

function oid(v: any): ObjectId | null {
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/** 授权摘要：给前端展示「这些班 + 这些能力 + 到这个时间」 */
async function describe(db: any, grant: any, opts: { withMembers?: boolean } = {}) {
  const classIds: ObjectId[] = (grant.classIds || []).filter((c: any) => c instanceof ObjectId);
  const classes = classIds.length
    ? await db
        .collection("ci_classes")
        .find({ _id: { $in: classIds } })
        .project({ identity: 1, name: 1 })
        .toArray()
    : [];
  const counts = await memberCounts(db, [grant._id]);
  const used = counts.get(String(grant._id)) || 0;
  const caps: GrantCap[] = normalizeCaps(grant.caps);
  const out: any = {
    _id: String(grant._id),
    ownerId: String(grant.ownerId),
    token: grant.token,
    classIds: classIds.map(String),
    classes: classes.map((c: any) => ({ _id: String(c._id), name: c.name, identity: c.identity })),
    caps,
    capLabels: caps.map((c) => CAP_LABELS[c] || c),
    allowSharedEdit: !!grant.allowSharedEdit,
    note: grant.note || "",
    expiresAt: grant.expiresAt,
    maxUses: Number(grant.maxUses || 0),
    usedCount: used,
    revokedAt: grant.revokedAt || null,
    createdAt: grant.createdAt,
    active: grantUsable(grant),
    delegateEnabled: !!grant.delegateCodeHash,
    delegateCodeCreatedAt: grant.delegateCodeAt || null,
  };
  if (opts.withMembers) out.members = await listGrantMembers(db, grant._id);
  return out;
}

/** GET /v1/console/ci/grants/caps — 能力位清单（前端渲染勾选框用） */
router.get("/v1/console/ci/grants/caps", (_req, res) => {
  res.json({
    code: 0,
    msg: "ok",
    data: GRANT_CAPS.map((c) => ({ key: c, label: CAP_LABELS[c] })),
  });
});

/** GET /v1/console/ci/grants — 我发出的授权 */
router.get("/v1/console/ci/grants", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const grants = await listIssuedGrants(req.db, userId);
    const data = [];
    for (const g of grants) data.push(await describe(req.db, g, { withMembers: true }));
    res.json({ code: 0, msg: "ok", data });
  } catch (e) {
    log(`[ci/grants/list] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** GET /v1/console/ci/grants/received — 别人授权给我的（只回当前有效的） */
router.get("/v1/console/ci/grants/received", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const lite = await activeGrantsReceived(req.db, userId);
    if (!lite.length) return res.json({ code: 0, msg: "ok", data: [] });

    const docs = await req.db
      .collection(CI_GRANTS)
      .find({ _id: { $in: lite.map((g) => g._id) } })
      .toArray();
    const owners = await req.db
      .collection("user")
      .find({ _id: { $in: docs.map((d: any) => d.ownerId) } })
      .project({ userName: 1 })
      .toArray();
    const ownerName = new Map(owners.map((u: any) => [String(u._id), u.userName]));

    const data = [];
    for (const d of docs) {
      const item = await describe(req.db, d);
      item.ownerName = ownerName.get(String(d.ownerId)) || null;
      data.push(item);
    }
    res.json({ code: 0, msg: "ok", data });
  } catch (e) {
    log(`[ci/grants/received] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** GET /v1/console/ci/grants/preview?token= — 接受前先看看这是什么 */
router.get("/v1/console/ci/grants/preview", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const token = String(req.query.token || "").trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(token)) {
      return res.status(400).json({ code: 400, msg: "链接格式不正确" });
    }
    const grant = await req.db.collection(CI_GRANTS).findOne({ token });
    if (!grant) return res.status(404).json({ code: 404, msg: "委托不存在或已被删除" });
    if (!grantUsable(grant)) {
      return res.status(410).json({ code: 410, msg: "这份委托已过期或被撤销" });
    }

    const item = await describe(req.db, grant);
    const owner = await req.db
      .collection("user")
      .findOne({ _id: grant.ownerId }, { projection: { userName: 1 } });
    item.ownerName = owner?.userName || null;
    item.isMine = String(grant.ownerId) === String(userId);
    item.accepted = !!(await req.db
      .collection("ci_grant_members")
      .findOne({ grantId: grant._id, userId }));
    res.json({ code: 0, msg: "ok", data: item });
  } catch (e) {
    log(`[ci/grants/preview] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/grants/accept — 接受委托（必须登录） */
router.post("/v1/console/ci/grants/accept", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    if (isDelegate(req)) return rejectDelegate(res, "代登录账号不能再接受其他委托");
    const token = String(req.body?.token || "").trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(token)) {
      return res.status(400).json({ code: 400, msg: "链接格式不正确" });
    }
    const grant = await req.db.collection(CI_GRANTS).findOne({ token });
    if (!grant) return res.status(404).json({ code: 404, msg: "委托不存在或已被删除" });
    if (!grantUsable(grant)) {
      return res.status(410).json({ code: 410, msg: "这份委托已过期或被撤销" });
    }
    if (String(grant.ownerId) === String(userId)) {
      return res.status(400).json({ code: 400, msg: "这是你自己发出的委托，不用接受" });
    }

    const r = await acceptGrant(req.db, grant, userId);
    if (r.full) {
      return res.status(409).json({
        code: 409,
        msg: `这份委托最多只能给 ${r.maxUses} 个人使用，名额已满`,
      });
    }

    await authLog(
      req.db,
      {
        userId: String(userId),
        event: "sensitive",
        detail: `接受了 ${grant.ownerId} 的班级委托${r.already ? "（此前已接受）" : ""}`,
        target: { grantId: String(grant._id), ownerId: String(grant.ownerId) },
      },
      req,
    );

    const item = await describe(req.db, grant);
    res.json({ code: 0, msg: "ok", data: { ...item, already: !!r.already } });
  } catch (e) {
    log(`[ci/grants/accept] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/grants — 发出委托 */
router.post("/v1/console/ci/grants", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    if (isDelegate(req)) return rejectDelegate(res, "代登录账号不能把权限再转给别人");

    const re = await checkReauth(req);
    if (!re.ok) {
      await authLog(
        req.db,
        { userId: String(userId), event: "reauth_fail", detail: "发出班级委托未通过再验证" },
        req,
      );
      return rejectReauth(
        res,
        "发出班级委托等于把操作权交给别人，需要先验证身份",
      );
    }

    const { classIds, caps, expiresInHours, maxUses, note, allowSharedEdit } = req.body || {};
    const ids: ObjectId[] = Array.isArray(classIds)
      ? [...new Set(classIds.map((c: any) => String(c)).filter((s: string) => ObjectId.isValid(s)))]
          .map((s: string) => new ObjectId(s))
      : [];
    if (!ids.length) return res.status(400).json({ code: 400, msg: "至少要选一个班级" });
    if (ids.length > MAX_CLASSES) {
      return res.status(400).json({ code: 400, msg: `一次最多委托 ${MAX_CLASSES} 个班级` });
    }

    // 只能委托自己的班（学校级共享不算「你的」，那是学校的）
    const owned = await req.db
      .collection("ci_classes")
      .countDocuments({ _id: { $in: ids }, userId });
    if (owned !== ids.length) {
      return res.status(403).json({ code: 403, msg: "只能委托你自己创建的班级" });
    }

    if (Array.isArray(caps) && caps.some((c: any) => c && !isGrantCap(c))) {
      return res.status(400).json({ code: 400, msg: "存在无法识别的能力项" });
    }
    const finalCaps = normalizeCaps(caps);

    const hours = Math.min(Math.max(Number(expiresInHours) || 72, 1), MAX_HOURS);
    const uses = Math.min(Math.max(Number(maxUses ?? 1) || 0, 0), MAX_USES);

    const doc: any = {
      _id: new ObjectId(),
      ownerId: userId,
      token: newGrantToken(),
      classIds: ids,
      caps: finalCaps,
      allowSharedEdit: !!allowSharedEdit,
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
      maxUses: uses,
      note: String(note || "").slice(0, 60),
      revokedAt: null,
      createdAt: new Date(),
    };
    await req.db.collection(CI_GRANTS).insertOne(doc);

    await authLog(
      req.db,
      {
        userId: String(userId),
        event: "sensitive",
        detail: `发出班级委托：${ids.length} 个班 / ${finalCaps.join(",")} / ${hours}h / 最多 ${uses || "不限"} 人`,
        target: { grantId: String(doc._id) },
      },
      req,
    );
    log(
      `[grant] ${userId} 发出委托 ${doc._id}（${ids.length} 班，${hours}h，上限 ${uses} 人）`,
      "info",
      "auth",
    );

    res.json({ code: 0, msg: "ok", data: await describe(req.db, doc) });
  } catch (e) {
    log(`[ci/grants/create] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/grants/:id/revoke — 撤销（立即生效） */
router.post("/v1/console/ci/grants/:id/revoke", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const gid = oid(req.params.id);
    if (!gid) return res.status(400).json({ code: 400, msg: "id 非法" });

    const grant = await req.db.collection(CI_GRANTS).findOne({ _id: gid });
    if (!grant) return res.status(404).json({ code: 404, msg: "委托不存在" });
    // 撤销自己发出的；学校 owner/admin 也能替学校收权（委托是个人行为，这里只留本人）
    if (String(grant.ownerId) !== String(userId)) {
      return res.status(403).json({ code: 403, msg: "只有发出委托的人能撤销它" });
    }
    if (grant.revokedAt) return res.json({ code: 0, msg: "ok", data: { already: true } });

    const removed = await revokeGrant(req.db, gid, userId);
    await authLog(
      req.db,
      {
        userId: String(userId),
        event: "sensitive",
        detail: `撤销班级委托（移除 ${removed} 名被授权人）`,
        target: { grantId: String(gid) },
      },
      req,
    );
    res.json({ code: 0, msg: "ok", data: { removed } });
  } catch (e) {
    log(`[ci/grants/revoke] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** DELETE /v1/console/ci/grants/received/:id — 我主动退出某个委托 */
router.delete("/v1/console/ci/grants/received/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const gid = oid(req.params.id);
    if (!gid) return res.status(400).json({ code: 400, msg: "id 非法" });

    const removed = await leaveGrant(req.db, gid, userId);
    if (!removed) return res.status(404).json({ code: 404, msg: "你没有接受这份委托" });
    res.json({ code: 0, msg: "ok" });
  } catch (e) {
    log(`[ci/grants/leave] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/grants/:id/delegate-code — 生成代登录码（给没有账号的人用） */
router.post("/v1/console/ci/grants/:id/delegate-code", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    if (isDelegate(req)) return rejectDelegate(res);

    const gid = oid(req.params.id);
    if (!gid) return res.status(400).json({ code: 400, msg: "id 非法" });
    const grant = await req.db.collection(CI_GRANTS).findOne({ _id: gid });
    if (!grant) return res.status(404).json({ code: 404, msg: "委托不存在" });
    if (String(grant.ownerId) !== String(userId)) {
      return res.status(403).json({ code: 403, msg: "只有发出委托的人能生成代登录码" });
    }
    if (!grantUsable(grant)) {
      return res.status(410).json({ code: 410, msg: "这份委托已过期或被撤销" });
    }

    const re = await checkReauth(req);
    if (!re.ok) return rejectReauth(res, "生成代登录码等于再造一把钥匙，需要先验证身份");

    const code = newDelegateCode();
    await req.db
      .collection(CI_GRANTS)
      .updateOne(
        { _id: gid },
        { $set: { delegateCodeHash: delegateCodeHash(code), delegateCodeAt: new Date() } },
      );

    await authLog(
      req.db,
      {
        userId: String(userId),
        event: "sensitive",
        detail: "生成班级委托的代登录码",
        target: { grantId: String(gid) },
      },
      req,
    );
    log(`[grant] ${userId} 为委托 ${gid} 生成代登录码`, "info", "auth");

    // 明文只在这里返回一次，库里只有哈希
    res.json({ code: 0, msg: "ok", data: { code } });
  } catch (e) {
    log(`[ci/grants/delegate-code] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** DELETE /v1/console/ci/grants/:id/delegate-code — 停用代登录码 */
router.delete("/v1/console/ci/grants/:id/delegate-code", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    if (isDelegate(req)) return rejectDelegate(res);

    const gid = oid(req.params.id);
    if (!gid) return res.status(400).json({ code: 400, msg: "id 非法" });
    const grant = await req.db.collection(CI_GRANTS).findOne({ _id: gid });
    if (!grant) return res.status(404).json({ code: 404, msg: "委托不存在" });
    if (String(grant.ownerId) !== String(userId)) {
      return res.status(403).json({ code: 403, msg: "只有发出委托的人能停用代登录码" });
    }

    await req.db
      .collection(CI_GRANTS)
      .updateOne({ _id: gid }, { $unset: { delegateCodeHash: "", delegateCodeAt: "" } });
    const killed = await killDelegateSessions(req.db, gid);

    await authLog(
      req.db,
      {
        userId: String(userId),
        event: "sensitive",
        detail: `停用代登录码（踢下线 ${killed} 个代登录会话）`,
        target: { grantId: String(gid) },
      },
      req,
    );
    res.json({ code: 0, msg: "ok", data: { killed } });
  } catch (e) {
    log(`[ci/grants/delegate-code-off] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
