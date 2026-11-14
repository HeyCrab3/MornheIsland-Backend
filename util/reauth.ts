import { isMfaFresh } from "./mfa.ts";

/**
 * 敏感操作闸门。
 *
 * 这个系统本地没有密码（登录全走上游 SSO），所以「再输一次二级密码」没有东西可校验。
 * 现实可用的两种再验证方式是：
 *  1. **新鲜登录**：令牌是 10 分钟内签发的（要求用户重新登录一次）；
 *  2. **二步验证复核**：5 分钟内刚用动态码验证过（POST /v1/user/security/mfa/verify）。
 *
 * 两者满足其一即可 —— 没开 2FA 的账号走第 1 条，开了 2FA 的账号在长时间挂着页面时
 * 也不必重新走一遍 SSO，直接输 6 位码更顺手。
 */

export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export function loginIsFresh(auth: any, windowMs = REAUTH_WINDOW_MS): boolean {
  const iat = Number(auth?.iat);
  if (!Number.isFinite(iat)) return false;
  return Date.now() - iat * 1000 <= windowMs;
}

export function checkReauth(req: any): { ok: boolean; via?: "login" | "mfa" } {
  if (loginIsFresh(req?.auth)) return { ok: true, via: "login" };
  const userId = String(req?.auth?.userId || "");
  if (userId && isMfaFresh(userId)) return { ok: true, via: "mfa" };
  return { ok: false };
}

export function rejectReauth(res: any, msg: string) {
  return res.status(403).json({ code: 403, msg, needReauth: true });
}
