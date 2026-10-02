/**
 * ClassIsland 插件市场代理（需 JWT）。
 *
 * 官方市场索引是个 zip（含 index.v2.json），这里拉取、解压、缓存。
 * 关键点：**导入不落盘**。索引里的 DownloadUrl 是版本锁定的 GitHub release 直链，
 * 我们只在导入时拉一次算出 SHA256（客户端校验沿用 sha256，因此不必改插件），
 * 算出后即丢弃文件，库里只留来源地址与哈希，下载交给上游 CDN。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { log } from "../../../util/log";
import { readCipxManifest } from "../../../util/cipx";
import { buildMirrorUrls, fetchFirstAvailable } from "../../../util/plugin_source";

const router = express.Router();

const MARKET_INDEX_URL =
  "https://get.classisland.tech/d/ClassIsland-Ningbo-S3/classisland/plugin/index.zip";

let marketCache: { at: number; data: any[]; mirrors: Record<string, string> } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

export async function fetchMarket(): Promise<{ plugins: any[]; mirrors: Record<string, string> }> {
  if (marketCache && Date.now() - marketCache.at < CACHE_TTL) {
    return { plugins: marketCache.data, mirrors: marketCache.mirrors };
  }

  const url = `${MARKET_INDEX_URL}?time=${Date.now()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`市场索引请求失败：${resp.status}`);
  const zipBuf = Buffer.from(await resp.arrayBuffer());

  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntry("index.v2.json") || zip.getEntry("index.json");
  if (!entry) throw new Error("市场索引包中未找到 index.v2.json");
  const parsed = JSON.parse(zip.readAsText(entry));
  const mirrors: Record<string, string> = parsed?.DownloadMirrors || {};
  const githubRoot = mirrors.github || "https://github.com";

  const plugins = (parsed?.Plugins || []).map((p: any) => {
    const m = p.Manifest || {};
    const tpl = p.DownloadUrl || "";
    return {
      id: m.Id || "",
      name: m.Name || "",
      description: m.Description || "",
      version: m.Version || "",
      author: m.Author || "",
      apiVersion: m.ApiVersion || "",
      url: m.Url || "",
      // 保留原始模板（含 {root}），导入时用镜像表展开；downloadUrl 仅用于展示
      downloadUrlTemplate: tpl,
      downloadUrl: tpl.replace("{root}", githubRoot),
      downloadMd5: p.DownloadMd5 || "",
      iconUrl: (p.RealIconPath || "").replace("{root}", githubRoot),
      downloadCount: p.DownloadCount || 0,
      starsCount: p.StarsCount || 0,
      dependencies: m.Dependencies || [],
    };
  });

  marketCache = { at: Date.now(), data: plugins, mirrors };
  log(`[plugin-market] 已刷新市场索引，共 ${plugins.length} 个插件`, "info", "auth");
  return { plugins, mirrors };
}

/**
 * 解析市场插件并取回其包内容，用于「导入」与「更新」两条路径。
 *
 * 会拉一次包：算 SHA256（客户端校验用）、校验市场自带的 MD5、读 manifest。
 * 拿到后由调用方决定怎么登记——本函数不落盘。
 */
export async function resolveMarketPackage(marketId: string): Promise<
  | { ok: true; item: any; mirror: string; url: string; urls: string[]; size: number; sha256: string; manifest: ReturnType<typeof readCipxManifest> }
  | { ok: false; status: number; msg: string }
> {
  const { plugins, mirrors } = await fetchMarket();
  const item = plugins.find((p) => p.id === marketId);
  if (!item) return { ok: false, status: 404, msg: "市场中未找到该插件" };
  if (!item.downloadUrlTemplate) return { ok: false, status: 400, msg: "该插件没有下载地址" };

  const candidates = buildMirrorUrls(item.downloadUrlTemplate, mirrors);
  if (!candidates.length && item.downloadUrl) candidates.push({ name: "github", url: item.downloadUrl });

  const got = await fetchFirstAvailable(candidates);
  if (!got) return { ok: false, status: 502, msg: "该插件的所有下载镜像都不可用，请稍后重试" };

  // 市场自带 MD5，顺手校验一次，避免把被篡改/损坏的内容登记进来
  if (item.downloadMd5) {
    const md5 = createHash("md5").update(got.buf).digest("hex");
    if (md5.toLowerCase() !== String(item.downloadMd5).toLowerCase()) {
      return { ok: false, status: 400, msg: "插件包 MD5 校验失败，已中止" };
    }
  }

  return {
    ok: true,
    item,
    mirror: got.mirror,
    url: got.url,
    urls: candidates.map((c) => c.url),
    size: got.buf.length,
    sha256: createHash("sha256").update(got.buf).digest("hex"),
    manifest: readCipxManifest(got.buf),
  };
}

/** GET /v1/console/ci/plugin/market — 市场插件列表 */
router.get("/v1/console/ci/plugin/market", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  try {
    const { plugins } = await fetchMarket();
    res.json({ code: 0, msg: "ok", data: plugins });
  } catch (e) {
    log(`[plugin-market/list] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "获取市场索引失败：" + e });
  }
});

/**
 * POST /v1/console/ci/plugin/market/import — 把市场插件登记到插件库（不落盘）
 *
 * 逐个镜像试到通为止：实测不同网络下 github / ghproxy / moeyy 的可用性差别很大，
 * 取到内容的那个地址会成为交给客户端的下载地址。
 */
router.post("/v1/console/ci/plugin/market/import", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { pluginId } = req.body || {};
  if (!pluginId) return res.status(400).json({ code: 400, msg: "缺少 pluginId" });

  try {
    const r = await resolveMarketPackage(pluginId);
    if (!r.ok) return res.status(r.status).json({ code: r.status, msg: r.msg });

    const pluginIdValue = r.item.id || r.manifest.id || "";
    const fields = {
      name: r.item.name || r.manifest.name || r.item.id,
      // 市场索引里的 Manifest.Id 就是客户端上报的插件身份
      pluginId: pluginIdValue,
      version: r.item.version || r.manifest.version || "",
      source: "market",
      marketId: r.item.id,
      // 实际取到内容的直链 → 直接交给客户端下载，不经过我们
      url: r.url,
      urls: r.urls,
      size: r.size,
      sha256: r.sha256,
      updatedAt: new Date(),
    };

    // 幂等：同一个 manifest id 已在库里就更新那一条，避免重复导入堆出多份副本
    const existing = pluginIdValue
      ? await req.db.collection("ci_plugins").findOne({ userId, pluginId: pluginIdValue })
      : null;

    if (existing) {
      await req.db.collection("ci_plugins").updateOne({ _id: existing._id }, { $set: fields });
      log(`[plugin-market] 用户 ${userId} 更新已有插件 ${fields.name}（${pluginIdValue}）`, "info", "auth");
      return res.json({ code: 0, msg: "该插件已在库中，已更新", data: { ...existing, ...fields } });
    }

    const doc = { _id: new ObjectId(), userId, ...fields, createdAt: new Date() };
    await req.db.collection("ci_plugins").insertOne(doc);

    log(
      `[plugin-market] 用户 ${userId} 登记插件 ${doc.name}（${doc.pluginId}，经 ${r.mirror}，${r.size} 字节，未落盘）`,
      "info",
      "auth",
    );
    res.json({ code: 0, msg: "ok", data: doc });
  } catch (e) {
    log(`[plugin-market/import] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导入失败：" + e });
  }
});

export default router;
