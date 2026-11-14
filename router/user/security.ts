import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { config } from "../../config.ts";
import { log } from "../../util/log.ts";
import { authLog, listAuthLogs } from "../../util/auth_log.ts";
import { myCapabilities } from "../../util/subaccount.ts";
import { CAP_LABELS } from "../../util/ci_grant.ts";
import { revokeAllTokens } from "../../util/token_guard.ts";
import {
  otpauthUri,
  randomSecret,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  TOTP_DIGITS,
} from "../../util/totp.ts";
import {
  consumeLoginTicket,
  consumeMfaCode,
  dropMfaFresh,
  markMfaFresh,
  noteTicketFailure,
  openSecret,
  peekLoginTicket,
  sealSecret,
  MFA_FRESH_MS,
} from "../../util/mfa.ts";
import { checkReauth } from "../../util/reauth.ts";
import {
  MAX_CREDENTIALS_PER_USER,
  b64u,
  consumeChallenge,
  countCredentials,
  deleteCredential,
  findCredential,
  findCredentialById,
  issueChallenge,
  listCredentials,
  rpFromReq,
  originAllowed,
  saveCredential,
  touchCredential,
  verifyAssertion,
  verifyRegistration,
} from "../../util/webauthn.ts";


const router = express.Router();

function authOf(req: any) {
  return req?.auth || {};
}

function myId(req: any): string {
  return String(authOf(req).userId || "");
}

/**
 * 吊销已签发的令牌（AK 销毁 / 下线所有设备）。
 * body.keepCurrent = false 时连本机一起踢掉；默认保留本机（会返回新令牌）。
 */
