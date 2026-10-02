/**
 * ClassIsland 集控 gRPC 服务器。
 *
 * 实现官方客户端依赖的服务：
 *  - ClientRegister.Register / UnRegister
 *  - Handshake.BeginHandshake / CompleteHandshake（Cyrene_MSP PGP 握手）
 *  - ClientCommandDeliver.ListenCommand（双向流，服务端推送命令的主通道）
 *  - Audit.LogEvent / ConfigUpload.UploadConfig（占位实现）
 */
import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";
import { services, encodeMessage } from "./loader";
import { initKeys, getPublicKey, decryptChallenge, createSession, validateSession } from "./auth";
import { upsertClient, removeClient, attachStream, detachStream, touchClient, isOnline, pushCommand, broadcastCommand } from "./clients";
import { log } from "../util/log";
import { config } from "../config";
import { client as mongoClient } from "../util/db";

const RETCODE = {
  Unspecified: 0,
  Success: 200,
  ServerInternalError: 500,
  InvalidRequest: 404,
  HandshakeClientRejected: 1001,
  Registered: 10001,
  ClientNotFound: 10002,
} as const;

export const CMD = {
  Ping: 10,
  Pong: 11,
  RestartApp: 101,
  SendNotification: 102,
  DataUpdated: 103,
  GetClientConfig: 104,
} as const;

function metaString(call: any, key: string): string {
  try {
    const v = call.metadata?.get?.(key);
    return v && v.length ? String(v[0]) : "";
  } catch {
    return "";
  }
}

/** 校验 Cyrene_MSP 协议头（名字必须匹配；session 单独校验） */
function checkProtocol(call: any): { ok: boolean; cuid: string; session: string } {
  const name = metaString(call, "protocol_name");
  const cuid = metaString(call, "cuid");
  const session = metaString(call, "session");
  return { ok: name === "Cyrene_MSP", cuid, session };
}

/**
 * 把客户端注册信息持久化到 MongoDB（cuid ↔ 班级标识 identity）。
 * 客户端注册时还会带着 cuid，HTTP manifest 端点靠它反查班级。
 */
function persistClient(cuid: string, identity: string, mac: string, online: boolean): void {
  try {
    const db = mongoClient.db(config.db_name);
    const set: Record<string, unknown> = { cuid, online, lastSeen: new Date() };
    // 只在有值时才覆盖：客户端重连（握手 + 建流）不会再 Register，
    // 此时从内存取不到 identity/mac，不能把首次注册时记下的值清掉。
    if (identity) set.identity = identity;
    if (mac) set.mac = mac;

    const setOnInsert: Record<string, unknown> = { firstSeen: new Date() };
    if (!identity) setOnInsert.identity = "";
    if (!mac) setOnInsert.mac = "";

    db.collection("ci_clients")
      .updateOne({ cuid }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true })
      .catch(() => { /* 持久化失败不影响连接 */ });
  } catch { /* 忽略 */ }
}

/**
 * 从 ci_clients 反查客户端身份。
 * 重连的客户端不会再 Register，内存条目里取不到 identity/mac，只能回查数据库。
 */
async function hydrateClientIdentity(cuid: string): Promise<{ identity: string; mac: string }> {
  try {
    const db = mongoClient.db(config.db_name);
    const doc: any = await db.collection("ci_clients").findOne({ cuid });
    return { identity: doc?.identity ?? "", mac: doc?.mac ?? "" };
  } catch {
    return { identity: "", mac: "" };
  }
}

function markClientOffline(cuid: string): void {
  // 旧流的 end/error 可能晚于新流到达，此时设备其实在线，不能标记离线。
  if (isOnline(cuid)) return;
  try {
    const db = mongoClient.db(config.db_name);
    db.collection("ci_clients")
      .updateOne({ cuid }, { $set: { online: false, lastSeen: new Date() } })
      .catch(() => {});
  } catch { /* 忽略 */ }
}

// ── ClientRegister ──
const clientRegisterImpl = {
  Register: (call: any, callback: any) => {
    const { ok } = checkProtocol(call);
    if (!ok) return callback(null, { Retcode: RETCODE.InvalidRequest, Message: "protocol mismatch" });
    const { ClientUid, ClientId, ClientMac } = call.request || {};
    if (!ClientUid) return callback(null, { Retcode: RETCODE.InvalidRequest, Message: "missing ClientUid" });
    upsertClient(ClientUid, ClientId, ClientMac);
    persistClient(ClientUid, ClientId, ClientMac, false);
    log(`[grpc] 客户端注册 ${ClientUid} (${ClientId})`, "info", "grpc");
    callback(null, { Retcode: RETCODE.Registered, Message: "ok", ServerPublicKey: getPublicKey() });
  },
  UnRegister: (call: any, callback: any) => {
    const { ClientUid } = call.request || {};
    if (ClientUid) removeClient(ClientUid);
    log(`[grpc] 客户端注销 ${ClientUid}`, "info", "grpc");
    callback(null, { Retcode: RETCODE.Success, Message: "ok", ServerPublicKey: "" });
  },
};

