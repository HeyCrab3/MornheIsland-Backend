import crypto from "node:crypto";
import { config } from "../config.ts";
import { verifyTotp, hashRecoveryCode } from "./totp";

/**
 * 二步验证（TOTP）的服务端状态。
 *
 * 三件事：
 *  1. 登录取票：SSO 通过后如果该账号开了 2FA，先发一张 5 分钟的票，验证码对了才换真令牌。
 *  2. 敏感操作复核：验证过一次之后 5 分钟内算「刚刚验证过」，用于删除/清空这类操作。
 *  3. 密钥的静态加密：TOTP 密钥是这套系统里唯一的独立秘密，明文落库等于白给，用 AES-256-GCM 封一下。
 */

export const MFA_TICKET_MS = 5 * 60 * 1000;
export const MFA_FRESH_MS = 5 * 60 * 1000;

/** 登录票据落库的集合名。票据必须活过进程重启，否则输完密码再输验证码时就会「票据已失效」。 */
export const LOGIN_TICKETS = "login_tickets";

interface PendingTicket {
  userId: string;
  userName: string;
  admin: boolean;
  at: number;
  /** 已失败的验证次数：输错码不该让用户重新走一遍登录 */
  attempts?: number;
}

const MAX_TICKET_ATTEMPTS = 5;

const freshUntil = new Map<string, number>();

let ticketIndexReady = false;
async function ensureTicketIndex(db: any) {
  if (ticketIndexReady) return;
  ticketIndexReady = true;
  try {
    // TTL 索引只是兜底清理，精确过期仍然按 at 判断
    await db
      .collection(LOGIN_TICKETS)
      .createIndex({ at: 1 }, { expireAfterSeconds: Math.ceil(MFA_TICKET_MS / 1000), name: "ticket_ttl" });
  } catch {
    /* 索引建不出来不影响登录 */
  }
}

/** 已通过第一因素但还没过第二因素：发一张短票据（落库，重启不丢） */
export async function issueLoginTicket(
  db: any,
  u: { userId: string; userName: string; admin: boolean },
): Promise<string> {
  await ensureTicketIndex(db);
  const ticket = crypto.randomBytes(24).toString("hex");
  await db.collection(LOGIN_TICKETS).insertOne({
    _id: ticket,
    userId: String(u.userId),
    userName: u.userName || "",
    admin: !!u.admin,
    at: Date.now(),
    attempts: 0,
  });
  return ticket;
}

function toPending(doc: any): PendingTicket {
  return {
    userId: String(doc.userId),
    userName: String(doc.userName || ""),
    admin: !!doc.admin,
    at: Number(doc.at) || 0,
    attempts: Number(doc.attempts) || 0,
  };
}

async function liveTicket(db: any, ticket: string) {
  const key = String(ticket || "").trim();
  if (!key) return null;
  const doc: any = await db.collection(LOGIN_TICKETS).findOne({ _id: key });
  if (!doc) return null;
  if (Date.now() - (Number(doc.at) || 0) > MFA_TICKET_MS) {
    await db.collection(LOGIN_TICKETS).deleteOne({ _id: key }).catch(() => {});
    return null;
  }
  return doc;
}

/** 兑换票据（一次性）——只在校验通过、准备签发令牌时调用 */
export async function consumeLoginTicket(db: any, ticket: string): Promise<PendingTicket | null> {
  const doc = await liveTicket(db, ticket);
  if (!doc) return null;
  await db.collection(LOGIN_TICKETS).deleteOne({ _id: doc._id }).catch(() => {});
  return toPending(doc);
}

/**
 * 只看不取：验证码还没对上时不能把票作废，否则输错一位就要重新走一遍登录。
 */
export async function peekLoginTicket(db: any, ticket: string): Promise<PendingTicket | null> {
  const doc = await liveTicket(db, ticket);
  return doc ? toPending(doc) : null;
}

/**
 * 记一次验证失败，返回剩余可重试次数（0 表示票据已作废，必须重新登录）。
 * 限次是为了防止拿着一张票在线爆破 6 位码。
 */
export async function noteTicketFailure(
  db: any,
  ticket: string,
  maxAttempts = MAX_TICKET_ATTEMPTS,
): Promise<number> {
  const doc = await liveTicket(db, ticket);
  if (!doc) return 0;
  const next = (Number(doc.attempts) || 0) + 1;
  if (next >= maxAttempts) {
    await db.collection(LOGIN_TICKETS).deleteOne({ _id: doc._id }).catch(() => {});
    return 0;
  }
  await db
    .collection(LOGIN_TICKETS)
    .updateOne({ _id: doc._id }, { $set: { attempts: next } })
    .catch(() => {});
  return maxAttempts - next;
}

export function markMfaFresh(userId: string, ms = MFA_FRESH_MS) {
  const id = String(userId || "");
  if (!id) return;
  freshUntil.set(id, Date.now() + ms);
}

export function isMfaFresh(userId: string): boolean {
  const until = freshUntil.get(String(userId || ""));
  if (!until) return false;
  if (until <= Date.now()) {
    freshUntil.delete(String(userId || ""));
    return false;
  }
  return true;
}

export function dropMfaFresh(userId: string) {
  freshUntil.delete(String(userId || ""));
}

/**
 * 密钥静态加密。
 * 注意：密钥由 config.jwt.secret 派生 —— 更换 jwt.secret 会导致已封存的 TOTP 密钥
 * 无法解封（此时用户仍可用恢复码登录并重新绑定，不会彻底锁死）。
 */
function sealKey(): Buffer {
  return crypto.createHash("sha256").update(`${config.jwt.secret}::mfa::v1`).digest();
}

export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function openSecret(sealed: string): string | null {
  try {
    const [ver, ivB, tagB, dataB] = String(sealed || "").split(".");
    if (ver !== "v1" || !ivB || !tagB || !dataB) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 消耗一枚验证码（TOTP 或恢复码），成功则推进 mfaLastStep 防重放。
 *
 * 从 router/user/security.ts 提出来放在这里，是为了让「子账户密码登录」也能复用：
 * 那条路径在 /v1/public 下（不需要 JWT），但验码逻辑必须和主账号完全一致，
 * 不能出现两套实现、一处忘了防重放的情况。
 */
export async function consumeMfaCode(
  db: any,
  user: any,
  code: any,
): Promise<{ ok: boolean; via?: "totp" | "recovery"; reason?: string }> {
  const raw = String(code || "").trim();
  if (!raw) return { ok: false, reason: "请输入验证码" };

  const secret = openSecret(user?.mfaSecret || "");
  if (secret) {
    const r = verifyTotp(secret, raw, { after: Number(user?.mfaLastStep) || 0 });
    if (r.ok) {
      await db.collection("user").updateOne({ _id: user._id }, { $set: { mfaLastStep: r.step } });
      return { ok: true, via: "totp" };
    }
  }

  const hash = hashRecoveryCode(raw);
  const list: string[] = Array.isArray(user?.mfaRecoveryCodes) ? user.mfaRecoveryCodes : [];
  if (list.includes(hash)) {
    await db
      .collection("user")
      .updateOne({ _id: user._id }, { $set: { mfaRecoveryCodes: list.filter((h) => h !== hash) } });
    return { ok: true, via: "recovery" };
  }

  if (!secret) return { ok: false, reason: "密钥不可用，请使用恢复码" };
  return { ok: false, reason: "验证码不正确或已过期" };
}
