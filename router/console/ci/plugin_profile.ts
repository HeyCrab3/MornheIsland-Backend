/**
 * 插件配置组：声明“这些班级应该装哪些插件”，并对账下发。
 *
 * 与一次性盲推不同，这里是**期望状态对账**：
 *   1. 用命令 104 问客户端当前装了哪些插件（由 ClassIsland 本体应答，无需引导插件）
 *   2. 只把缺的补发出去（命令 200，这一条才需要客户端已装引导插件）
 * 因此新装、重装、漏收的机器都能自愈，不必人工比对。
 *
 * 「每个班一份配置」= 一个组只绑一个班；多个班共用一套就绑多个班。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { resolvePublicBase, resolvePluginSourceUrl } from "../../../util/public_url";
import { deliverPlugin, fetchClientPlugins, BOOTSTRAP_PLUGIN_ID } from "../../../grpc/server";
import { isOnline } from "../../../grpc/clients";

const COL = "ci_plugin_profiles";
const router = express.Router();

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

function toObjectIds(list: any): ObjectId[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => String(x))
    .filter((x) => ObjectId.isValid(x))
    .map((x) => new ObjectId(x));
}

/** 把配置组里的插件/班级 id 展开成前端要显示的名字 */
async function decorate(db: any, docs: any[]) {
  const pluginOids = [
    ...new Set(docs.flatMap((d) => (d.plugins || []).map(String))),
  ].filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));

  const classOids = [
    ...new Set(docs.flatMap((d) => (d.classIds || []).map(String))),
  ].filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));

  const plugins = pluginOids.length
    ? await db.collection("ci_plugins").find({ _id: { $in: pluginOids } }).toArray()
    : [];
  const classes = classOids.length
    ? await db.collection("ci_classes").find({ _id: { $in: classOids } }).project({ name: 1, identity: 1 }).toArray()
    : [];

  const pMap = new Map(plugins.map((p: any) => [String(p._id), p]));
  const cMap = new Map(classes.map((c: any) => [String(c._id), c]));

  return docs.map((d) => ({
    _id: String(d._id),
    name: d.name,
    description: d.description || "",
    plugins: (d.plugins || []).map((id: any) => {
      const p: any = pMap.get(String(id));
      return p
        ? { _id: String(p._id), name: p.name, pluginId: p.pluginId || p.marketId || "", version: p.version || "", source: p.source || (p.storedName ? "upload" : "url"), url: p.url || "", exists: true }
        : { _id: String(id), name: "(插件已删除)", pluginId: "", version: "", exists: false };
    }),
    classes: (d.classIds || []).map((id: any) => {
      const c: any = cMap.get(String(id));
      return c
        ? { _id: String(c._id), name: c.name || "", identity: c.identity || "" }
        : { _id: String(id), name: "(班级已删除)", identity: "" };
    }),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

/** GET /v1/console/ci/plugin/profile/list */
router.get("/v1/console/ci/plugin/profile/list", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  const docs = await req.db.collection(COL).find({ userId }).sort({ updatedAt: -1 }).toArray();
  res.json({ code: 0, msg: "ok", data: await decorate(req.db, docs) });
});

/** POST /v1/console/ci/plugin/profile — 新建或更新配置组 */
router.post("/v1/console/ci/plugin/profile", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { _id, name, description, pluginIds, classIds } = req.body || {};
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return res.status(400).json({ code: 400, msg: "缺少配置组名称" });

  const set = {
    name: trimmed,
    description: String(description ?? ""),
    plugins: toObjectIds(pluginIds),
    classIds: toObjectIds(classIds),
    updatedAt: new Date(),
  };

  if (_id) {
    if (!ObjectId.isValid(String(_id))) return res.status(400).json({ code: 400, msg: "配置组 id 无效" });
    const r = await req.db.collection(COL).updateOne(
      { _id: new ObjectId(String(_id)), userId },
      { $set: set },
    );
    if (!r.matchedCount) return res.status(404).json({ code: 404, msg: "配置组不存在" });
    return res.json({ code: 0, msg: "ok", data: { _id: String(_id) } });
  }

  const doc = { _id: new ObjectId(), userId, ...set, createdAt: new Date() };
  await req.db.collection(COL).insertOne(doc);
  log(`[plugin-profile] 用户 ${userId} 创建配置组「${trimmed}」`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { _id: String(doc._id) } });
});

/** DELETE /v1/console/ci/plugin/profile/:id */
router.delete("/v1/console/ci/plugin/profile/:id", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "配置组 id 无效" });

  const doc = await req.db.collection(COL).findOne({ _id: new ObjectId(req.params.id), userId });
  if (!doc) return res.status(404).json({ code: 404, msg: "配置组不存在" });

  await req.db.collection(COL).deleteOne({ _id: doc._id });
  log(`[plugin-profile] 用户 ${userId} 删除配置组「${doc.name}」`, "info", "auth");
  res.json({ code: 0, msg: "ok" });
});

/**
 * POST /v1/console/ci/plugin/profile/:id/apply — 对账下发
 *
 * 逐台设备：查已装插件 → 比对期望 → 只补发缺的。
 * 未装引导插件的设备直接标出来（推 200 也是石沉大海，不如让用户去手动装）。
 */