// ── Handshake ──
const handshakeImpl = {
  BeginHandshake: async (call: any, callback: any) => {
    const { ok } = checkProtocol(call);
    if (!ok) return callback(null, { Retcode: RETCODE.InvalidRequest, Message: "protocol mismatch" });
    const { ClientUid, ChallengeTokenEncrypted } = call.request || {};
    try {
      const decrypted = await decryptChallenge(ChallengeTokenEncrypted);
      log(`[grpc] 握手挑战解密成功 ${ClientUid}`, "info", "grpc");
      callback(null, {
        Retcode: RETCODE.Success,
        Message: "ok",
        ChallengeTokenDecrypted: decrypted,
        ServerPublicKey: getPublicKey(),
      });
    } catch (e) {
      log(`[grpc] 握手挑战解密失败 ${ClientUid}: ${e}`, "error", "grpc");
      callback(null, { Retcode: RETCODE.HandshakeClientRejected, Message: "decrypt failed" });
    }
  },
  CompleteHandshake: (call: any, callback: any) => {
    const { ok, cuid } = checkProtocol(call);
    if (!ok) return callback(null, { Retcode: RETCODE.InvalidRequest, Message: "protocol mismatch" });
    const { Accepted } = call.request || {};
    if (!Accepted) return callback(null, { Retcode: RETCODE.HandshakeClientRejected, Message: "client rejected" });
    const sessionId = createSession(cuid);
    log(`[grpc] 握手完成 ${cuid}，会话已建立`, "info", "grpc");
    callback(null, { Retcode: RETCODE.Success, Message: "ok", SessionId: sessionId });
  },
};

// ── ClientCommandDeliver（双向流）──
const commandDeliverImpl = {
  ListenCommand: (call: any) => {
    const { ok, cuid, session } = checkProtocol(call);
    if (!ok || !cuid) {
      call.destroy(new Error("invalid protocol"));
      return;
    }
    if (!validateSession(cuid, session)) {
      log(`[grpc] 命令流会话校验未通过（放行以便联调） ${cuid}`, "error", "grpc");
    }
    const entry = attachStream(cuid, call);
    log(`[grpc] 客户端建立命令流 ${cuid}`, "info", "grpc");

    // 重连的客户端不会再 Register，内存条目可能只有 cuid：
    // 反查 ci_clients 补齐 identity/mac，否则命令流会挂在一个空条目上。
    void hydrateClientIdentity(cuid).then(({ identity, mac }) => {
      if (!entry.clientId && identity) entry.clientId = identity;
      if (!entry.mac && mac) entry.mac = mac;
      // 反查期间客户端可能已断开，别把已离线的设备写成在线。
      persistClient(cuid, entry.clientId, entry.mac, isOnline(cuid));
    });

    call.on("data", (req: any) => {
      if (req?.Type === CMD.Ping) {
        touchClient(cuid);
        call.write({ RetCode: RETCODE.Success, Type: CMD.Pong, Payload: Buffer.alloc(0) });
      }
    });
    const cleanup = () => {
      detachStream(cuid, call);
      markClientOffline(cuid);
    };
    call.on("end", () => {
      cleanup();
      log(`[grpc] 客户端命令流结束 ${cuid}`, "info", "grpc");
      call.end();
    });
    call.on("error", cleanup);
    call.on("cancelled", cleanup);
  },
};

// ── Audit / ConfigUpload ──

/**
 * 已发出、等待客户端回传的配置查询请求（RequestGuid → 等待者）。
 * 客户端拿到命令 104 后，会用 ConfigUpload.UploadConfig 带着 RequestGuidId 把结果送回来。
 */
const pendingConfigRequests = new Map<string, { cuid: string; settle: (payload: string | null) => void }>();

const auditImpl = {
  LogEvent: (_call: any, callback: any) => callback(null, { Retcode: RETCODE.Success, Message: "ok" }),
};

const configUploadImpl = {
  UploadConfig: (call: any, callback: any) => {
    const { RequestGuidId, Payload } = call.request || {};
    const pending = RequestGuidId ? pendingConfigRequests.get(String(RequestGuidId)) : undefined;
    if (pending) pending.settle(String(Payload ?? ""));
    callback(null, { Retcode: RETCODE.Success, Message: "ok" });
  },
};

let grpcServer: grpc.Server | null = null;

/**
 * 进程启动时没有任何在线流，先把遗留的 online 标记清掉。
 * 否则上一次运行（含热重载）留下的 online:true 会与内存状态不一致。
 */
async function resetOnlineFlags(): Promise<void> {
  try {
    const db = mongoClient.db(config.db_name);
    await db.collection("ci_clients").updateMany({ online: true }, { $set: { online: false } });
  } catch { /* 数据库不可用不影响 gRPC 服务启动 */ }
}

