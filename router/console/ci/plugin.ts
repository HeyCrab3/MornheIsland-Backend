/**
 * 插件包管理与分发（需 JWT）。
 *
 * 插件**不再默认自己存**：市场插件的 DownloadUrl 本身就是版本锁定的 GitHub release 直链，
 * 直接把它交给客户端下载即可，我们只登记来源与哈希。
 * 仅当用户手上有 .cipx 却没地方托管时，才用上传做「本机托管」。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { log } from "../../../util/log";
import { readCipxManifest } from "../../../util/cipx";
import { resolvePublicBase, resolvePluginSourceUrl } from "../../../util/public_url";
import { fetchFirstAvailable } from "../../../util/plugin_source";
import { deliverPlugin, fetchClientPlugins, BOOTSTRAP_PLUGIN_ID } from "../../../grpc/server";
import { clients, isOnline } from "../../../grpc/clients";
import { fetchMarket, resolveMarketPackage } from "./plugin_market";
import { config } from "../../../config";

const router = express.Router();

const PLUGINS_DIR = path.join(process.cwd(), "plugins");
function ensureDir() {
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
}

/** 系统级单例设置集合（引导插件地址等，非用户资源） */
const SYSTEM_SETTINGS = "ci_system_settings";

/** 引导插件下载地址：优先取数据库覆盖值，否则回落到 config */
async function resolveBootstrapUrl(db: any): Promise<{ url: string; isDefault: boolean }> {
  const fallback = config.bootstrap_plugin_url || "";
  const doc = await db.collection(SYSTEM_SETTINGS).findOne({ _id: "bootstrap_plugin_url" as any });
  const saved = typeof doc?.value === "string" ? doc.value.trim() : "";
  return { url: saved || fallback, isDefault: !saved };
}

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

/** 查询哪些配置组引用了该插件 */
async function findReferencingProfiles(db: any, pluginId: ObjectId) {
  return db
    .collection("ci_plugin_profiles")
    .find({ plugins: pluginId })
    .project({ name: 1 })
    .toArray();
}

/** POST /v1/console/ci/plugin/upload — 上传 .cipx 并「本机托管」（base64） */
router.post("/v1/console/ci/plugin/upload", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const { name, fileName, fileBase64, version } = req.body || {};
    if (!fileBase64) return res.status(400).json({ code: 400, msg: "缺少文件内容" });

    const buf = Buffer.from(fileBase64, "base64");
    if (!buf.length) return res.status(400).json({ code: 400, msg: "文件内容为空" });

    // 从 .cipx 里读出 manifest：其中的 id 才是客户端上报的身份，对账靠它比对
    const manifest = readCipxManifest(buf);
    const displayName =
      name || manifest.name || (fileName ? String(fileName).replace(/\.cipx$/i, "") : "");
    if (!displayName) return res.status(400).json({ code: 400, msg: "缺少插件名称" });

    ensureDir();
    const _id = new ObjectId();
    const storedName = `${_id.toString()}.cipx`;
    writeFileSync(path.join(PLUGINS_DIR, storedName), buf);

    const sha256 = createHash("sha256").update(buf).digest("hex");
    const doc = {
      _id,
      userId,
      name: displayName,
      pluginId: manifest.id || "",
      version: version || manifest.version || "",
      fileName: fileName || `${displayName}.cipx`,
      storedName,
      source: "upload",
      size: buf.length,
      sha256,
      createdAt: new Date(),
    };
    await req.db.collection("ci_plugins").insertOne(doc);

    log(`[plugin] 用户 ${userId} 上传插件 ${displayName}（id=${manifest.id || "未知"}，${buf.length} 字节）`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: doc });
  } catch (e) {
    log(`[plugin/upload] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "上传失败: " + e });
  }
});

/**
 * POST /v1/console/ci/plugin/from-url — 从直链登记一个插件（不落盘）
 *
 * 会拉取一次用于计算 SHA256 与读取 manifest（客户端校验沿用 sha256，无需改插件），
 * 算完即丢弃文件，库里只留来源地址与哈希。
 */
router.post("/v1/console/ci/plugin/from-url", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const url = String(req.body?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ code: 400, msg: "请填写以 http:// 或 https:// 开头的地址" });
    }

    const got = await fetchFirstAvailable([{ name: "direct", url }]);
    if (!got) return res.status(400).json({ code: 400, msg: "无法下载该地址，请确认它可公开访问" });

    const manifest = readCipxManifest(got.buf);
    if (!manifest.id) {
      return res.status(400).json({ code: 400, msg: "这不是有效的 .cipx（未能在包内找到 manifest.yml 的 id）" });
    }

    const displayName = String(req.body?.name ?? "").trim() || manifest.name || manifest.id;
    const sha256 = createHash("sha256").update(got.buf).digest("hex");

    const fields = {
      name: displayName,
      pluginId: manifest.id,
      version: String(req.body?.version ?? "").trim() || manifest.version || "",
      source: "url",
      url: got.url,
      size: got.buf.length,
      sha256,
      updatedAt: new Date(),
    };

    // 幂等：同一个 manifest id 已在库里就更新那一条，避免重复登记堆出多份副本
    const existing = await req.db.collection("ci_plugins").findOne({ userId, pluginId: manifest.id });
    if (existing) {
      await req.db.collection("ci_plugins").updateOne({ _id: existing._id }, { $set: fields });
      log(`[plugin] 用户 ${userId} 更新直链插件 ${displayName}（id=${manifest.id}）`, "info", "auth");
      return res.json({ code: 0, msg: "该插件已在库中，已更新", data: { ...existing, ...fields } });
    }

    const doc = { _id: new ObjectId(), userId, ...fields, createdAt: new Date() };
    await req.db.collection("ci_plugins").insertOne(doc);

    log(`[plugin] 用户 ${userId} 从直链登记插件 ${displayName}（id=${manifest.id}，${got.buf.length} 字节）`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: doc });
  } catch (e) {
    log(`[plugin/from-url] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "添加失败：" + e });
  }
});

