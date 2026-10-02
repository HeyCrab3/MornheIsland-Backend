/**
 * 加载 ClassIsland 集控 gRPC proto 定义。
 * proto 里的 import 形如 "Protobuf/Server/..."，所以根目录指向 proto/。
 *
 * 同时提供 protobufjs root，用于把命令消息（如 SendNotification）编码成 bytes payload。
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_ROOT = path.join(__dirname, "proto");

const SERVICE_FILES_REL = [
  "Protobuf/Service/ClientRegister.proto",
  "Protobuf/Service/Handshake.proto",
  "Protobuf/Service/ClientCommandDeliver.proto",
  "Protobuf/Service/Audit.proto",
  "Protobuf/Service/ConfigUpload.proto",
];
const SERVICE_FILES = SERVICE_FILES_REL.map((p) => path.join(PROTO_ROOT, p));

const packageDefinition = protoLoader.loadSync(SERVICE_FILES, {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
});

export const proto = grpc.loadPackageDefinition(packageDefinition) as any;

/** ClassIsland.Shared.Protobuf.Service 下的服务集合 */
export const services = proto.ClassIsland.Shared.Protobuf.Service;

// ── protobufjs（用于命令 payload 编码）──
const root = new protobuf.Root();
root.resolvePath = (_origin: string, target: string) =>
  path.isAbsolute(target) ? target : path.join(PROTO_ROOT, target);
// 命令负载消息（SendNotification 等）不在 Service 的 import 链里，需显式加载
root.loadSync(
  [
    ...SERVICE_FILES_REL,
    "Protobuf/Command/SendNotification.proto",
    "Protobuf/Command/GetClientConfig.proto",
    "Protobuf/Command/HeartBeat.proto",
  ],
  { keepCase: true },
);

/** 把命令消息对象编码成 protobuf bytes（作为命令帧的 Payload） */
export function encodeMessage(typeName: string, obj: Record<string, unknown>): Buffer {
  const T = root.lookupType(typeName);
  const err = T.verify(obj);
  if (err) throw new Error(`消息校验失败: ${err}`);
  return Buffer.from(T.encode(T.create(obj)).finish());
}
