/**
 * 解析“客户端应当访问的”服务地址。
 *
 * 不能直接用 req.get("host")：控制台经过 Vite 代理（changeOrigin: true）访问后端时，
 * 后端看到的 Host 是 127.0.0.1:7000，而客户端需要的是控制台对外地址，
 * 且必须带上 /api 前缀（/api 是代理负责剥掉的，后端自己没有这个前缀）。
 *
 * 优先级：请求显式传入（前端用 window.location.origin）> config.public_base_url > Origin 头 > 请求 Host。
 */
import { config } from "../config";

export function resolvePublicBase(req: any, explicit?: string): string {
  const strip = (s: string) => s.trim().replace(/\/+$/, "");

  const fromBody = strip(String(explicit ?? ""));
  if (fromBody) return fromBody;

  const configured = strip(config.public_base_url || "");
  if (configured) return configured;

  const origin = strip(String(req.get?.("origin") ?? ""));
  if (origin) return origin;

  return strip(`${req.protocol}://${req.get("host")}`);
}

/** 客户端下载插件包的地址（带 /api 前缀，与 manifest 地址同源） */
export function buildPluginDownloadUrl(base: string, pluginObjectId: string): string {
  return `${base}/api/v1/ci/plugin/${pluginObjectId}/download`;
}

/**
 * 插件包的实际下载地址：
 *  - 外部来源（市场直链 / 手动填的 URL）直接用上游地址，不经过我们
 *  - 只有「本机托管」（用户上传、无处托管）的才走我们的下载路由
 */
export function resolvePluginSourceUrl(doc: any, base: string): string {
  const external = String(doc?.url || "").trim();
  if (external) return external;
  if (doc?.storedName) return buildPluginDownloadUrl(base, String(doc._id));
  return "";
}
