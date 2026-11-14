import { ObjectId } from "mongodb";
import { log } from "./log.ts";
import { client } from "./db.ts";
import { config } from "../config.ts";

/**
 * 令牌版本（tokenVersion）+ 一键吊销。
 *
 * 现状：登录后签发的是 30 天有效的无状态 JWT，签发之后就再也收不回来了。
 * 账号被盗、设备丢失、或者用户自己「AK 销毁」时，旧令牌仍然能用到过期为止。
 *
 * 这里的做法：每份 JWT 带上签发时的 `tv`，请求时比对数据库里的 `user.tokenVersion`。
 * 只要把 tokenVersion +1，此前签发的所有令牌立刻失效——这就是「下线所有设备」。
 * 版本号在内存里缓存 60 秒，避免给每个已认证请求都加一次数据库往返。
 */

const CACHE_TTL_MS = 60_000;
const versionCache = new Map<string, { v: number; at: number }>();

function dbOf(req: any) {
  return req?.db || client.db(config.db_name);
}

function normId(userId: any): string {
  return String(userId ?? "").trim();
}

export async function readTokenVersion(db: any, userId: string): Promise<number> {
  const id = normId(userId);
  if (!id) return 0;

  const hit = versionCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.v;

  try {
    const user = await db
      .collection("user")
      .findOne({ _id: new ObjectId(id) }, { projection: { tokenVersion: 1 } });
    const v = Number(user?.tokenVersion ?? 0) || 0;
    versionCache.set(id, { v, at: now });
    return v;
  } catch (e) {
    // 查不到/连不上时不阻断请求（可用性优先），沿用缓存里的旧值
    log(`读取令牌版本失败 userId=${id}：${e}`, "error", "auth");
    return hit?.v ?? 0;
  }
}

export function forgetTokenVersion(userId: string) {
  versionCache.delete(normId(userId));
}

/** 吊销该账号已签发的全部令牌，返回新的版本号 */
export async function revokeAllTokens(db: any, userId: string): Promise<number> {
  const id = normId(userId);
  const res = await db
    .collection("user")
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { tokenVersion: 1 } },
      { returnDocument: "after", projection: { tokenVersion: 1 } },
    );
  // mongodb driver v5 返回 {value}，v6 直接返回文档
  const doc = res && (res as any).value !== undefined ? (res as any).value : res;
  const v = Number(doc?.tokenVersion ?? 0) || 0;
  versionCache.set(id, { v, at: Date.now() });
  return v;
}

/**
 * 全局中间件：令牌版本不一致即视为已吊销。
 * 老令牌没有 tv 字段，按 0 处理——所以未吊销过的账号不会有任何感知。
 */
export function tokenGuard(req: any, res: any, next: any) {
  const auth = req?.auth;
  if (!auth?.userId) return next();

  readTokenVersion(dbOf(req), normId(auth.userId))
    .then((cur) => {
      const tok = Number(auth.tv ?? 0) || 0;
      if (tok !== cur) {
        log(`令牌已被吊销（tv ${tok} != ${cur}）userId=${auth.userId}`, "warn", "auth");
        return res.json({ code: 401, msg: "登录凭证已失效，请重新登录", needRelogin: true });
      }
      next();
    })
    .catch((e) => {
      log(`令牌校验异常：${e}`, "error", "auth");
      next();
    });
}
