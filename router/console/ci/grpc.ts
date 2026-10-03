/**
 * gRPC 集控指令控制台接口（需 JWT）。
 * 供前端列出在线客户端、推送通知 / 刷新数据 / 重启。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { listClients, clients, isOnline } from "../../../grpc/clients";
import { sendNotification, sendDataUpdated, sendRestartApp, isGrpcListening, getGrpcPort, isGrpcTlsEnabled } from "../../../grpc/server";
import { log } from "../../../util/log";
import { config } from "../../../config";

const router = express.Router();

function getUserId(req: any): string | null {
  return req.auth?.userId || null;
}

/**
 * GET /v1/console/ci/grpc/endpoint — 下发给客户端的 gRPC 地址与服务器自检信息
 *
 * configured 为空表示没在 config.public_grpc_address 里显式配置，
 * 前端会退回「控制台域名 + port」推断——那只在客户端能直连该端口时成立。
 * 注意这里不推断主机名：后端经过反代，看到的 Host 是内网地址，推不出对外域名。
 */
router.get("/v1/console/ci/grpc/endpoint", (req, res) => {
  if (!getUserId(req)) return res.status(401).json({ code: 401, msg: "请先登录" });

  const configured = String(config.public_grpc_address || "").trim().replace(/\/+$/, "");
  const tls = isGrpcTlsEnabled();
  // scheme 与实际监听方式必须一致，不一致客户端必然连不上，这里直接暴露出来让界面能提示
  const schemeMismatch =
    !!configured && (tls ? configured.startsWith("http://") : configured.startsWith("https://"));

  res.json({
    code: 0,
    msg: "ok",
    data: {
      listening: isGrpcListening(),
      port: getGrpcPort(),
      configured,
      isConfigured: !!configured,
      tls,
      schemeMismatch,
      managedServerKind: 1,
    },
  });
});

/** GET /v1/console/ci/grpc/clients — 已注册的 gRPC 客户端 */
router.get("/v1/console/ci/grpc/clients", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  res.json({ code: 0, msg: "ok", data: listClients() });
});

/** POST /v1/console/ci/grpc/notification — 推送大屏通知 */
router.post("/v1/console/ci/grpc/notification", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const {
    cuid, all,
    messageContent, messageMask,
    isEmergency, isSpeechEnabled, isSoundEnabled, isTopmost,
    durationSeconds, repeatCounts,
  } = req.body || {};

  if (!messageContent) return res.status(400).json({ code: 400, msg: "缺少通知内容" });

  const notif = {
    MessageContent: String(messageContent),
    MessageMask: messageMask ? String(messageMask) : "",
    IsEmergency: !!isEmergency,
    IsSpeechEnabled: !!isSpeechEnabled,
    IsSoundEnabled: !!isSoundEnabled,
    IsTopmost: !!isTopmost,
    DurationSeconds: Number(durationSeconds) || 0,
    RepeatCounts: Number(repeatCounts) || 1,
  };

  let sent = 0;
  if (all) {
    for (const c of clients.keys()) {
      if (sendNotification(c, notif)) sent++;
    }
  } else if (cuid) {
    if (sendNotification(String(cuid), notif)) sent = 1;
  } else {
    return res.status(400).json({ code: 400, msg: "需要指定 cuid 或 all" });
  }

  log(`[grpc] 用户 ${userId} 推送通知，成功 ${sent} 台`, "info", "grpc");
  res.json({ code: 0, msg: "ok", data: { sent } });
});

/** POST /v1/console/ci/grpc/data-updated — 通知客户端重新拉取集控数据 */
router.post("/v1/console/ci/grpc/data-updated", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { cuid, all } = req.body || {};
  let sent = 0;
  if (all) {
    for (const c of clients.keys()) {
      if (sendDataUpdated(c)) sent++;
    }
  } else if (cuid) {
    if (sendDataUpdated(String(cuid))) sent = 1;
  } else {
    return res.status(400).json({ code: 400, msg: "需要指定 cuid 或 all" });
  }

  log(`[grpc] 用户 ${userId} 通知数据刷新，成功 ${sent} 台`, "info", "grpc");
  res.json({ code: 0, msg: "ok", data: { sent } });
});

/** POST /v1/console/ci/grpc/restart — 让客户端重启 */
router.post("/v1/console/ci/grpc/restart", (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { cuid, all } = req.body || {};
  let sent = 0;
  if (all) {
    for (const c of clients.keys()) {
      if (sendRestartApp(c)) sent++;
    }
  } else if (cuid) {
    if (sendRestartApp(String(cuid))) sent = 1;
  } else {
    return res.status(400).json({ code: 400, msg: "需要指定 cuid 或 all" });
  }

  log(`[grpc] 用户 ${userId} 下发重启，成功 ${sent} 台`, "info", "grpc");
  res.json({ code: 0, msg: "ok", data: { sent } });
});

/**
 * GET /v1/console/ci/clients — 基于 gRPC 的真实设备列表。
 * 相比基于 IP 的设备追踪，这里用客户端 GUID(cuid) + 班级标识 + MAC 定位设备，
 * 在线状态由命令流连接实时反映。
 */
router.get("/v1/console/ci/clients", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const db = req.db;
  const uid = new ObjectId(userId);

  // 该用户的班级（identity → 班级）
  const classes = await db
    .collection("ci_classes")
    .find({ userId: uid })
    .project({ identity: 1, name: 1 })
    .toArray();
  const classMap = new Map(classes.map((c: any) => [c.identity, c]));

  const docs = await db.collection("ci_clients").find({}).sort({ lastSeen: -1 }).toArray();
  const data = docs
    .filter((d: any) => classMap.has(d.identity))
    .map((d: any) => {
      const cls: any = classMap.get(d.identity);
      return {
        cuid: d.cuid,
        identity: d.identity,
        className: cls?.name || "",
        classId: String(cls?._id || ""),
        mac: d.mac || "",
        online: isOnline(d.cuid),
        lastSeen: d.lastSeen,
        firstSeen: d.firstSeen,
        // 命令 104 采集到的已装插件（可能过期，看 pluginsUpdatedAt）
        plugins: Array.isArray(d.plugins) ? d.plugins : [],
        pluginsUpdatedAt: d.pluginsUpdatedAt || null,
      };
    });

  res.json({ code: 0, msg: "ok", data });
});

export default router;
