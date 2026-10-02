/**
 * 插件来源解析：插件包由上游托管，我们只登记来源地址，不再自己存一份。
 *
 * 市场索引里每个插件的 DownloadUrl 是**版本锁定**的 GitHub release 直链
 * （形如 https://github.com/{owner}/{repo}/releases/download/{ver}/{name}.cipx），
 * 内容不可变，所以没必要再镜像一份到本地。
 *
 * 索引同时给了若干 GitHub 镜像（github / ghproxy / moeyy），不同网络下可用性差别很大
 * （实测 moeyy 会直接 SSL 握手失败），因此统一按顺序试到通为止，只保留哈希不留文件。
 */

export interface MarketMirror {
  name: string;
  url: string;
}

/** 用 {root} 模板和镜像表展开出候选直链；不含占位符时视作单一直链 */
export function buildMirrorUrls(template: string, mirrors: Record<string, string>): MarketMirror[] {
  const tpl = String(template || "").trim();
  if (!tpl) return [];
  if (!tpl.includes("{root}")) return [{ name: "direct", url: tpl }];

  const out: MarketMirror[] = [];
  for (const [name, root] of Object.entries(mirrors || {})) {
    const base = String(root || "").replace(/\/+$/, "");
    if (!base) continue;
    out.push({ name, url: tpl.replace("{root}", base) });
  }
  return out;
}

/**
 * 按顺序尝试候选地址，返回第一个成功的响应体与所用地址。
 * 全部失败返回 null——调用方需要区分“拿不到”和“拿到空内容”。
 */
export async function fetchFirstAvailable(
  candidates: MarketMirror[],
  timeoutMs = 30000,
): Promise<{ buf: Buffer; url: string; mirror: string } | null> {
  for (const c of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(c.url, { signal: ctrl.signal, redirect: "follow" });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length) continue;
      return { buf, url: c.url, mirror: c.name };
    } catch {
      /* 这个镜像不通，换下一个 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