/** GET /v1/console/ci/plugin/list */
router.get("/v1/console/ci/plugin/list", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  const docs = await req.db.collection("ci_plugins").find({ userId }).sort({ createdAt: -1 }).toArray();
  res.json({ code: 0, msg: "ok", data: docs });
});

/**
 * DELETE /v1/console/ci/plugin/:id
 *
 * 若仍被配置组引用则拒绝，除非带 ?force=1——与资源删除（ci_resource.remove）保持一致，
 * 避免删掉之后配置组里静默变成「(插件已删除)」。
 */
router.delete("/v1/console/ci/plugin/:id", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "插件 id 无效" });

  const doc = await req.db.collection("ci_plugins").findOne({ _id: new ObjectId(req.params.id), userId });
  if (!doc) return res.status(404).json({ code: 404, msg: "插件不存在" });

  const force = req.query.force === "1" || req.body?.force === true;
  const usedBy = await findReferencingProfiles(req.db, doc._id);
  if (usedBy.length && !force) {
    const names = usedBy.map((p: any) => p.name).join("、");
    return res.status(409).json({
      code: 409,
      msg: `无法删除：以下配置组正在引用此插件：${names}。请先取消引用，或确认强制删除。`,
      data: { usedBy: usedBy.map((p: any) => ({ _id: String(p._id), name: p.name })) },
    });
  }

  // 只有「本机托管」的才有落盘文件要删；直链来源的没有
  if (doc.storedName) {
    try {
      const p = path.join(PLUGINS_DIR, doc.storedName);
      if (existsSync(p)) unlinkSync(p);
    } catch { /* 忽略文件删除失败 */ }
  }
  await req.db.collection("ci_plugins").deleteOne({ _id: doc._id });
  log(`[plugin] 用户 ${userId} 删除插件 ${doc.name}${usedBy.length ? `（强制，仍被 ${usedBy.length} 个配置组引用）` : ""}`, "info", "auth");
  res.json({ code: 0, msg: "ok" });
});