export async function startGrpcServer(): Promise<void> {
  await initKeys();
  await resetOnlineFlags();

  const server = new grpc.Server();
  server.addService(services.ClientRegister.service, clientRegisterImpl);
  server.addService(services.Handshake.service, handshakeImpl);
  server.addService(services.ClientCommandDeliver.service, commandDeliverImpl);
  server.addService(services.Audit.service, auditImpl);
  server.addService(services.ConfigUpload.service, configUploadImpl);

  const port = (config as any).grpc_port ?? 20722;

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      log(`[grpc] 集控 gRPC 服务器运行在端口 ${boundPort}`, "info", "grpc");
      resolve();
    });
  });

  grpcServer = server;
}

export function stopGrpcServer(): void {
  grpcServer?.forceShutdown();
  grpcServer = null;
}

// ── 命令推送接口（供 REST 路由调用）──

export function sendNotification(
  cuid: string,
  notif: {
    MessageMask?: string;
    MessageContent: string;
    IsEmergency?: boolean;
    IsSpeechEnabled?: boolean;
    IsEffectEnabled?: boolean;
    IsSoundEnabled?: boolean;
    IsTopmost?: boolean;
    DurationSeconds?: number;
    RepeatCounts?: number;
  },
): boolean {
  const payload = encodeMessage("ClassIsland.Shared.Protobuf.Command.SendNotification", {
    MessageMask: notif.MessageMask ?? "",
    MessageContent: notif.MessageContent,
    IsEmergency: notif.IsEmergency ?? false,
    IsSpeechEnabled: notif.IsSpeechEnabled ?? false,
    IsEffectEnabled: notif.IsEffectEnabled ?? false,
    IsSoundEnabled: notif.IsSoundEnabled ?? false,
    IsTopmost: notif.IsTopmost ?? false,
    DurationSeconds: notif.DurationSeconds ?? 0,
    RepeatCounts: notif.RepeatCounts ?? 1,
  });
  return pushCommand(cuid, CMD.SendNotification, payload);
}

/** 通知客户端重新拉取集控数据（换课 / 配置更新后） */
export function sendDataUpdated(cuid: string): boolean {
  return pushCommand(cuid, CMD.DataUpdated, Buffer.alloc(0));
}

/**
 * 向客户端索取配置（命令 104），等它通过 ConfigUpload 回传，超时返回 null。
 *
 * 这条命令由 ClassIsland 本体处理，**不需要装我们的插件**，
 * 所以查询已装插件列表（ConfigTypes.PluginList）在所有客户端上都可用——
 * 对账时正是靠它判断客户端到底装了什么、以及有没有装引导插件。
 */
export function requestClientConfig(cuid: string, configType: number, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    if (!isOnline(cuid)) return resolve(null);

    const requestGuid = randomUUID();
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (payload: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      pendingConfigRequests.delete(requestGuid);
      resolve(payload);
    };

    timer = setTimeout(() => settle(null), timeoutMs);
    pendingConfigRequests.set(requestGuid, { cuid, settle });

    const payload = encodeMessage("ClassIsland.Shared.Protobuf.Command.GetClientConfig", {
      RequestGuid: requestGuid,
      ConfigType: configType,
    });
    if (!pushCommand(cuid, CMD.GetClientConfig, payload)) settle(null);
  });
}

/** ConfigTypes.PluginList —— 客户端回传已加载插件 id 的 JSON 数组 */
export const CONFIG_TYPE_PLUGIN_LIST = 6;

/**
 * 查询客户端已安装的插件 id 列表。
 * 失败（离线 / 超时 / 返回不是合法 JSON）返回 null，调用方需区分“查不到”和“空列表”。
 */
export async function fetchClientPlugins(cuid: string, timeoutMs = 6000): Promise<string[] | null> {
  const raw = await requestClientConfig(cuid, CONFIG_TYPE_PLUGIN_LIST, timeoutMs);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((x) => String(x));
  } catch {
    return null;
  }
}

/** 引导插件（莫宁岛集控扩展）在客户端 manifest 里的 id */
export const BOOTSTRAP_PLUGIN_ID = "mornheisland.ciplugin";

export function sendRestartApp(cuid: string): boolean {
  return pushCommand(cuid, CMD.RestartApp, Buffer.alloc(0));
}

// ── 自定义命令（莫宁岛扩展，官方 CommandTypes 只到 104）──
export const CMD_CUSTOM = {
  /** 插件分发：payload 为 JSON UTF-8 字节 */
  PluginDeliver: 200,
} as const;

/** 下发插件分发指令（客户端配套插件监听该命令号） */
export function deliverPlugin(cuid: string, payload: Record<string, unknown>): boolean {
  const buf = Buffer.from(JSON.stringify(payload), "utf-8");
  return pushCommand(cuid, CMD_CUSTOM.PluginDeliver, buf);
}

export { broadcastCommand, pushCommand };
