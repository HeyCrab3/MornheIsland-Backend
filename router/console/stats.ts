/**
 * 平台级统计（需 JWT）。
 *
 * 首页要给用户看的「这个平台有多大」：注册用户、班级、资源资产、机构、设备。
 * 这些都是**全站聚合数**，不含任何用户数据，所以对所有登录用户一视同仁地返回。
 *
 * 实现上只做计数，不做聚合查询；每个集合用 estimatedDocumentCount（读元数据，
 * 不扫文档），5 个资源集合 + 班级 + 机构 + 设备一共十几次轻量调用，30 秒内存缓存
 * 一层就够了 —— 首页刷新不会把库压出问题。
 */
import express from "express";
import { isOnline } from "../../grpc/clients";
import { log } from "../../util/log";

const router = express.Router();

/** 缓存时长：首页多开几个标签也不会重复计数 */
const CACHE_MS = 30 * 1000;

interface StatsPayload {
  users: number;
  classes: number;
  schools: number;
  resources: {
    total: number;
    byType: { key: string; label: string; count: number }[];
  };
  devices: { total: number; online: number };
  updatedAt: string;
}

let cache: { at: number; data: StatsPayload } | null = null;

/** 资源集合 → 首页展示用的分类名 */
const RESOURCE_COLLECTIONS: { key: string; label: string; collection: string }[] = [
  { key: "classplan", label: "课表", collection: "ci_classplans" },
  { key: "timelayout", label: "时间表", collection: "ci_timelayouts" },
  { key: "subjects", label: "科目", collection: "ci_subjects" },
  { key: "policy", label: "策略", collection: "ci_policies" },
  { key: "plugin", label: "插件", collection: "ci_plugins" },
  { key: "pluginProfile", label: "插件集合", collection: "ci_plugin_profiles" },
];

/**
 * 计数一律容错：集合可能压根不存在（比如 ci_settings 至今 0 份、从未创建），
 * 统计接口不该因为少一个集合就整体 500。
 */
async function safeCount(db: any, collection: string, filter: any = {}): Promise<number> {
  try {
    if (filter && Object.keys(filter).length > 0) {
      return await db.collection(collection).countDocuments(filter);
    }
    return await db.collection(collection).estimatedDocumentCount();
  } catch (err: any) {
    log("平台统计计数失败 " + collection + "：" + (err?.message || err), "warn", "default");
    return 0;
  }
}

async function collect(db: any): Promise<StatsPayload> {
  // 注册用户只算「真人主账号」：子账户、委托代登录的影子账号都不该计入
  const users = await safeCount(db, "user", {
    isSubAccount: { $ne: true },
    isDelegate: { $ne: true },
  });

  const classes = await safeCount(db, "ci_classes");
  const schools = await safeCount(db, "ci_schools");

  const byType: { key: string; label: string; count: number }[] = [];
  for (const item of RESOURCE_COLLECTIONS) {
    byType.push({
      key: item.key,
      label: item.label,
      count: await safeCount(db, item.collection),
    });
  }
  const total = byType.reduce((sum, item) => sum + item.count, 0);

  // 设备的「在线」以 gRPC 进程内的连接状态为准；库里的 online 字段只作兜底
  let deviceTotal = 0;
  let deviceOnline = 0;
  try {
    const devices = await db
      .collection("ci_clients")
      .find({}, { projection: { cuid: 1, online: 1 } })
      .toArray();
    deviceTotal = devices.length;
    for (const d of devices as any[]) {
      if (isOnline(String(d.cuid)) || d.online === true) deviceOnline += 1;
    }
  } catch (err: any) {
    log("平台统计设备计数失败：" + (err?.message || err), "warn", "default");
  }

  return {
    users,
    classes,
    schools,
    resources: { total, byType },
    devices: { total: deviceTotal, online: deviceOnline },
    updatedAt: new Date().toISOString(),
  };
}

router.get("/v1/console/stats/platform", async (req, res) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return res.json({ code: 0, msg: "ok", data: { ...cache.data, cached: true } });
    }

    const data = await collect(req.db);
    cache = { at: Date.now(), data };
    res.json({ code: 0, msg: "ok", data: { ...data, cached: false } });
  } catch (err: any) {
    log("平台统计失败：" + (err?.message || err), "error", "default");
    res.status(500).json({ code: 500, msg: "统计失败，请稍后再试" });
  }
});

export default router;