/** GET /v1/console/ci/plugin/:id/usage — 该插件被哪些配置组引用 */
router.get("/v1/console/ci/plugin/:id/usage", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "插件 id 无效" });

  const doc = await req.db.collection("ci_plugins").findOne({ _id: new ObjectId(req.params.id), userId });
  if (!doc) return res.status(404).json({ code: 404, msg: "插件不存在" });

  const usedBy = await findReferencingProfiles(req.db, doc._id);
  res.json({
    code: 0,
    msg: "ok",
    data: { profiles: usedBy.map((p: any) => ({ _id: String(p._id), name: p.name })) },
  });
});

/** POST /v1/console/ci/plugin/:id/rename — 只改显示名（pluginId 是客户端身份，不能改） */
router.post("/v1/console/ci/plugin/:id/rename", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "插件 id 无效" });

  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ code: 400, msg: "名称不能为空" });

  const r = await req.db.collection("ci_plugins").updateOne(
    { _id: new ObjectId(req.params.id), userId },
    { $set: { name, updatedAt: new Date() } },
  );
  if (!r.matchedCount) return res.status(404).json({ code: 404, msg: "插件不存在" });

  log(`[plugin] 用户 ${userId} 重命名插件 → ${name}`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { name } });
});

/**
 * POST /v1/console/ci/plugin/check-updates — 对比市场索引，看看哪些插件有新版本
 *
 * 只做检查，不改库。注意：更新插件库**不会**让已装旧版的设备自动升级——
 * 客户端只上报插件 id、不上报版本，无从判断版本差异；更新只影响之后的新装。
 */
router.post("/v1/console/ci/plugin/check-updates", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const docs = await req.db
    .collection("ci_plugins")
    .find({ userId, marketId: { $exists: true, $ne: "" } })
    .toArray();
  if (!docs.length) {
    return res.json({ code: 0, msg: "插件库里没有市场来源的插件", data: { items: [], updatable: 0, missingInMarket: 0 } });
  }

  try {
    const { plugins } = await fetchMarket();
    const byId = new Map(plugins.map((p) => [p.id, p]));

    const items = docs.map((d: any) => {
      const latest: any = byId.get(d.marketId);
      const latestVersion = latest?.version || "";
      return {
        _id: String(d._id),
        name: d.name,
        pluginId: d.pluginId || d.marketId,
        currentVersion: d.version || "",
        latestVersion,
        outdated: !!latestVersion && latestVersion !== (d.version || ""),
        missingInMarket: !latest,
      };
    });

    res.json({
      code: 0,
      msg: "ok",
      data: {
        items,
        updatable: items.filter((i) => i.outdated).length,
        missingInMarket: items.filter((i) => i.missingInMarket).length,
      },
    });
  } catch (e) {
    log(`[plugin/check-updates] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "获取市场索引失败：" + e });
  }
});

/**
 * POST /v1/console/ci/plugin/:id/update — 把市场来源的插件重新拉到最新版并更新来源记录
 *
 * 只更新插件库里的 url / version / sha256，不动配置组引用关系。
 */
router.post("/v1/console/ci/plugin/:id/update", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "插件 id 无效" });

  const doc = await req.db.collection("ci_plugins").findOne({ _id: new ObjectId(req.params.id), userId });
  if (!doc) return res.status(404).json({ code: 404, msg: "插件不存在" });
  if (!doc.marketId) {
    return res.status(400).json({ code: 400, msg: "该插件不是市场来源，无法自动更新。可删除后重新用直链登记。" });
  }

  try {
    const r = await resolveMarketPackage(doc.marketId);
    if (!r.ok) return res.status(r.status).json({ code: r.status, msg: r.msg });

    const update = {
      name: doc.name || r.item.name || doc.marketId,
      pluginId: doc.pluginId || r.item.id || r.manifest.id || "",
      version: r.item.version || r.manifest.version || "",
      url: r.url,
      urls: r.urls,
      size: r.size,
      sha256: r.sha256,
      updatedAt: new Date(),
    };
    await req.db.collection("ci_plugins").updateOne({ _id: doc._id }, { $set: update });

    log(`[plugin] 用户 ${userId} 更新插件 ${update.name} → v${update.version}（经 ${r.mirror}）`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: update });
  } catch (e) {
    log(`[plugin/update] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "更新失败：" + e });
  }
});

