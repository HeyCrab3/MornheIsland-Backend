/**
 * 通行密钥登录 —— 走 /v1/public（未登录可调，自动进白名单）。
 *
 * 和 /v1/user/security/mfa/login 的关系：
 *   SSO 通过后会拿到一张 5 分钟票据（ticket），第二步有两种走法：
 *     · TOTP / 恢复码 → POST /v1/user/security/mfa/login
 *     · 通行密钥      → POST /v1/public/webauthn/login（本文件）
 *
 * 为什么通行密钥这条路必须放 /v1/public：那一刻用户手上没有令牌，
 * 票据本身就是唯一凭证。防护靠「票据一次性 + 5 分钟 + 错 5 次作废」
 * 与「挑战码一次性 + 验签」，不靠 JWT。
 */
import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { config } from "../../config";
import { log } from "../../util/log";
import { authLog, clientIp } from "../../util/auth_log";
import {
  consumeLoginTicket,
  markMfaFresh,
  noteTicketFailure,
  peekLoginTicket,
} from "../../util/mfa";
import {
  consumeChallenge,
  findCredential,
  issueChallenge,
  listCredentials,
  rpFromReq,
  originAllowed,
  touchCredential,
  verifyAssertion,
} from "../../util/webauthn";

const router = express.Router();

const WINDOW_MS = 10 * 60_000;
const IP_LIMIT = 30;

const ipHits = new Map<string, number[]>();

function hit(key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (ipHits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    ipHits.set(key, arr);
    return false;
  }
  arr.push(now);
  ipHits.set(key, arr);
  return true;
}

/** 第一步：拿票据换断言选项 */
router.post("/v1/public/webauthn/login-options", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!hit(ip, IP_LIMIT)) {
      return res.json({ code: 429, msg: "尝试过于频繁，请稍后再试" });
    }

    const ticketRaw = String(req.body?.ticket || "").trim();
    const ticket = await peekLoginTicket(req.db, ticketRaw);
    if (!ticket) return res.json({ code: 400, msg: "登录票据已失效，请重新登录" });

    const creds = await listCredentials(req.db, ticket.userId);
    if (!creds.length) return res.json({ code: 409, msg: "这个账号没有绑定通行密钥" });

    const { rpId, origin } = rpFromReq(req);
    if (!originAllowed(origin)) return res.json({ code: 400, msg: `来源 ${origin} 不在允许列表（WEBAUTHN_ORIGINS）` });

    // 一把钥匙只对绑定时那个域名有效：localhost 上绑的在线上域名用不了。
    // 全部塞进 allowCredentials 会让浏览器拿到一堆对不上的 id，直接放弃，
    // 表面上就是「点了没反应」。所以先按 rpId 过滤。
    const usable = creds.filter((c: any) => !c.rpId || c.rpId === rpId);
    if (!usable.length) {
      return res.json({
        code: 409,
        msg: `这个账号的通行密钥是绑在 ${[...new Set(creds.map((c: any) => c.rpId).filter(Boolean))].join("、")} 上的，当前域名（${rpId}）用不了，请改用动态码`,
      });
    }

    const challenge = issueChallenge(ticket.userId, "login", rpId);
    res.json({
      code: 0,
      msg: "ok",
      data: {
        challenge,
        timeout: 60000,
        rpId,
        allowCredentials: usable.map((c: any) => ({
          type: "public-key",
          id: c.credentialId,
          transports: c.transports || ["internal", "hybrid", "usb", "nfc", "ble"],
        })),
        userVerification: "preferred",
      },
    });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 第二步：验签 → 换真令牌 */
router.post("/v1/public/webauthn/login", async (req, res) => {
  try {
    const db = req.db;
    const ip = clientIp(req);
    if (!hit(ip, IP_LIMIT)) {
      return res.json({ code: 429, msg: "尝试过于频繁，请稍后再试" });
    }

    const ticketRaw = String(req.body?.ticket || "").trim();
    const ticket = await peekLoginTicket(req.db, ticketRaw);
    if (!ticket) return res.json({ code: 400, msg: "登录票据已失效，请重新登录" });

    const user = await db.collection("user").findOne({ _id: new ObjectId(ticket.userId) });
    if (!user) {
      await consumeLoginTicket(req.db, ticketRaw);
      return res.json({ code: 400, msg: "账号不存在" });
    }

    const body = req.body || {};
    const challenge = String(body.challenge || "");
    const rec = consumeChallenge(challenge, "login", ticket.userId);
    if (!rec) return res.json({ code: 400, msg: "验证请求已过期，请重试" });

    const cred = body.credential || {};
    const stored = await findCredential(db, ticket.userId, String(cred.id || ""));
    if (!stored) return res.json({ code: 400, msg: "这把通行密钥不属于这个账号" });

    const { rpId, origin } = rpFromReq(req);
    if (!originAllowed(origin)) return res.json({ code: 400, msg: `来源 ${origin} 不在允许列表（WEBAUTHN_ORIGINS）` });
    try {
      const r = verifyAssertion({
        rpId: (stored as any).rpId || rpId,
        origin,
        expectedChallenge: challenge,
        authenticatorData: cred?.response?.authenticatorData,
        clientDataJSON: cred?.response?.clientDataJSON,
        signature: cred?.response?.signature,
        credential: stored as any,
      });
      await touchCredential(db, stored.credentialId, r.newCounter);
    } catch (e: any) {
      const left = await noteTicketFailure(db, ticketRaw);
      await authLog(
        db,
        {
          userId: user._id,
          userName: user.userName,
          event: "mfa_fail",
          success: false,
          detail: `通行密钥登录失败：${e?.message || e}`,
        },
        req,
      );
      if (left <= 0) {
        return res.json({ code: 400, msg: "验证失败次数过多，请重新登录" });
      }
      return res.json({ code: 400, msg: `${e?.message || "验证失败"}（还可重试 ${left} 次）` });
    }

    const tv = Number(user.tokenVersion ?? 0) || 0;
    // 子账户走的是同一条通行密钥登录链路，令牌里必须带上 subAccount 声明，
    // 否则「子账户不能自己注销自己」这类按声明拦截的规则会漏掉。
    const claims: any = {
      userId: user._id,
      userName: user.userName,
      admin: !!user.admin,
      tv,
    };
    if (user.isSubAccount === true) {
      claims.subAccount = true;
      if (user.parentId) claims.parentId = user.parentId;
    }
    const token = jwt.sign(claims, config.jwt.secret, { expiresIn: "30d" });
    await consumeLoginTicket(db, ticketRaw);
    markMfaFresh(String(user._id));
    await db
      .collection("user")
      .updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    await authLog(
      db,
      {
        userId: user._id,
        userName: user.userName,
        event: "login",
        success: true,
        detail: "SSO + 通行密钥",
      },
      req,
    );
    log(`${user.userName} 通过通行密钥登录`, "info", "auth");
    res.json({ code: 0, msg: "登陆成功", data: token });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

export default router;
