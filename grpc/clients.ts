/**
 * 客户端注册表 + 命令下发通道（ListenCommand 双向流）管理。
 */
import type * as grpc from "@grpc/grpc-js";

export interface ClientEntry {
  cuid: string; // 客户端 GUID
  clientId: string; // 班级标识
  mac: string;
  stream?: grpc.ServerDuplexStream<any, any>; // ListenCommand 的响应流
  lastSeen: number;
  registeredAt: number;
}

export const clients = new Map<string, ClientEntry>();

export function upsertClient(cuid: string, clientId: string, mac: string): ClientEntry {
  let c = clients.get(cuid);
  if (!c) {
    c = { cuid, clientId, mac, lastSeen: Date.now(), registeredAt: Date.now() };
    clients.set(cuid, c);
  } else {
    if (clientId) c.clientId = clientId;
    if (mac) c.mac = mac;
    c.lastSeen = Date.now();
  }
  return c;
}

export function removeClient(cuid: string): void {
  clients.delete(cuid);
}

/**
 * 绑定 ListenCommand 响应流。
 * 客户端重连只做握手 + 建流、不会再调用 Register，内存里可能还没有条目，
 * 所以这里必须能自建条目；否则流会被静默丢弃，设备永远显示离线。
 */
export function attachStream(cuid: string, stream: any): ClientEntry {
  let c = clients.get(cuid);
  if (!c) {
    c = { cuid, clientId: "", mac: "", lastSeen: Date.now(), registeredAt: Date.now() };
    clients.set(cuid, c);
  }
  c.stream = stream;
  c.lastSeen = Date.now();
  return c;
}

/**
 * 解绑响应流。传入 stream 时只解绑自己那一条：
 * 客户端重连时旧流的 end/error 事件可能晚于新流到达，
 * 不加判断会把刚建立的新流一并抹掉，造成设备假离线。
 */
export function detachStream(cuid: string, stream?: any): void {
  const c = clients.get(cuid);
  if (!c) return;
  if (stream && c.stream && c.stream !== stream) return;
  c.stream = undefined;
}

/** 收到客户端心跳时刷新活跃时间 */
export function touchClient(cuid: string): void {
  const c = clients.get(cuid);
  if (c) c.lastSeen = Date.now();
}

export function isOnline(cuid: string): boolean {
  return !!clients.get(cuid)?.stream;
}

/** 向指定客户端推送一个命令帧 */
export function pushCommand(cuid: string, type: number, payload: Buffer): boolean {
  const c = clients.get(cuid);
  if (!c?.stream) return false;
  try {
    c.stream.write({ RetCode: 200, Type: type, Payload: payload });
    return true;
  } catch {
    return false;
  }
}

/** 向所有在线客户端广播命令，返回成功数量 */
export function broadcastCommand(type: number, payload: Buffer): number {
  let n = 0;
  for (const cuid of clients.keys()) {
    if (pushCommand(cuid, type, payload)) n++;
  }
  return n;
}

/** 供控制台展示的客户端快照 */
export function listClients() {
  return Array.from(clients.values()).map((c) => ({
    cuid: c.cuid,
    clientId: c.clientId,
    mac: c.mac,
    online: !!c.stream,
    lastSeen: c.lastSeen,
    registeredAt: c.registeredAt,
  }));
}