router.post("/v1/console/ci/plugin/profile/:id/apply", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "配置组 id 无效" });

  const db = req.db;
  const profile = await db.collection(COL).findOne({ _id: new ObjectId(req.params.id), userId });
  if (!profile) return res.status(404).json({ code: 404, msg: "配置组不存在" });

  // ── 期望插件（按 manifest id 去重，客户端上报的就是这个 id）──
  const pluginOids = toObjectIds(profile.plugins);
  const pluginDocs = pluginOids.length
    ? await db.collection("ci_plugins").find({ _id: { $in: pluginOids }, userId }).toArray()
    : [];

  const desiredMap = new Map<string, any>();
  const unknownPlugins: string[] = [];
  for (const p of pluginDocs) {
    // pluginId 缺失时回落到 marketId（市场索引里的 Manifest.Id）。
    // 启动时的 backfillPluginIds 会补齐历史数据，这里只是兜底。
    const id = String(p.pluginId || p.marketId || "");
    if (id) desiredMap.set(id, p);
    else unknownPlugins.push(p.name);
  }
  const desired = [...desiredMap.entries()].map(([id, doc]) => ({ id, doc }));

  // ── 目标班级 → identity ──
  const classOids = toObjectIds(profile.classIds);
  const classes = classOids.length
    ? await db.collection("ci_classes").find({ _id: { $in: classOids }, userId }).project({ name: 1, identity: 1 }).toArray()
    : [];
  const identities = classes.map((c: any) => c.identity).filter(Boolean);
  const classByIdentity = new Map(classes.map((c: any) => [c.identity, c]));

  const emptySummary = {
    targetDevices: 0, upToDate: 0, pushed: 0, offline: 0, noResponse: 0, noBootstrap: 0,
    desiredPlugins: desired.map((p) => p.id), unknownPlugins,
  };

  if (!identities.length) {
    return res.json({
      code: 0,
      msg: "该配置组还没有绑定班级，或绑定班级的班级标识为空",
      data: { devices: [], summary: emptySummary },
    });
  }
  if (!desired.length) {
    return res.json({
      code: 0,
      msg: "该配置组还没有可下发的插件",
      data: { devices: [], summary: emptySummary },
    });
  }

  const clientDocs = await db.collection("ci_clients").find({ identity: { $in: identities } }).toArray();
  const base = resolvePublicBase(req, req.body?.baseUrl);
  const devices: any[] = [];

  for (const d of clientDocs) {
    const cls: any = classByIdentity.get(d.identity);
    const common = { cuid: d.cuid, identity: d.identity || "", className: cls?.name || "" };

    if (!isOnline(d.cuid)) {
      devices.push({ ...common, status: "offline", message: "设备离线，跳过", missing: [], installedCount: null });
      continue;
    }

    const installed = await fetchClientPlugins(d.cuid);
    if (installed === null) {
      devices.push({ ...common, status: "no-response", message: "设备在线但未在超时时间内应答", missing: [], installedCount: null });
      continue;
    }

    await db.collection("ci_clients").updateOne(
      { cuid: d.cuid },
      { $set: { plugins: installed, pluginsUpdatedAt: new Date() } },
    );

    if (!installed.includes(BOOTSTRAP_PLUGIN_ID)) {
      devices.push({
        ...common,
        status: "no-bootstrap",
        message: "未安装引导插件，收不到分发指令；请先在该机器上手动安装引导插件",
        installed,
        installedCount: installed.length,
        missing: [],
      });
      continue;
    }

    const installedSet = new Set(installed);
    const missing = desired.filter((p) => !installedSet.has(p.id));

    if (!missing.length) {
      devices.push({
        ...common, status: "up-to-date", message: "已是最新",
        installed, installedCount: installed.length, missing: [],
      });
      continue;
    }

    const pushed: string[] = [];
    const failed: string[] = [];
    for (const p of missing) {
      // 市场/直链来源直接用上游地址；只有本机托管的才走我们的下载路由
      const url = resolvePluginSourceUrl(p.doc, base);
      if (!url) {
        failed.push(p.id);
        continue;
      }
      const ok = deliverPlugin(d.cuid, {
        action: "install",
        pluginId: p.id,
        url,
        sha256: p.doc.sha256,
        version: p.doc.version || "",
      });
      if (ok) pushed.push(p.id);
      else failed.push(p.id);
    }

    devices.push({
      ...common,
      status: pushed.length === missing.length ? "pushed" : "partial",
      message: pushed.length
        ? `已补发 ${pushed.length}/${missing.length} 个插件，客户端下载安装后需重启 ClassIsland 生效`
        : `补发失败（${missing.length} 个）`,
      installed,
      installedCount: installed.length,
      missing: pushed,
      failed,
    });
  }

  const summary = {
    targetDevices: clientDocs.length,
    upToDate: devices.filter((d) => d.status === "up-to-date").length,
    pushed: devices.filter((d) => d.status === "pushed" || d.status === "partial").length,
    offline: devices.filter((d) => d.status === "offline").length,
    noResponse: devices.filter((d) => d.status === "no-response").length,
    noBootstrap: devices.filter((d) => d.status === "no-bootstrap").length,
    desiredPlugins: desired.map((p) => p.id),
    unknownPlugins,
  };

  log(
    `[plugin-profile] 用户 ${userId} 对账下发「${profile.name}」：目标 ${clientDocs.length} 台，补发 ${summary.pushed} 台，未装引导插件 ${summary.noBootstrap} 台`,
    "info",
    "auth",
  );
  res.json({
    code: 0,
    msg: "ok",
    data: {
      profile: { _id: String(profile._id), name: profile.name },
      devices,
      summary,
      baseUrl: base,
    },
  });
});

