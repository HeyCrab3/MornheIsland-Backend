/**
 * Cyrene_MSP 认证：PGP 挑战握手 + 会话管理。
 *
 * 流程（对接官方 ClassIsland 客户端）：
 *  1. Register          → 服务器返回 PGP 公钥（armored），客户端缓存
 *  2. BeginHandshake    → 客户端用公钥加密随机 challenge；服务器用私钥解密并回传明文
 *  3. CompleteHandshake → 客户端校验明文一致后 Accepted；服务器建立 session
 */
import * as openpgp from "openpgp";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { log } from "../util/log";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, ".server-keys.json");

interface KeyPair {
  publicKey: string; // armored
  privateKey: string; // armored
}

let keyPair: KeyPair | null = null;

/** 加载或生成服务器 PGP 密钥对（持久化，保证客户端缓存的公钥长期有效） */
export async function initKeys(): Promise<void> {
  if (existsSync(KEY_FILE)) {
    try {
      keyPair = JSON.parse(readFileSync(KEY_FILE, "utf-8")) as KeyPair;
      log("[grpc] 已加载服务器 PGP 密钥对", "info", "grpc");
      return;
    } catch {
      log("[grpc] 密钥文件损坏，重新生成", "error", "grpc");
    }
  }
  const { publicKey, privateKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ name: "MornheIsland", email: "noreply@mornheisland.local" }],
    format: "armored",
  });
  keyPair = { publicKey, privateKey };
  writeFileSync(KEY_FILE, JSON.stringify(keyPair), "utf-8");
  log("[grpc] 已生成新的服务器 PGP 密钥对", "info", "grpc");
}

export function getPublicKey(): string {
  if (!keyPair) throw new Error("PGP 密钥尚未初始化");
  return keyPair.publicKey;
}

/** 用服务器私钥解密客户端提交的 challenge，返回明文 */
export async function decryptChallenge(encrypted: string): Promise<string> {
  if (!keyPair) throw new Error("PGP 密钥尚未初始化");
  const privateKey = await openpgp.readPrivateKey({ armoredKey: keyPair.privateKey });

  // 客户端可能提交 armored 文本或 base64 二进制，两种都兼容
  let message: openpgp.Message<string>;
  try {
    message = await openpgp.readMessage({ armoredMessage: encrypted });
  } catch {
    message = await openpgp.readMessage({
      binaryMessage: Buffer.from(encrypted, "base64"),
    });
  }

  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
  });
  return typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf-8");
}

// ── 会话管理 ──
const sessions = new Map<string, string>(); // cuid → sessionId

export function createSession(cuid: string): string {
  const sessionId = randomUUID().replace(/-/g, "") + randomBytes(8).toString("hex");
  sessions.set(cuid, sessionId);
  return sessionId;
}

export function getSession(cuid: string): string | undefined {
  return sessions.get(cuid);
}

export function validateSession(cuid: string, session: string): boolean {
  const s = sessions.get(cuid);
  return !!s && !!session && s === session;
}
