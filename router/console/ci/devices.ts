import express from "express";
import { log } from "../../../util/log";
import { ObjectId } from "mongodb";
import { isOnline } from "../../../grpc/clients";

const router = express.Router();

/** 客户端在静态配置（serverless）模式下会轮询的这些端点 */
const STATIC_PATHS = (id: string) => [
  `/v1/ci/${id}/manifest.json`,
  `/v1/ci/${id}/classplan.json`,
  `/v1/ci/${id}/timelayout.json`,
  `/v1/ci/${id}/subjects.json`,
  `/v1/ci/${id}/settings.json`,
  `/v1/ci/${id}/policy.json`,
];

/** 取当前用户的班级（用于匹配设备） */
async function loadClasses(db: any, userId: ObjectId) {
  return db
    .collection("ci_classes")
    .find({ userId })
    .project({ _id: 1, name: 1, identity: 1 })
    .toArray();
}

/**
 * 静态模式设备：从 request_log 里按 IP 聚合。
 * 这类客户端只轮询清单，服务端拿不到它的 cuid/MAC，只能靠 IP 识别。
 */
async function collectStaticDevices(db: any, classes: any[]) {
  // 同时兼容旧 identity 和新 ObjectId 路径
  const allIds = [
    ...classes.map((c: any) => String(c._id)),
    ...classes.map((c: any) => c.identity).filter(Boolean),
  ];
  if (!allIds.length) return [];

  const rows = await db.collection("request_log").aggregate([
    { $match: { path: { $in: allIds.flatMap((id: string) => STATIC_PATHS(id)) } } },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: "$ip",
        lastSeen: { $first: "$ts" },
        lastPath: { $first: "$path" },
        requestCount: { $sum: 1 },
      },
    },
    { $sort: { lastSeen: -1 } },
  ]).toArray();

  // 从最后请求的路径反查是哪个班，方便和集控设备一样显示班级名
  const byPath = new Map<string, any>();
  for (const c of classes) {
    for (const id of [String(c._id), c.identity].filter(Boolean)) {
      for (const p of STATIC_PATHS(id)) byPath.set(p, c);
    }
  }

  return rows.map((r: any) => {
    const cls: any = byPath.get(r.lastPath);
    return {
      mode: "static" as const,
      ip: r._id,
      className: cls?.name || "",
      identity: cls?.identity || "",
      lastSeen: r.lastSeen,
      lastPath: r.lastPath,
      requestCount: r.requestCount,
    };
  });
}

/**
 * GET /v1/console/ci/devices — 静态配置模式设备（按 IP 识别）
 * 保持原有返回结构，老调用方不受影响。
 */
router.get("/v1/console/ci/devices", async (req, res) => {
  try {
    const db = req.db;
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const classes = await loadClasses(db, new ObjectId(userId));
    if (!classes.length) return res.json({ code: 0, msg: "ok", data: [] });

    const devices = await collectStaticDevices(db, classes);
    // 兼容旧字段：老前端读的是 _id(ip) / lastSeen / lastPath / requestCount
    res.json({
      code: 0,
      msg: "ok",
      data: devices.map((d) => ({
        _id: d.ip,
        lastSeen: d.lastSeen,
        lastPath: d.lastPath,
        requestCount: d.requestCount,
      })),
    });
  } catch (e) {
    log(`[ci/console/devices] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * GET /v1/console/ci/device-overview — 两种接入方式的设备总览
 *
 *  - grpc  ：集控服务器模式。有 cuid / 班级标识 / MAC，在线状态来自命令流，可下发指令。
 *  - static：静态配置模式。客户端按 ManifestUrlTemplate 轮询，只能按 IP 识别，无法下发指令。
 *
 * 两者并存（用户可能一部分班用集控、一部分班用静态清单），所以一起返回、各自标注 mode。
 */
router.get("/v1/console/ci/device-overview", async (req, res) => {
  try {
    const db = req.db;
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const classes = await loadClasses(db, new ObjectId(userId));
    const identityToClass = new Map(
      classes.filter((c: any) => c.identity).map((c: any) => [c.identity, c]),
    );

    // ── 集控（gRPC）──
    const clientDocs = await db
      .collection("ci_clients")
      .find({ identity: { $in: [...identityToClass.keys()] } })
      .sort({ lastSeen: -1 })
      .toArray();

    const grpc = clientDocs.map((d: any) => {
      const cls: any = identityToClass.get(d.identity);
      return {
        mode: "grpc" as const,
        cuid: d.cuid,
        identity: d.identity || "",
        className: cls?.name || "",
        mac: d.mac || "",
        online: isOnline(d.cuid),
        lastSeen: d.lastSeen,
        firstSeen: d.firstSeen,
        plugins: Array.isArray(d.plugins) ? d.plugins : [],
        pluginsUpdatedAt: d.pluginsUpdatedAt || null,
      };
    });

    // ── 静态（serverless）──
    const staticDevices = await collectStaticDevices(db, classes);

    res.json({
      code: 0,
      msg: "ok",
      data: {
        grpc,
        static: staticDevices,
        summary: {
          classes: classes.length,
          grpc: grpc.length,
          grpcOnline: grpc.filter((d) => d.online).length,
          static: staticDevices.length,
          total: grpc.length + staticDevices.length,
        },
      },
    });
  } catch (e) {
    log(`[ci/console/device-overview] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