router.post("/v1/user/security/revoke-all", async (req, res) => {
  try {
    const db = req.db;
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });

    const keepCurrent = req.body?.keepCurrent !== false;
    const tv = await revokeAllTokens(db, userId);
    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });

    await authLog(
      db,
      {
        userId,
        userName: user?.userName,
        event: "token_revoke",
        success: true,
        detail: keepCurrent ? "吊销其他设备的登录凭证" : "吊销全部登录凭证",
      },
      req,
    );
    log(`${user?.userName || userId} 吊销了登录凭证（tv=${tv}）`, "warn", "auth");

    let token = "";
    if (keepCurrent && user) {
      token = jwt.sign(
        {
          userId: user._id,
          userName: user.userName,
          admin: !!user.admin,
          tv,
        },
        config.jwt.secret,
        { expiresIn: "30d" },
      );
    }

    res.json({
      code: 0,
      msg: keepCurrent ? "已下线其他设备" : "已下线全部设备，请重新登录",
      data: token ? { token, tokenVersion: tv } : { tokenVersion: tv },
    });
  } catch (e) {
    log(`吊销令牌失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 我的登录与安全操作记录 */
router.get("/v1/user/security/logs", async (req, res) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "50")) || 50, 1), 200);
    const event = typeof req.query.event === "string" && req.query.event ? req.query.event : undefined;
    const data = await listAuthLogs(req.db, userId, limit, event);
    res.json({ code: 0, msg: "ok", data });
  } catch (e) {
    log(`读取认证日志失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 安全概览：最近一次登录、新 IP 登录次数、是否已设置二步验证 */
router.get("/v1/user/security/overview", async (req, res) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });

    const col = req.db.collection("auth_logs");
    const [lastLogin, recent, newIpCount, user, passkeyCount] = await Promise.all([
      col.findOne({ userId, event: "login", success: true }, { sort: { at: -1 } }),
      col.countDocuments({ userId, at: { $gte: new Date(Date.now() - 7 * 86400_000) } }),
      col.countDocuments({ userId, newIp: true, at: { $gte: new Date(Date.now() - 90 * 86400_000) } }),
      req.db.collection("user").findOne(
        { _id: new ObjectId(userId) },
        { projection: { tokenVersion: 1, mfaEnabled: 1, mfaEnabledAt: 1 } },
      ),
      countCredentials(req.db, userId),
    ]);

    res.json({
      code: 0,
      msg: "ok",
      data: {
        lastLogin: lastLogin
          ? { at: lastLogin.at, ip: lastLogin.ip, ua: lastLogin.ua, newIp: !!lastLogin.newIp }
          : null,
        eventCount7d: recent,
        newIpCount90d: newIpCount,
        tokenVersion: Number(user?.tokenVersion ?? 0) || 0,
        // 「二步验证已开启」= 动态码或通行密钥任一可用，而不是只看动态码。
        // 只绑了通行密钥的用户同样是受保护的，前端不该显示「未开启」。
        mfaEnabled: !!user?.mfaEnabled || passkeyCount > 0,
        totpEnabled: !!user?.mfaEnabled,
        mfaEnabledAt: user?.mfaEnabledAt || null,
        passkeyCount,
        methods: { totp: !!user?.mfaEnabled, passkey: passkeyCount > 0 },
      },
    });
  } catch (e) {
    log(`读取安全概览失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});


/**
 * 我的能力位 —— 前端据此决定显示哪些功能。
 *
 * kind:
 *   owner      主账号，没有收到任何委托 → 全权（前端不过滤）
 *   grantee    主账号，但收到了别人的委托 → 自己的东西全权 + 委托范围
 *   subaccount 子账户 / delegate 影子账号 → 只有委托给它的能力
 *
 * 注意：这里返回的是「能做什么」，不是「能看到什么」。
 * 可见范围（能看到哪些班/哪些资源）由各接口自己的 scopeOf 决定，
 * 前端不能只靠这个字段当权限校验 —— 它只用来隐藏没意义的入口。
 */
router.get("/v1/user/capabilities", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const r = await myCapabilities(req.db, userId);
    const isOwner = r.kind === "owner";
    res.json({
      code: 0,
      msg: "ok",
      data: {
        kind: r.kind,
        isOwner,
        // owner 不枚举能力，前端遇 isOwner 直接放行全部
        caps: r.caps,
        capsWithLabel: r.caps.map((c: any) => ({ id: c, label: (CAP_LABELS as any)[c] || c })),
      },
    });
  } catch (e) {
    log(`读取能力位失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 开始绑定二步验证：生成密钥与恢复码（恢复码只在此刻明文返回一次） */
router.post("/v1/user/security/mfa/setup", async (req, res) => {
  try {
    const db = req.db;
    const userId = myId(req);
    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.json({ code: 401, msg: "请先登录" });
    if (user.mfaEnabled) {
      return res.json({ code: 409, msg: "已开启二步验证，请先关闭后再重新绑定" });
    }

    const secret = randomSecret();
    const codes = generateRecoveryCodes(10);
    await db.collection("user").updateOne(
      { _id: user._id },
      {
        $set: {
          mfaPendingSecret: sealSecret(secret),
          mfaPendingAt: new Date(),
          mfaPendingRecoveryCodes: codes.map(hashRecoveryCode),
        },
      },
    );

    res.json({
      code: 0,
      msg: "ok",
      data: {
        secret,
        otpauth: otpauthUri(secret, user.userName),
        digits: TOTP_DIGITS,
        recoveryCodes: codes,
        note: "请把恢复码抄下来离线保存，这是丢失手机后唯一的退路",
      },
    });
  } catch (e) {
    log(`开始绑定 2FA 失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 确认绑定：验证一次动态码才算开启 */
router.post("/v1/user/security/mfa/enable", async (req, res) => {
  try {
    const db = req.db;
    const userId = myId(req);
    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.json({ code: 401, msg: "请先登录" });
    if (user.mfaEnabled) return res.json({ code: 409, msg: "已开启二步验证" });

    const pending = openSecret(user.mfaPendingSecret || "");
    if (!pending) return res.json({ code: 409, msg: "请先开始绑定" });

    const r = verifyTotp(pending, req.body?.code, {});
    if (!r.ok) {
      await authLog(db, { userId, userName: user.userName, event: "mfa_fail", success: false, detail: `绑定失败：${r.reason}` }, req);
      return res.json({ code: 400, msg: r.reason || "验证码不正确" });
    }

    await db.collection("user").updateOne(
      { _id: user._id },
      {
        $set: {
          mfaEnabled: true,
          mfaEnabledAt: new Date(),
          mfaSecret: user.mfaPendingSecret,
          mfaLastStep: r.step,
          mfaRecoveryCodes: user.mfaPendingRecoveryCodes || [],
        },
        $unset: { mfaPendingSecret: "", mfaPendingAt: "", mfaPendingRecoveryCodes: "" },
      },
    );
    markMfaFresh(userId);
    await authLog(db, { userId, userName: user.userName, event: "mfa_enable", success: true }, req);
    log(`${user.userName} 开启了二步验证`, "warn", "auth");

    res.json({ code: 0, msg: "已开启二步验证" });
  } catch (e) {
    log(`开启 2FA 失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 关闭动态码（需要当前动态码或一枚恢复码）。通行密钥不受影响。 */
router.post("/v1/user/security/mfa/disable", async (req, res) => {
  try {
    const db = req.db;
    const userId = myId(req);
    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.json({ code: 401, msg: "请先登录" });
    if (!user.mfaEnabled) return res.json({ code: 409, msg: "尚未开启动态码" });

    const r = await consumeMfaCode(db, user, req.body?.code);
    if (!r.ok) {
      await authLog(db, { userId, userName: user.userName, event: "mfa_fail", success: false, detail: `关闭失败：${r.reason}` }, req);
      return res.json({ code: 400, msg: r.reason || "验证码不正确" });
    }

    const passkeyCount = await countCredentials(db, String(user._id));
    await db.collection("user").updateOne(
      { _id: user._id },
      {
        $set: { mfaEnabled: false },
        // 还有通行密钥时保留恢复码：两步验证并没有被关掉，恢复码仍然是兜底
        ...(passkeyCount > 0
          ? { $unset: { mfaSecret: "", mfaLastStep: "", mfaPendingSecret: "", mfaPendingAt: "", mfaPendingRecoveryCodes: "" } }
          : { $unset: { mfaSecret: "", mfaLastStep: "", mfaRecoveryCodes: "", mfaPendingSecret: "", mfaPendingAt: "", mfaPendingRecoveryCodes: "" } }),
      },
    );
    dropMfaFresh(userId);
    await authLog(db, { userId, userName: user.userName, event: "mfa_disable", success: true, detail: passkeyCount > 0 ? "关闭动态码（通行密钥仍在）" : "关闭动态码" }, req);
    log(`${user.userName} 关闭了动态码${passkeyCount > 0 ? "（通行密钥仍在）" : ""}`, "warn", "auth");

    res.json({
      code: 0,
      msg: passkeyCount > 0 ? "已关闭动态码，两步验证仍由通行密钥保护" : "已关闭两步验证",
      data: { mfaEnabled: passkeyCount > 0, totpEnabled: false, passkeyCount, methods: { totp: false, passkey: passkeyCount > 0 } },
    });
  } catch (e) {
    log(`关闭 2FA 失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 敏感操作前的复核：验证一次动态码，5 分钟内同一账号的敏感操作免重复验证 */
router.post("/v1/user/security/mfa/verify", async (req, res) => {
  try {
    const db = req.db;
    const userId = myId(req);
    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.json({ code: 401, msg: "请先登录" });
    if (!user.mfaEnabled) return res.json({ code: 409, msg: "尚未开启动态码，请改用通行密钥验证" });

    const r = await consumeMfaCode(db, user, req.body?.code);
    if (!r.ok) {
      await authLog(db, { userId, userName: user.userName, event: "mfa_fail", success: false, detail: `复核失败：${r.reason}` }, req);
      return res.json({ code: 400, msg: r.reason || "验证码不正确" });
    }

    markMfaFresh(userId);
    await authLog(db, { userId, userName: user.userName, event: "reauth", success: true, detail: `二次校验通过（${r.via}）` }, req);
    res.json({ code: 0, msg: "验证通过", data: { freshForMs: MFA_FRESH_MS, via: r.via } });
  } catch (e) {
    log(`二次校验失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 登录第二步：用短票据 + 动态码换真令牌 */
router.post("/v1/user/security/mfa/login", async (req, res) => {
  try {
    const db = req.db;
    // 这里用 peek：验证码输错不该把票据烧掉，否则手抖一位就要重新走一遍 SSO
    const ticket = await peekLoginTicket(db, req.body?.ticket);
    if (!ticket) return res.json({ code: 400, msg: "登录票据已失效，请重新登录" });

    const user = await db.collection("user").findOne({ _id: new ObjectId(ticket.userId) });
    if (!user) {
      await consumeLoginTicket(db, req.body?.ticket);
      return res.json({ code: 400, msg: "账号不存在" });
    }

    if (user.mfaEnabled) {
      const r = await consumeMfaCode(db, user, req.body?.code);
      if (!r.ok) {
        const left = await noteTicketFailure(db, String(req.body?.ticket || ""));
        await authLog(
          db,
          { userId: ticket.userId, userName: ticket.userName, event: "mfa_fail", success: false, detail: `登录第二步：${r.reason}` },
          req,
        );
        if (left <= 0) {
          return res.json({ code: 400, msg: "验证失败次数过多，请重新登录" });
        }
        return res.json({ code: 400, msg: `${r.reason || "验证码不正确"}（还可重试 ${left} 次）` });
      }
      markMfaFresh(ticket.userId);
    }

    await consumeLoginTicket(db, req.body?.ticket);

    const tv = Number(user.tokenVersion ?? 0) || 0;
    const token = jwt.sign(
      { userId: user._id, userName: user.userName, admin: !!user.admin, tv },
      config.jwt.secret,
      { expiresIn: "30d" },
    );
    await authLog(
      db,
      { userId: user._id, userName: user.userName, event: "login", success: true, detail: user.mfaEnabled ? "SSO + 二步验证" : "SSO" },
      req,
    );
    res.json({ code: 0, msg: "登陆成功", data: token });
  } catch (e) {
    log(`登录第二步失败：${e}`, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

export default router;

/* ------------------------------------------------------------------ *
 * 通行密钥（Passkey）
 *
 * 和 TOTP 是并列的第二因素，不是替代品：绑了钥匙的人登录时可以直接用钥匙，
 * 不想每次摸手机抄码；没绑的人照旧用动态码。
 *
 * 有一处必须留退路：只绑了通行密钥、没开 TOTP 的账号，一旦设备丢了就再也进不去。
 * 所以第一次绑钥匙时如果库里没有恢复码，就顺手生成一份（明文只返回这一次）。
 * ------------------------------------------------------------------ */

router.get("/v1/user/security/webauthn", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const list = await listCredentials(req.db, userId);
    res.json({
      code: 0,
      msg: "ok",
      data: list.map((c: any) => ({
        _id: String(c._id),
        name: c.name,
        alg: c.alg,
        counter: c.counter,
        rpId: c.rpId,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt || null,
      })),
    });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 注册第一步：发创建选项（挑战码 + 已有钥匙列表，避免同一把钥匙重复绑） */
router.post("/v1/user/security/webauthn/options", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const user = await req.db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.json({ code: 401, msg: "请先登录" });

    const existing = await listCredentials(req.db, userId);
    if (existing.length >= MAX_CREDENTIALS_PER_USER) {
      return res.json({ code: 409, msg: `最多绑定 ${MAX_CREDENTIALS_PER_USER} 个通行密钥` });
    }

    const { rpId, origin } = rpFromReq(req);
    if (!originAllowed(origin)) return res.json({ code: 400, msg: `来源 ${origin} 不在允许列表（WEBAUTHN_ORIGINS）` });
    const challenge = issueChallenge(userId, "register", rpId);
    const who = String(user.userName || userId);
    res.json({
      code: 0,
      msg: "ok",
      data: {
        challenge,
        rp: { id: rpId, name: "MornheIsland" },
        user: { id: b64u(Buffer.from(userId, "utf8")), name: who, displayName: who },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: 60000,
        attestation: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        excludeCredentials: existing.map((c: any) => ({ type: "public-key", id: c.credentialId })),
      },
    });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 注册第二步：校验并落库 */
router.post("/v1/user/security/webauthn/register", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });

    const body = req.body || {};
    const cred = body.credential || {};
    const challenge = String(body.challenge || "");
    const rec = consumeChallenge(challenge, "register", userId);
    if (!rec) return res.json({ code: 400, msg: "注册请求已过期，请重新开始" });

    const { rpId, origin } = rpFromReq(req);
    let saved: any;
    if (!originAllowed(origin)) {
      return res.json({ code: 400, msg: `来源 ${origin} 不在允许列表（WEBAUTHN_ORIGINS）` });
    }
    try {
      saved = verifyRegistration({
        rpId,
        origin,
        expectedChallenge: challenge,
        attestationObject: cred?.response?.attestationObject,
        clientDataJSON: cred?.response?.clientDataJSON,
      });
    } catch (e: any) {
      return res.json({ code: 400, msg: `绑定失败：${e?.message || e}` });
    }

    const dup = await findCredentialById(req.db, saved.credentialId);
    if (dup) return res.json({ code: 409, msg: "这个通行密钥已经绑定过了" });

    const count = await countCredentials(req.db, userId);
    if (count >= MAX_CREDENTIALS_PER_USER) {
      return res.json({ code: 409, msg: `最多绑定 ${MAX_CREDENTIALS_PER_USER} 个通行密钥` });
    }

    const name = String(body.name || "通行密钥").trim().slice(0, 30) || "通行密钥";
    await saveCredential(req.db, userId, saved, name);
    markMfaFresh(userId);

    // 没有恢复码就先发一份：只绑钥匙、没开 TOTP 的账号丢了设备就没有别的路了
    let recoveryCodes: string[] | undefined;
    const user = await req.db.collection("user").findOne({ _id: new ObjectId(userId) });
    if (user && (!Array.isArray(user.mfaRecoveryCodes) || user.mfaRecoveryCodes.length === 0)) {
      recoveryCodes = generateRecoveryCodes(10);
      await req.db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(userId) },
          { $set: { mfaRecoveryCodes: recoveryCodes.map((c) => hashRecoveryCode(c)) } },
        );
    }

    await authLog(
      req.db,
      {
        userId,
        userName: user?.userName || "",
        event: "mfa_enable",
        success: true,
        detail: `绑定通行密钥「${name}」`,
      },
      req,
    );

    res.json({ code: 0, msg: "已绑定通行密钥", data: { recoveryCodes: recoveryCodes || null } });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 删除一把钥匙（需要二次验证，否则被偷走令牌的人可以先把你的钥匙删光） */
router.delete("/v1/user/security/webauthn/:id", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const gate = checkReauth(req);
    if (!gate.ok) return res.json({ code: 403, msg: "请先完成二次验证", needReauth: true });

    const db = req.db;
    const credId = String(req.params.id || "");
    const oid = ObjectId.isValid(credId) ? new ObjectId(credId) : null;
    if (!oid) return res.json({ code: 404, msg: "没有这个通行密钥" });
    // 只能动自己的钥匙：_id 对了但 userId 不是我也不行
    const target = await db
      .collection("webauthn_credentials")
      .findOne({ _id: oid, userId: String(userId) });
    if (!target) return res.json({ code: 404, msg: "没有这个通行密钥" });

    const user = await db.collection("user").findOne({ _id: new ObjectId(userId) });
    const total = await countCredentials(db, userId);
    const totpEnabled = !!user?.mfaEnabled;
    const isLast = total <= 1;

    // 删掉最后一种验证方式 = 关掉两步验证。这必须由用户明确确认，
    // 不能靠「点了个删除」就顺带把账号的保护拿掉。
    if (isLast && !totpEnabled && req.body?.confirmDisableMfa !== true) {
      return res.json({
        code: 409,
        msg: "这是你最后一种两步验证方式，删除后两步验证会被关闭，之后只凭一枚令牌就能登录。",
        data: { lastMfaMethod: true, mfaEnabledAfter: false, needConfirm: true },
      });
    }

    const ok = await deleteCredential(db, userId, credId);
    if (!ok) return res.json({ code: 404, msg: "没有这个通行密钥" });

    const left = Math.max(total - 1, 0);
    const mfaEnabledAfter = totpEnabled || left > 0;

    // 两步验证真的被关掉了：清掉恢复码，否则会留下「已关闭但仍有一串恢复码」的怪状态
    if (!mfaEnabledAfter) {
      await db.collection("user").updateOne({ _id: new ObjectId(userId) }, { $unset: { mfaRecoveryCodes: "" } });
    }

    await authLog(req.db, {
      userId,
      event: "mfa_disable",
      success: true,
      detail: mfaEnabledAfter ? "删除通行密钥（仅剩的这一把）" : "删除通行密钥（两步验证已关闭）",
    }, req);
    if (!mfaEnabledAfter) log(`${user?.userName || userId} 删光了验证方式，两步验证已关闭`, "warn", "auth");

    res.json({
      code: 0,
      msg: mfaEnabledAfter ? "已删除，两步验证仍由其他方式保护" : "已删除，两步验证已关闭",
      data: { mfaEnabled: mfaEnabledAfter, totpEnabled, passkeyCount: left, methods: { totp: totpEnabled, passkey: left > 0 } },
    });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});

/** 敏感操作复核的第一步：发断言选项（只列自己的钥匙） */
router.post("/v1/user/security/webauthn/auth-options", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });
    const list = await listCredentials(req.db, userId);
    if (!list.length) return res.json({ code: 409, msg: "还没有绑定通行密钥" });

    const { rpId, origin } = rpFromReq(req);
    if (!originAllowed(origin)) return res.json({ code: 400, msg: `来源 ${origin} 不在允许列表（WEBAUTHN_ORIGINS）` });
    const challenge = issueChallenge(userId, "login", rpId);
    res.json({
      code: 0,
      msg: "ok",
      data: {
        challenge,
        timeout: 60000,
        rpId,
        allowCredentials: list.map((c: any) => ({
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

/** 敏感操作复核的第二步：验断言，通过后 5 分钟内算「刚验证过」 */
router.post("/v1/user/security/webauthn/verify", async (req: any, res: any) => {
  try {
    const userId = myId(req);
    if (!userId) return res.json({ code: 401, msg: "请先登录" });

    const body = req.body || {};
    const challenge = String(body.challenge || "");
    const rec = consumeChallenge(challenge, "login", userId);
    if (!rec) return res.json({ code: 400, msg: "验证请求已过期，请重试" });

    const cred = body.credential || {};
    const credentialId = String(cred.id || "");
    const stored = await findCredential(req.db, userId, credentialId);
    if (!stored) return res.json({ code: 404, msg: "这把通行密钥不属于当前账号" });

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
      await touchCredential(req.db, stored.credentialId, r.newCounter);
    } catch (e: any) {
      await authLog(
        req.db,
        {
          userId,
          userName: String(authOf(req).userName || ""),
          event: "mfa_fail",
          success: false,
          detail: `通行密钥验证失败：${e?.message || e}`,
        },
        req,
      );
      // 用 400 而不是 401：前端的统一拦截器见到 code:401 会直接清令牌跳登录页，
      // 而「指纹没按上」显然不该把人踢出去
      return res.json({ code: 400, msg: `验证失败：${e?.message || e}` });
    }

    markMfaFresh(userId);
    await authLog(
      req.db,
      {
        userId,
        userName: String(authOf(req).userName || ""),
        event: "mfa_enable",
        success: true,
        detail: "通行密钥复核",
      },
      req,
    );
    res.json({ code: 0, msg: "验证通过", data: { freshForMs: MFA_FRESH_MS, via: "passkey" } });
  } catch (e: any) {
    log(e, "error", "auth");
    res.json({ code: 500, msg: "服务器内部错误" });
  }
});
