import { log } from "./log.ts";

/**
 * 账号安全审计日志。
 *
 * 保留策略：**不设 TTL，长期保留**。
 * 《中华人民共和国网络安全法》第二十一条（三）要求「按照规定留存相关的网络日志
 * 不少于六个月」——六个月是法定底线，不是上限。这里按更长的期限保留，
 * 目的是被盗号/误删之后还能追溯与恢复，所以刻意不加重过期索引。
 */

export const AUTH_LOGS = "auth_logs";

export type AuthEvent =
  | "login"
  | "login_fail"
  | "logout"
  | "reauth"
  | "reauth_fail"
  | "token_revoke"
  | "sensitive"
  | "mfa_enable"
  | "mfa_disable"
  | "mfa_fail";

let indexed = false;

async function ensureIndexes(db: any) {
  if (indexed) return;
  indexed = true;
  try {
    await db.collection(AUTH_LOGS).createIndex({ userId: 1, at: -1 });
    await db.collection(AUTH_LOGS).createIndex({ ip: 1, at: -1 });
    await db.collection(AUTH_LOGS).createIndex({ at: -1 });
  } catch (e) {
    indexed = false;
    log(`创建认证日志索引失败：${e}`, "warn", "auth");
  }
}

/** 取真实客户端 IP（Docker / 反代场景下 remoteAddress 是子网地址） */
export function clientIp(req: any): string {
  const xff = req?.headers?.["x-forwarded-for"];
  const real = req?.headers?.["x-real-ip"];
  const raw =
    (typeof real === "string" && real) ||
    (typeof xff === "string" && xff.split(",")[0]) ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    "";
  return String(raw).replace(/^::ffff:/, "").trim();
}

export function clientUa(req: any): string {
  return String(req?.headers?.["user-agent"] || "").slice(0, 512);
}

export interface AuthLogEntry {
  // ObjectId 与字符串都接受：调用方常常直接拿 req.auth 里的 userId
  userId?: any;
  userName?: string;
  event: AuthEvent;
  success?: boolean;
  ip?: string;
  ua?: string;
  detail?: string;
  /** 额外上下文，例如被操作的对象 */
  target?: Record<string, any>;
}

/**
 * 写入一条认证/敏感操作日志。
 * 登录成功时会顺带判断「是否首次从这个 IP 登录」，用于异常登录提醒。
 */
export async function authLog(db: any, entry: AuthLogEntry, req?: any): Promise<void> {
  if (!db) return;
  try {
    await ensureIndexes(db);
    const ip = entry.ip || (req ? clientIp(req) : "");
    const ua = entry.ua || (req ? clientUa(req) : "");
    let newIp = false;

    if (entry.event === "login" && entry.success && entry.userId && ip) {
      const seen = await db
        .collection(AUTH_LOGS)
        .findOne({ userId: String(entry.userId), ip, event: "login", success: true });
      newIp = !seen;
    }

    await db.collection(AUTH_LOGS).insertOne({
      userId: entry.userId ? String(entry.userId) : null,
      userName: entry.userName || null,
      event: entry.event,
      success: entry.success !== false,
      ip: ip || null,
      ua: ua || null,
      newIp,
      detail: entry.detail || null,
      target: entry.target || null,
      at: new Date(),
      ts: Date.now(),
    });

    if (entry.event === "login" && newIp) {
      log(`新 IP 登录：${entry.userName || entry.userId} 来自 ${ip}`, "warn", "auth");
    }
  } catch (e) {
    // 审计日志失败不能影响主流程
    log(`写入认证日志失败：${e}`, "error", "auth");
  }
}

/** 读取我的最近登录/操作记录 */
export async function listAuthLogs(db: any, userId: string, limit = 50, event?: string) {
  const filter: any = { userId: String(userId) };
  if (event) filter.event = event;
  return db
    .collection(AUTH_LOGS)
    .find(filter, {
      projection: { userId: 0 },
      sort: { at: -1 },
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    })
    .toArray();
}
