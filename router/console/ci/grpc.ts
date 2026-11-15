/**
 * gRPC 集控指令控制台接口（需 JWT）。
 * 供前端列出在线客户端、推送通知 / 刷新数据 / 重启。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { listClients, clients, isOnline } from "../../../grpc/clients";
import { sendNotification, sendDataUpdated, sendRestartApp, isGrpcListening, getGrpcPort, isGrpcTlsEnabled } from "../../../grpc/server";
import { log } from "../../../util/log";
import { findClass } from "../../../util/ci_public";
import { config } from "../../../config";

const router = express.Router();

function getUserId(req: any): string | null {
  return req.auth?.userId || null;
}

/**
 * 目标作用域统一走 util/grpc_scope（本账号 / 指定设备 / 学校）。
 * 以前这里是本地实现，而 plugin/deliver 又各自写了一套 —— 结果那套的 all
 * 是全进程广播。集中一处才不会再漏。
 */
import { resolveTargets as resolveScopedTargets } from "../../../util/grpc_scope";
import { DEVICE_CAPS, grantedClassIds, type GrantCap } from "../../../util/ci_grant";

async function ownCuidSet(req: any, cap: GrantCap = "device.control"): Promise<Set<string>> {
  const targets = await resolveScopedTargets(req.db, getUserId(req), { all: true }, cap);
  return new Set(targets?.allowed ?? []);
}

async function resolveTargets(
  req: any,
  body: any,
  cap: GrantCap = "device.control",
): Promise<{ allowed: string[]; rejected: string[] } | null> {
  const t = await resolveScopedTargets(req.db, getUserId(req), body, cap);
  if (!t) return null;
  return { allowed: t.allowed, rejected: t.rejected };
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

/** GET /v1/console/ci/grpc/clients — 本账号及有效设备委托范围内已注册的客户端 */
router.get("/v1/console/ci/grpc/clients", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  try {
    const granted = await grantedClassIds(req.db, userId, DEVICE_CAPS);
    const classes = await req.db.collection("ci_classes")
      .find({ $or: [{ userId: new ObjectId(userId) }, { _id: { $in: granted } }] })
      .project({ _id: 1 }).toArray();
    const allowed = new Set(classes.map((c) => String(c._id)));
    if (!allowed.size) return res.json({ code: 0, msg: "ok", data: [] });

    const registered = listClients();
    const docs = await req.db.collection("ci_clients")
      .find({ cuid: { $in: registered.map((c) => c.cuid) } })
      .project({ cuid: 1, classId: 1, identity: 1 }).toArray();
    const byCuid = new Map(docs.map((d) => [d.cuid, d]));
    const resolved = new Map<string, boolean>();
    const data = [];
    for (const entry of registered) {
      const doc = byCuid.get(entry.cuid);
      const classId = String(doc?.classId ?? "");
      // 固定绑定优先；不能因旧 identity 恰好匹配本账号就越过别人的绑定。
      if (classId) {
        if (allowed.has(classId)) data.push(entry);
        continue;
      }
      // 新注册可能尚未持久化；重连时内存标识可能为空。沿用公共解析器，
      // ObjectId 优先，旧 identity 只有全库唯一时才接受，不猜测同名班级。
      const identity = entry.clientId || doc?.identity || "";
      if (!resolved.has(identity)) {
        const cls = await findClass(req.db, identity);
        resolved.set(identity, !!cls && allowed.has(String(cls._id)));
      }
      if (resolved.get(identity)) data.push(entry);
    }
    res.json({ code: 0, msg: "ok", data });
  } catch (e) {
    log(`[grpc/clients] ${e}`, "error", "grpc");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/grpc/notification — 推送大屏通知（支持单个 / 批量 / 本账号全部） */
router.post("/v1/console/ci/grpc/notification", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const {
    cuid, cuids, all,
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

  // 先算出本账号名下的设备，再从中挑目标——绝不广播给全进程
  const own = await ownCuidSet(req, "notify.send");
  let targets: string[] = [];
  if (all) {
    targets = [...own];
  } else if (Array.isArray(cuids) && cuids.length) {
    targets = cuids.map(String);
  } else if (cuid) {
    targets = [String(cuid)];
  } else {
    return res.status(400).json({ code: 400, msg: "需要指定 cuid / cuids 或 all" });
  }

  const rejected = targets.filter((c) => !own.has(c));
  const allowed = targets.filter((c) => own.has(c));

  let sent = 0;
  const failed: string[] = [];
  for (const c of allowed) {
    if (sendNotification(c, notif)) sent++;
    else failed.push(c);
  }

  log(
    `[grpc] 用户 ${userId} 推送通知：目标 ${allowed.length} 台，成功 ${sent} 台` +
      (rejected.length ? `，越权/不属于本账号被忽略 ${rejected.length} 台` : ""),
    "info",
    "grpc",
  );
  res.json({ code: 0, msg: "ok", data: { sent, total: allowed.length, failed, rejected } });
});

/** POST /v1/console/ci/grpc/data-updated — 通知客户端重新拉取集控数据 */
router.post("/v1/console/ci/grpc/data-updated", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const targets = await resolveTargets(req, req.body, "device.control");
  if (!targets) return res.status(400).json({ code: 400, msg: "需要指定 cuid / cuids 或 all" });

  let sent = 0;
  for (const c of targets.allowed) {
    if (sendDataUpdated(c)) sent++;
  }

  log(
    `[grpc] 用户 ${userId} 通知数据刷新：目标 ${targets.allowed.length} 台，成功 ${sent} 台` +
      (targets.rejected.length ? `，忽略非本账号 ${targets.rejected.length} 台` : ""),
    "info",
    "grpc",
  );
  res.json({ code: 0, msg: "ok", data: { sent, total: targets.allowed.length, rejected: targets.rejected } });
});

/** POST /v1/console/ci/grpc/restart — 让客户端重启 */
router.post("/v1/console/ci/grpc/restart", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const targets = await resolveTargets(req, req.body, "device.restart");
  if (!targets) return res.status(400).json({ code: 400, msg: "需要指定 cuid / cuids 或 all" });

  let sent = 0;
  for (const c of targets.allowed) {
    if (sendRestartApp(c)) sent++;
  }

  log(
    `[grpc] 用户 ${userId} 下发重启：目标 ${targets.allowed.length} 台，成功 ${sent} 台` +
      (targets.rejected.length ? `，忽略非本账号 ${targets.rejected.length} 台` : ""),
    "info",
    "grpc",
  );
  res.json({ code: 0, msg: "ok", data: { sent, total: targets.allowed.length, rejected: targets.rejected } });
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