/**
 * GET /v1/console/ci/plugin/compliance — 部署状态
 *
 * 期望 = 该设备所属班级绑定的所有配置组的插件**并集**（按 manifest id 去重）。
 * 设备侧数据来自 ci_clients.plugins（命令 104 采集），可能过期，故一并返回采集时间。
 * 只能比 id，比不了版本——客户端只上报插件 id。
 */
router.get("/v1/console/ci/plugin/compliance", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const db = req.db;

  const classes = await db.collection("ci_classes").find({ userId }).project({ name: 1, identity: 1 }).toArray();
  const identityToClass = new Map(
    classes.filter((c: any) => c.identity).map((c: any) => [c.identity, c]),
  );

  const profiles = await db.collection("ci_plugin_profiles").find({ userId }).toArray();

  // 被配置组引用的插件 → manifest id
  const pluginOids = [...new Set(profiles.flatMap((p: any) => (p.plugins || []).map(String)))]
    .filter((s) => ObjectId.isValid(s))
    .map((s) => new ObjectId(s));
  const pluginDocs = pluginOids.length
    ? await db.collection("ci_plugins").find({ _id: { $in: pluginOids } }).toArray()
    : [];
  const pluginByOid = new Map(pluginDocs.map((p: any) => [String(p._id), p]));

  // classId → { 期望 id 集合, 关联配置组 }
  const classExpected = new Map<string, { ids: Set<string>; profiles: { _id: string; name: string }[] }>();
  for (const prof of profiles) {
    for (const cid of prof.classIds || []) {
      const key = String(cid);
      let entry = classExpected.get(key);
      if (!entry) {
        entry = { ids: new Set(), profiles: [] };
        classExpected.set(key, entry);
      }
      entry.profiles.push({ _id: String(prof._id), name: prof.name });
      for (const pid of prof.plugins || []) {
        const p: any = pluginByOid.get(String(pid));
        const id = String(p?.pluginId || p?.marketId || "");
        if (id) entry.ids.add(id);
      }
    }
  }

  // 插件库里的名字，供前端把 id 显示成人话（设备上手工装的插件不在库里，前端回落到显示 id）
  const library = await db
    .collection("ci_plugins")
    .find({ userId })
    .project({ name: 1, pluginId: 1, marketId: 1 })
    .toArray();
  const pluginNames: Record<string, string> = {};
  for (const p of library) {
    const id = String(p.pluginId || p.marketId || "");
    if (id) pluginNames[id] = p.name;
  }

  const clientDocs = await db
    .collection("ci_clients")
    .find({ identity: { $in: [...identityToClass.keys()] } })
    .sort({ lastSeen: -1 })
    .toArray();

  const devices = clientDocs.map((d: any) => {
    const cls: any = identityToClass.get(d.identity);
    const entry = cls ? classExpected.get(String(cls._id)) : undefined;

    const expected = entry ? [...entry.ids] : [];
    const installed: string[] = Array.isArray(d.plugins) ? d.plugins : [];
    const installedSet = new Set(installed);
    const missing = expected.filter((id) => !installedSet.has(id));
    const extra = installed.filter((id) => !expected.includes(id));
    const hasBootstrap = installedSet.has(BOOTSTRAP_PLUGIN_ID);
    const collected = !!d.pluginsUpdatedAt;

    let status = "ok";
    if (!collected) status = "unknown";
    else if (!expected.length) status = "no-expectation";
    else if (!hasBootstrap) status = "no-bootstrap";
    else if (missing.length) status = "missing";

    return {
      cuid: d.cuid,
      identity: d.identity || "",
      className: cls?.name || "",
      online: isOnline(d.cuid),
      status,
      installed,
      installedCount: installed.length,
      expected,
      missing,
      extra,
      hasBootstrap,
      collected,
      pluginsUpdatedAt: d.pluginsUpdatedAt || null,
      profiles: entry?.profiles || [],
    };
  });

  const summary = {
    devices: devices.length,
    online: devices.filter((d) => d.online).length,
    ok: devices.filter((d) => d.status === "ok").length,
    missing: devices.filter((d) => d.status === "missing").length,
    noBootstrap: devices.filter((d) => d.status === "no-bootstrap").length,
    uncollected: devices.filter((d) => d.status === "unknown").length,
    noExpectation: devices.filter((d) => d.status === "no-expectation").length,
  };

  res.json({ code: 0, msg: "ok", data: { devices, summary, pluginNames } });
});

export default router;
