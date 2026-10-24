/**
 * 对外链接的基地址。
 *
 * 邀请链接、通知二维码里写的都是**绝对地址**，一旦写错就是一串死链接，
 * 所以优先级要明确：配置项（正式域名）→ 环境变量 → 反向代理头 → 请求头。
 */

import { config } from "../config";

export function siteBaseUrl(req: any): string {
  const fromConfig = String((config as any).public_base_url ?? "").trim();
  if (fromConfig) return fromConfig.replace(/\/+$/, "");

  const envBase = String(process.env.PUBLIC_BASE_URL ?? "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : "";
}
