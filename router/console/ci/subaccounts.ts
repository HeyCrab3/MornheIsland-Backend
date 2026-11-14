/**
 * 子账户管理（主账号视角）—— 创建、改范围、重置密码、停用、删除。
 *
 * 子账户不是一个新概念，它就是「一条内部委托 + 一个能登录的身份」：
 *   · 班级范围、能力位、有效期全存在 ci_grants 里，权限判定走原来的那一套；
 *   · 停用 = 置 disabled 并把 tokenVersion +1（会话立刻失效）；
 *   · 删除 = 撤销委托 + 踢线 + 删账号，三步一起做，避免留下能登录的孤儿身份。
 *
 * 创建和重置密码会返回一次性明文密码 —— 之后库里只剩 scrypt 哈希，谁也拿不回来。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { authLog } from "../../../util/auth_log";
import { checkReauth, rejectReauth } from "../../../util/reauth";
import { revokeAllTokens } from "../../../util/token_guard";
import { GRANT_CAPS, CAP_LABELS, normalizeCaps } from "../../../util/ci_grant";
import {
  createSubAccount,
  listSubAccounts,
  resetSubPassword,
  updateSubGrant,
  deleteSubAccount,
  isValidLogin,
  parseLogin,
  resolveParent,
  loginTaken,
} from "../../../util/subaccount";

const router = express.Router();

function me(req: any): ObjectId | null {
  const id = req.auth?.userId || req.auth?.user?.userId;
  return id && ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
}

function parseExpiry(raw: any): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 只能把自己的班级分出去 */
async function verifyClassesMine(db: any, userId: ObjectId, raw: any): Promise<{ ok: boolean; ids?: ObjectId[]; msg?: string }> {
  const arr = Array.isArray(raw) ? raw : [];
  if (!arr.length) return { ok: false, msg: "请至少选择一个班级" };
  if (arr.length > 20) return { ok: false, msg: "一次最多委托 20 个班级" };
  const ids = arr.map((v: any) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null)).filter(Boolean) as ObjectId[];
  if (ids.length !== arr.length) return { ok: false, msg: "班级参数不正确" };
  const n = await db.collection("ci_classes").countDocuments({ _id: { $in: ids }, userId });
  if (n !== ids.length) return { ok: false, msg: "只能把你自己名下的班级委托给子账户" };
  return { ok: true, ids };
}

/** 取一个属于我的子账户 */
async function mySub(db: any, userId: ObjectId, id: any) {
  if (!ObjectId.isValid(String(id))) return null;
  return db.collection("user").findOne({
    _id: new ObjectId(String(id)),
    isSubAccount: true,
    parentId: userId,
  });
}

// —— 能力位清单（前端画复选框用） ——
router.get("/v1/console/ci/subaccounts/caps", (_req: any, res: any) => {
  res.json({
    code: 0,
    msg: "ok",
    data: GRANT_CAPS.map((c: any) => ({ id: c, label: (CAP_LABELS as any)[c] })),
  });
});