/**
 * POST /v1/console/ci/plugin/query-all — 刷新本用户所有在线设备的已装插件
 * 并发查询（命令 104），结果写入 ci_clients.plugins。
 */
router.post("/v1/console/ci/plugin/query-all", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const classes = await req.db.collection("ci_classes").find({ userId }).project({ identity: 1 }).toArray();
  const identities = classes.map((c: any) => c.identity).filter(Boolean);
  if (!identities.length) {
    return res.json({ code: 0, msg: "没有班级", data: { total: 0, online: 0, refreshed: 0, devices: [] } });
  }

  const clientDocs = await req.db.collection("ci_clients").find({ identity: { $in: identities } }).toArray();
  const online = clientDocs.filter((d: any) => isOnline(d.cuid));

  const devices = await Promise.all(
    online.map(async (d: any) => {
      const plugins = await fetchClientPlugins(d.cuid);
      if (plugins) {
        await req.db.collection("ci_clients").updateOne(
          { cuid: d.cuid },
          { $set: { plugins, pluginsUpdatedAt: new Date() } },
        );
      }
      return { cuid: d.cuid, identity: d.identity || "", ok: plugins !== null, count: plugins?.length ?? null };
    }),
  );

  const refreshed = devices.filter((d) => d.ok).length;
  log(`[plugin] 用户 ${userId} 刷新设备插件：在线 ${online.length} 台，成功 ${refreshed} 台`, "info", "auth");
  res.json({
    code: 0,
    msg: "ok",
    data: { total: clientDocs.length, online: online.length, refreshed, devices },
  });
});

/** POST /v1/console/ci/plugin/deliver — 下发插件分发指令（gRPC 自定义命令 200） */
router.post("/v1/console/ci/plugin/deliver", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { pluginId, cuid, all } = req.body || {};
  if (!pluginId) return res.status(400).json({ code: 400, msg: "缺少 pluginId" });

  const doc = await req.db.collection("ci_plugins").findOne({ _id: new ObjectId(pluginId), userId });
  if (!doc) return res.status(404).json({ code: 404, msg: "插件不存在" });

  const base = resolvePublicBase(req, req.body?.baseUrl);
  const url = resolvePluginSourceUrl(doc, base);
  if (!url) return res.status(400).json({ code: 400, msg: "该插件没有可用的下载地址" });

  const payload = {
    action: "install",
    // 客户端把它当落盘文件名（{PluginId}.cipx），用 manifest id 更干净也更稳
    pluginId: doc.pluginId || doc.name,
    url,
    sha256: doc.sha256,
    version: doc.version || "",
  };

  let sent = 0;
  if (all) {
    for (const c of clients.keys()) if (deliverPlugin(c, payload)) sent++;
  } else if (cuid) {
    if (deliverPlugin(String(cuid), payload)) sent = 1;
  } else {
    return res.status(400).json({ code: 400, msg: "需要指定 cuid 或 all" });
  }

  log(`[plugin] 用户 ${userId} 下发插件 ${doc.name}，成功 ${sent} 台`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { sent, payload } });
});

/**
 * GET /v1/console/ci/plugin/bootstrap — 引导插件下载地址。
 *
 * ClassIsland 本身没有“服务端装插件”的能力（ManagementSettings 里也没有插件源字段），
 * 所以每台机器必须先手动装一次引导插件，之后才收得到插件分发指令（命令 200）。
 * 这里把地址交给控制台展示，省得每次翻文档。
 */
router.get("/v1/console/ci/plugin/bootstrap", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  const { url, isDefault } = await resolveBootstrapUrl(req.db);
  res.json({ code: 0, msg: "ok", data: { url, isDefault } });
});

