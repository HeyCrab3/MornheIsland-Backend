/**
 * 子账户密码登录 —— 走 /v1/public（未登录可调，自动进白名单）。
 *
 * 和代登录码的区别：
 *   代登录码   无需账号，8 位码换影子身份，适合临时的人；
 *   子账户     登录名 + 密码 + 可选独立 MFA，适合长期共事的老师。
 *
 * 安全模型：
 *   1. 密码 scrypt（N=16384），库里只有哈希，且库被拖走也难爆破；
 *   2. 登录名全局唯一，连续错 5 次锁 15 分钟，另有 IP 与登录名双限流；
 *   3. 开了 2FA 的账号拿到的是 5 分钟票据而不是令牌，验证码对了才换真令牌；
 *   4. 权限完全来自主账号建的那条内部委托 —— 停用/过期/删除立即生效。
 */
import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { config } from "../../config";
import { log } from "../../util/log";
import { authLog, clientIp } from "../../util/auth_log";
import {
  consumeLoginTicket,
  issueLoginTicket,
  markMfaFresh,
  noteTicketFailure,
  peekLoginTicket,
  consumeMfaCode,
} from "../../util/mfa";
import {
  findSubAccountByLogin,
  isLocked,
  noteLoginFailure,
  clearLoginFailure,
  subAccountUsable,
  normalizeLogin,
  verifyPassword,
} from "../../util/subaccount";
import { countCredentials } from "../../util/webauthn";

const router = express.Router();

const WINDOW_MS = 10 * 60_000;
const IP_LIMIT = 20;
const LOGIN_LIMIT = 10;

const ipHits = new Map<string, number[]>();
const loginHits = new Map<string, number[]>();

function hit(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    map.set(key, arr);
    return false;
  }
  arr.push(now);
  map.set(key, arr);
  return true;
}

function signToken(user: any) {
  const tv = Number(user.tokenVersion ?? 0) || 0;
  return jwt.sign(
    {
      userId: user._id,
      userName: user.userName,
      admin: false,
      tv,
      subAccount: true,
      parentId: user.parentId ? String(user.parentId) : null,
    },
    config.jwt.secret,
    { expiresIn: "30d" },
  );
}

router.post("/v1/public/subaccount/login", async (req, res) => {
  try {
    const db = req.db;
    const ip = clientIp(req);
    if (!hit(ipHits, ip, IP_LIMIT)) {
      return res.json({ code: 429, msg: "尝试过于频繁，请稍后再试" });
    }

    // —— 第二步：带票据 + 动态码换令牌 ——
    const ticketRaw = String(req.body?.ticket || "").trim();
    if (ticketRaw) {
      const ticket = await peekLoginTicket(db, ticketRaw);
      if (!ticket) return res.json({ code: 400, msg: "登录票据已失效，请重新输入密码" });

      const user = await db.collection("user").findOne({ _id: new ObjectId(ticket.userId) });
      if (!user) {
        await consumeLoginTicket(db, ticketRaw);
        return res.json({ code: 400, msg: "账号不存在" });
      }
      const usable = subAccountUsable(user);
      if (!usable.ok) {
        await consumeLoginTicket(db, ticketRaw);
        return res.json({ code: 403, msg: usable.reason });
      }

      const r = await consumeMfaCode(db, user, req.body?.code);
      if (!r.ok) {
        const left = await noteTicketFailure(db, ticketRaw);
        await authLog(
          db,
          { userId: user._id, userName: user.userName, event: "mfa_fail", success: false, detail: `子账户登录第二步：${r.reason}` },
          req,
        );
        if (left <= 0) return res.json({ code: 400, msg: "验证失败次数过多，请重新输入密码" });
        return res.json({ code: 400, msg: `${r.reason || "验证码不正确"}（还可重试 ${left} 次）` });
      }

      markMfaFresh(String(user._id));
      await consumeLoginTicket(db, ticketRaw);
      const token = signToken(user);
      await authLog(
        db,
        { userId: user._id, userName: user.userName, event: "login", success: true, detail: "子账户 + 二步验证" },
        req,
      );
      return res.json({ code: 0, msg: "ok", data: { token, user } });
    }

    // —— 第一步：登录名 + 密码 ——
    const login = normalizeLogin(req.body?.login);
    const password = String(req.body?.password || "");
    if (!login || !password) return res.json({ code: 400, msg: "请填写登录名和密码" });
    if (!hit(loginHits, login, LOGIN_LIMIT)) {
      return res.json({ code: 429, msg: "这个登录名尝试过于频繁，请稍后再试" });
    }

    const user = await findSubAccountByLogin(db, login);
    // 不区分「登录名不存在」和「密码错误」，避免被用来枚举登录名
    if (!user) {
      await authLog(db, { userId: null, userName: login, event: "login_fail", success: false, detail: "子账户登录：登录名不存在" }, req);
      return res.json({ code: 400, msg: "登录名或密码不正确" });
    }

    const usable = subAccountUsable(user);
    if (!usable.ok) return res.json({ code: 403, msg: usable.reason });

    const lock = isLocked(user);
    if (lock.locked) {
      const min = Math.ceil(lock.leftMs / 60000);
      return res.json({ code: 429, msg: `密码错误次数过多，请 ${min} 分钟后再试` });
    }

    if (!verifyPassword(password, user.passwordHash)) {
      const r = await noteLoginFailure(db, user._id);
      await authLog(
        db,
        { userId: user._id, userName: user.userName, event: "login_fail", success: false, detail: "子账户登录：密码不正确" },
        req,
      );
      if (r.locked) return res.json({ code: 429, msg: "密码错误次数过多，已锁定 15 分钟" });
      return res.json({ code: 400, msg: `登录名或密码不正确（还可尝试 ${r.left} 次）` });
    }

    await clearLoginFailure(db, user._id);

    const passkeyCount = await countCredentials(db, String(user._id));
    if (user.mfaEnabled || passkeyCount > 0) {
      const ticket = await issueLoginTicket(db, {
        userId: String(user._id),
        userName: user.userName,
        admin: false,
      });
      return res.json({
        code: 0,
        msg: "需要二步验证",
        needMfa: true,
        data: {
          ticket,
          methods: { totp: !!user.mfaEnabled, passkey: passkeyCount > 0 },
        },
      });
    }

    const token = signToken(user);
    await authLog(
      db,
      { userId: user._id, userName: user.userName, event: "login", success: true, detail: "子账户 + 密码" },
      req,
    );
    res.json({ code: 0, msg: "ok", data: { token, user } });
  } catch (e) {
    log(`子账户登录失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

export default router;