router.get("/v1/console/ci/subaccounts", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const list = await listSubAccounts(req.db, userId);
    res.json({ code: 0, msg: "ok", data: { list } });
  } catch (e) {
    log(`读取子账户列表失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

router.post("/v1/console/ci/subaccounts", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    if (!checkReauth(req).ok) return rejectReauth(res, "创建子账户前请先验证身份");

    // 登录名是 `子账户名@主账号`，@ 后面只能是调用者自己
    const parsed = parseLogin(req.body?.login);
    const login = parsed.local;
    if (!isValidLogin(login)) return res.json({ code: 400, msg: "子账户名只能是 3-24 位小写字母、数字、下划线或减号" });
    if (parsed.parentKey) {
      const owner = await resolveParent(req.db, parsed.parentKey);
      if (!owner || String(owner._id) !== String(userId)) {
        return res.json({ code: 400, msg: "登录名里 @ 后面应该是你自己的账号名" });
      }
    }
    if (await loginTaken(req.db, new ObjectId(String(userId)), login)) {
      return res.json({ code: 409, msg: "这个子账户名在你名下已经被占用了" });
    }

    const cls = await verifyClassesMine(req.db, userId, req.body?.classIds);
    if (!cls.ok) return res.json({ code: 400, msg: cls.msg });

    const caps = normalizeCaps(req.body?.caps);
    const expiresAt = parseExpiry(req.body?.expiresAt);
    if (!expiresAt) return res.json({ code: 400, msg: "请选择有效期" });
    if (expiresAt.getTime() <= Date.now()) return res.json({ code: 400, msg: "有效期必须晚于现在" });

    const created = await createSubAccount(req.db, {
      parentId: userId,
      name: req.body?.name,
      login,
      password: req.body?.password ? String(req.body.password) : undefined,
      classIds: cls.ids!,
      caps,
      expiresAt,
    });

    await authLog(
      req.db,
      {
        userId,
        userName: req.auth?.userName,
        event: "sensitive",
        success: true,
        detail: `创建子账户 ${created.login}（${req.body?.name}）`,
      },
      req,
    ).catch(() => {});

    res.json({
      code: 0,
      msg: "创建成功",
      data: {
        _id: String(created.id),
        login: created.login,
        // 明文密码只在这里出现一次
        password: created.password,
      },
    });
  } catch (e: any) {
    log(`创建子账户失败：${e}`, "error", "auth");
    res.json({ code: 400, msg: String(e?.message || e) });
  }
});

router.post("/v1/console/ci/subaccounts/:id/password", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    if (!checkReauth(req).ok) return rejectReauth(res, "重置密码前请先验证身份");
    const sub = await mySub(req.db, userId, req.params.id);
    if (!sub) return res.json({ code: 404, msg: "子账户不存在" });

    const password = await resetSubPassword(req.db, sub._id);
    await authLog(
      req.db,
      { userId, userName: req.auth?.userName, event: "sensitive", success: true, detail: `重置子账户 ${sub.subAccountLogin} 的密码` },
      req,
    ).catch(() => {});
    res.json({ code: 0, msg: "已重置", data: { password } });
  } catch (e: any) {
    log(`重置子账户密码失败：${e}`, "error", "auth");
    res.json({ code: 400, msg: String(e?.message || e) });
  }
});

router.patch("/v1/console/ci/subaccounts/:id", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    if (!checkReauth(req).ok) return rejectReauth(res, "修改权限前请先验证身份");
    const sub = await mySub(req.db, userId, req.params.id);
    if (!sub) return res.json({ code: 404, msg: "子账户不存在" });

    const patch: any = {};
    if (req.body?.classIds !== undefined) {
      const cls = await verifyClassesMine(req.db, userId, req.body.classIds);
      if (!cls.ok) return res.json({ code: 400, msg: cls.msg });
      patch.classIds = cls.ids;
    }
    if (req.body?.caps !== undefined) patch.caps = normalizeCaps(req.body.caps);
    if (req.body?.expiresAt !== undefined) {
      const exp = parseExpiry(req.body.expiresAt);
      if (!exp) return res.json({ code: 400, msg: "有效期格式不正确" });
      patch.expiresAt = exp;
    }

    await updateSubGrant(req.db, sub._id, patch);
    await authLog(
      req.db,
      { userId, userName: req.auth?.userName, event: "sensitive", success: true, detail: `修改子账户 ${sub.subAccountLogin} 的权限` },
      req,
    ).catch(() => {});
    res.json({ code: 0, msg: "已更新" });
  } catch (e: any) {
    log(`修改子账户失败：${e}`, "error", "auth");
    res.json({ code: 400, msg: String(e?.message || e) });
  }
});

router.post("/v1/console/ci/subaccounts/:id/disable", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const sub = await mySub(req.db, userId, req.params.id);
    if (!sub) return res.json({ code: 404, msg: "子账户不存在" });
    // 版本号 +1 = 已经登录的会话下一个请求就失效（revokeAllTokens 会同步刷新版本缓存）
    await revokeAllTokens(req.db, String(sub._id));
    await req.db.collection("user").updateOne({ _id: sub._id }, { $set: { disabled: true } });
    await authLog(
      req.db,
      { userId, userName: req.auth?.userName, event: "sensitive", success: true, detail: `停用子账户 ${sub.subAccountLogin}` },
      req,
    ).catch(() => {});
    res.json({ code: 0, msg: "已停用" });
  } catch (e) {
    log(`停用子账户失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

router.post("/v1/console/ci/subaccounts/:id/enable", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const sub = await mySub(req.db, userId, req.params.id);
    if (!sub) return res.json({ code: 404, msg: "子账户不存在" });
    await req.db
      .collection("user")
      .updateOne({ _id: sub._id }, { $set: { disabled: false }, $unset: { loginFailCount: "", loginLockedUntil: "" } });
    await authLog(
      req.db,
      { userId, userName: req.auth?.userName, event: "sensitive", success: true, detail: `启用子账户 ${sub.subAccountLogin}` },
      req,
    ).catch(() => {});
    res.json({ code: 0, msg: "已启用" });
  } catch (e) {
    log(`启用子账户失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

router.delete("/v1/console/ci/subaccounts/:id", async (req: any, res: any) => {
  try {
    const userId = me(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    if (!checkReauth(req).ok) return rejectReauth(res, "删除子账户前请先验证身份");
    const sub = await mySub(req.db, userId, req.params.id);
    if (!sub) return res.json({ code: 404, msg: "子账户不存在" });

    await deleteSubAccount(req.db, sub._id, userId);
    await authLog(
      req.db,
      { userId, userName: req.auth?.userName, event: "sensitive", success: true, detail: `删除子账户 ${sub.subAccountLogin}` },
      req,
    ).catch(() => {});
    res.json({ code: 0, msg: "已删除" });
  } catch (e: any) {
    log(`删除子账户失败：${e}`, "error", "auth");
    res.json({ code: 400, msg: String(e?.message || e) });
  }
});

export default router;