/** PUT /v1/console/ci/plugin/bootstrap — 覆盖引导插件地址 */
router.put("/v1/console/ci/plugin/bootstrap", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const url = String(req.body?.url ?? "").trim();
  // 传空字符串表示恢复默认
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ code: 400, msg: "地址必须以 http:// 或 https:// 开头" });
  }

  if (!url) {
    await req.db.collection(SYSTEM_SETTINGS).deleteOne({ _id: "bootstrap_plugin_url" as any });
    const fallback = config.bootstrap_plugin_url || "";
    return res.json({ code: 0, msg: "已恢复默认地址", data: { url: fallback, isDefault: true } });
  }

  await req.db.collection(SYSTEM_SETTINGS).updateOne(
    { _id: "bootstrap_plugin_url" as any },
    { $set: { value: url, updatedAt: new Date(), updatedBy: userId } },
    { upsert: true },
  );
  log(`[plugin] 用户 ${userId} 更新引导插件地址 → ${url}`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { url, isDefault: false } });
});

/**
 * POST /v1/console/ci/plugin/query — 查询某台设备已安装的插件
 *
 * 走命令 104（GetClientConfig + PluginList），由 ClassIsland 本体应答，
 * 因此即使客户端还没装引导插件也能查到它装了什么。
 */
router.post("/v1/console/ci/plugin/query", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const cuid = String(req.body?.cuid ?? "");
  if (!cuid) return res.status(400).json({ code: 400, msg: "缺少 cuid" });

  const plugins = await fetchClientPlugins(cuid);
  if (plugins === null) {
    return res.json({
      code: 0,
      msg: "设备未响应",
      data: { cuid, online: false, plugins: null, hasBootstrap: false },
    });
  }

  await req.db.collection("ci_clients").updateOne(
    { cuid },
    { $set: { plugins, pluginsUpdatedAt: new Date() } },
  );

  res.json({
    code: 0,
    msg: "ok",
    data: {
      cuid,
      online: true,
      plugins,
      hasBootstrap: plugins.includes(BOOTSTRAP_PLUGIN_ID),
    },
  });
});

/**
 * POST /v1/console/ci/plugin/dedupe — 清理重复条目
 *
 * 同一 manifest id 保留一条：优先保留被配置组引用的，否则保留最早登记的。
 * 其余条目只有在**没被任何配置组引用**时才删除，避免动到仍在使用的东西。
 * 带 ?dryRun=1 时只报告会删什么，不真删。
 */
router.post("/v1/console/ci/plugin/dedupe", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;

  const docs = await req.db.collection("ci_plugins").find({ userId }).sort({ createdAt: 1 }).toArray();

  const byPluginId = new Map<string, any[]>();
  for (const d of docs) {
    const key = String(d.pluginId || d.marketId || "");
    if (!key) continue;
    if (!byPluginId.has(key)) byPluginId.set(key, []);
    byPluginId.get(key)!.push(d);
  }

  const profiles = await req.db.collection("ci_plugin_profiles").find({ userId }).toArray();
  const referenced = new Set<string>();
  for (const p of profiles) for (const pid of p.plugins || []) referenced.add(String(pid));

  const removed: any[] = [];
  const kept: any[] = [];
  const skipped: any[] = [];

  for (const [pluginId, list] of byPluginId) {
    if (list.length < 2) continue;

    // list 已按 createdAt 升序；优先保留被引用的那条
    const keep = list.find((d) => referenced.has(String(d._id))) || list[0];
    kept.push({ _id: String(keep._id), name: keep.name, pluginId, copies: list.length });

    for (const d of list) {
      if (String(d._id) === String(keep._id)) continue;
      if (referenced.has(String(d._id))) {
        skipped.push({ _id: String(d._id), name: d.name, pluginId, reason: "仍被配置组引用" });
        continue;
      }
      if (d.storedName && !dryRun) {
        try {
          const p = path.join(PLUGINS_DIR, d.storedName);
          if (existsSync(p)) unlinkSync(p);
        } catch { /* 忽略文件删除失败 */ }
      }
      if (!dryRun) await req.db.collection("ci_plugins").deleteOne({ _id: d._id });
      removed.push({ _id: String(d._id), name: d.name, pluginId });
    }
  }

  log(
    `[plugin] 用户 ${userId} 去重${dryRun ? "（预演）" : ""}：${dryRun ? "将删除" : "删除"} ${removed.length} 条重复，涉及 ${kept.length} 组`,
    "info",
    "auth",
  );
  res.json({ code: 0, msg: "ok", data: { dryRun, removed, kept, skipped } });
});

export default router;
