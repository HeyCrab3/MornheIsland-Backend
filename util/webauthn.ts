import crypto from "node:crypto";

/**
 * 通行密钥（WebAuthn / Passkey）的服务端实现，零依赖。
 *
 * 为什么零依赖：这段代码要能直接扔到现有容器里跑，多一个包就多一次
 * `npm install` 和一次版本对齐；而 WebAuthn 校验真正用到的只有
 * 「CBOR 解一层 + COSE 公钥转 SPKI + 验个签名」，Node 自带的 crypto 够用。
 *
 * 安全边界（明确写下来，免得以后自己看错）：
 *  - 我们**不校验认证器证明链**（attestation）。它回答的是「这台认证器是不是某厂
 *    生产的」，对「证明你是账号主人」没有帮助，反而要维护一堆根证书。
 *  - 我们校验：挑战码一次一用、来源域名、rpIdHash、用户在场标志、签名、
 *    以及签名计数器不回退（防克隆认证器）。
 */

export const WEBAUTHN_CREDENTIALS = "webauthn_credentials";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CREDENTIALS_PER_USER = 10;

export type ChallengePurpose = "register" | "login";

interface ChallengeRec {
  userId: string;
  purpose: ChallengePurpose;
  at: number;
  rpId: string;
}

const challenges = new Map<string, ChallengeRec>();

function pruneChallenges() {
  const now = Date.now();
  for (const [k, v] of challenges) if (now - v.at > CHALLENGE_TTL_MS) challenges.delete(k);
}

export function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(String(s || ""), "base64url");
}

/**
 * 发一个挑战码。挑战码就是这次握手的「会话」，浏览器把它原样放进
 * clientDataJSON，我们回来看它对不对 —— 不对就说明这次请求是重放的。
 */
export function issueChallenge(userId: string, purpose: ChallengePurpose, rpId: string): string {
  pruneChallenges();
  const challenge = crypto.randomBytes(32).toString("base64url");
  challenges.set(challenge, { userId: String(userId), purpose, at: Date.now(), rpId });
  return challenge;
}

/** 取走挑战码（一次性）。用途和账号都要对上，否则视为无效。 */
export function consumeChallenge(
  challenge: string,
  purpose: ChallengePurpose,
  userId: string,
): ChallengeRec | null {
  pruneChallenges();
  const key = String(challenge || "");
  const hit = key ? challenges.get(key) : null;
  if (!hit) return null;
  if (hit.purpose !== purpose) return null;
  if (String(userId || "") && hit.userId !== String(userId)) return null;
  challenges.delete(key);
  return hit;
}

/**
 * 从请求里推出 rpId 与 origin。
 *
 * rpId 决定了「哪个域名下的通行密钥能用」，必须和浏览器里注册时的域名一致，
 * 否则 sha256(rpId) 对不上 authData 里的 rpIdHash，验签直接失败。
 * 允许用环境变量覆盖（反向代理把 Host 改掉、或者域名迁移时用）。
 */
export function rpFromReq(req: any): { rpId: string; origin: string } {
  const envRp = String(process.env.WEBAUTHN_RP_ID || "").trim();
  const envOrigin = String(process.env.WEBAUTHN_ORIGIN || "").trim();
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "")
    .split(",")[0]
    .trim();
  const proto = String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "https")
    .split(",")[0]
    .trim();

  // 关键：不能用 Host 头来推 rpId。
  // 请求经过反向代理（线上 nginx）或开发代理（nuxt 把 /api 转给 127.0.0.1:7000）之后，
  // Host 往往已经变成后端自己，从它推出的 rpId 会和浏览器页面域名对不上，
  // 浏览器就会直接拒绝：「The relying party ID is not a registrable domain suffix of,
  // nor equal to the current domain」。
  // 前端拦截器每个请求都会带 X-Client-Origin（= window.location.origin），
  // 它不经过代理改写；再退到浏览器自己发的 Origin，其次 Referer。
  const clientOrigin = String(req?.headers?.["x-client-origin"] || "").trim();
  const originHeader = String(req?.headers?.origin || "").trim();
  const referer = String(req?.headers?.referer || "").trim();
  let browserOrigin = "";
  for (const raw of [clientOrigin, originHeader]) {
    if (!raw || raw === "null") continue;
    try {
      browserOrigin = new URL(raw).origin;
      break;
    } catch {
      /* 忽略不合法的来源 */
    }
  }
  if (!browserOrigin && referer) {
    try {
      browserOrigin = new URL(referer).origin;
    } catch {
      browserOrigin = "";
    }
  }

  const fallbackOrigin = host ? `${proto}://${host}` : "https://localhost";
  const origin = envOrigin || browserOrigin || fallbackOrigin;

  let rpId = envRp;
  if (!rpId) {
    try {
      rpId = new URL(origin).hostname; // 去掉端口，rpId 只能是域名
    } catch {
      rpId = "localhost";
    }
  }
  return { rpId, origin };
}

/**
 * 可选的来源白名单（WEBAUTHN_ORIGINS，逗号分隔）。
 * 不配置时接受任何来源：绑定必须已登录、断言必须持有对应私钥，
 * 所以「来源由客户端自述」不会让攻击者冒充别人。
 * 配置后则只接受列表内的来源，适合想额外收紧的部署。
 */
export function originAllowed(origin: string): boolean {
  const raw = String(process.env.WEBAUTHN_ORIGINS || "").trim();
  if (!raw) return true;
  const list = raw
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.includes(origin.replace(/\/+$/, ""));
}

/* ------------------------------------------------------------------ *
 * CBOR：只解 WebAuthn 用到的那几种类型
 * ------------------------------------------------------------------ */

function readUint(buf: Buffer, offset: number, addl: number): { value: number; offset: number } {
  if (addl < 24) return { value: addl, offset };
  if (addl === 24) return { value: buf.readUInt8(offset), offset: offset + 1 };
  if (addl === 25) return { value: buf.readUInt16BE(offset), offset: offset + 2 };
  if (addl === 26) return { value: buf.readUInt32BE(offset), offset: offset + 4 };
  if (addl === 27) {
    const big = buf.readBigUInt64BE(offset);
    return { value: Number(big), offset: offset + 8 };
  }
  throw new Error("CBOR 长度字段不支持");
}

/** 递归解码一个 CBOR 值。Map 保留键的原始类型（COSE 公钥的键是数字）。 */
export function cborDecode(buf: Buffer, offset = 0): { value: any; offset: number } {
  if (offset >= buf.length) throw new Error("CBOR 数据不完整");
  const head = buf.readUInt8(offset);
  const major = head >> 5;
  const addl = head & 0x1f;
  offset += 1;

  if (major === 0) {
    const r = readUint(buf, offset, addl);
    return { value: r.value, offset: r.offset };
  }
  if (major === 1) {
    const r = readUint(buf, offset, addl);
    return { value: -1 - r.value, offset: r.offset };
  }
  if (major === 2) {
    const r = readUint(buf, offset, addl);
    const end = r.offset + r.value;
    return { value: buf.subarray(r.offset, end), offset: end };
  }
  if (major === 3) {
    const r = readUint(buf, offset, addl);
    const end = r.offset + r.value;
    return { value: buf.subarray(r.offset, end).toString("utf8"), offset: end };
  }
  if (major === 4) {
    const r = readUint(buf, offset, addl);
    let cur = r.offset;
    const arr: any[] = [];
    for (let i = 0; i < r.value; i++) {
      const item = cborDecode(buf, cur);
      arr.push(item.value);
      cur = item.offset;
    }
    return { value: arr, offset: cur };
  }
  if (major === 5) {
    const r = readUint(buf, offset, addl);
    let cur = r.offset;
    const map = new Map<any, any>();
    for (let i = 0; i < r.value; i++) {
      const k = cborDecode(buf, cur);
      const v = cborDecode(buf, k.offset);
      map.set(k.value, v.value);
      cur = v.offset;
    }
    return { value: map, offset: cur };
  }
  if (major === 6) {
    // 标签：WebAuthn 里没有语义，跳过标签本身接着读
    const r = readUint(buf, offset, addl);
    return cborDecode(buf, r.offset);
  }
  // major 7：简单值与浮点
  if (addl === 20) return { value: false, offset };
  if (addl === 21) return { value: true, offset };
  if (addl === 22) return { value: null, offset };
  if (addl === 23) return { value: undefined, offset };
  if (addl === 26) return { value: buf.readFloatBE(offset), offset: offset + 4 };
  if (addl === 27) return { value: buf.readDoubleBE(offset), offset: offset + 8 };
  const r = readUint(buf, offset, addl);
  return { value: r.value, offset: r.offset };
}

/* ------------------------------------------------------------------ *
 * COSE 公钥 → SPKI DER
 * ------------------------------------------------------------------ */

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSeq(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}

function derInt(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let body = buf.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02]), derLen(body.length), body]);
}

function derBitString(buf: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0]), buf]);
  return Buffer.concat([Buffer.from([0x03]), derLen(body.length), body]);
}

/**
 * COSE_Key → SPKI DER。
 * 支持 ES256(-7, P-256) 与 RS256(-257)，这两种覆盖了 Windows Hello、
 * iOS/macOS 钥匙串、Android GPM 和各家硬件密钥。
 * Ed25519(-8) 的 SPKI 前缀不同，暂不支持：认不出的算法在注册时就拒掉，
 * 好过存进去然后在登录时莫名失败。
 */
export function coseToSpki(cose: Map<any, any>): { der: Buffer; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3);

  if (kty === 2 && alg === -7) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
      throw new Error("不支持的 EC 公钥");
    }
    if (x.length !== 32 || y.length !== 32) throw new Error("EC 公钥长度不对");
    const prefix = Buffer.from(
      "3059301306072a8648ce3d020106082a8648ce3d030107034200",
      "hex",
    );
    return { der: Buffer.concat([prefix, Buffer.from([0x04]), x, y]), alg };
  }

  if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error("不支持的 RSA 公钥");
    const rsaKey = derSeq(derInt(n), derInt(e));
    const rsaAlgId = derSeq(
      Buffer.from("06092a864886f70d010101", "hex"),
      Buffer.from("0500", "hex"),
    );
    return { der: derSeq(rsaAlgId, derBitString(rsaKey)), alg };
  }

  throw new Error("不支持的通行密钥算法（仅 ES256 / RS256）");
}

/**
 * ES256 的签名：WebAuthn 规范要求是 ASN.1 DER 编码的 ECDSA 签名
 * （认证器实际发回来的就是这个，长度约 70~72 字节）。
 * 但裸 r||s（固定 64 字节）在某些实现和自测里也会出现，两种都接受。
 */
function sigToDer(sig: Buffer): Buffer {
  if (sig.length === 64) {
    return derSeq(derInt(sig.subarray(0, 32)), derInt(sig.subarray(32, 64)));
  }
  // 已经是 DER：0x30 + 短格式长度，且长度自洽
  if (sig.length > 8 && sig[0] === 0x30 && sig[1] === sig.length - 2) {
    return sig;
  }
  // 长格式长度（>127 字节）理论上 ECDSA 用不到，但别让它在别处炸
  if (sig.length > 8 && sig[0] === 0x30 && sig[1] === 0x81 && sig[2] === sig.length - 3) {
    return sig;
  }
  throw new Error(`签名格式无法识别（${sig.length} 字节）`);
}

/* ------------------------------------------------------------------ *
 * authData / clientData
 * ------------------------------------------------------------------ */

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  aaguid?: string;
  credentialId?: Buffer;
  coseKey?: Map<any, any>;
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new Error("认证数据不完整");
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf.readUInt8(32);
  const signCount = buf.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, signCount };

  const AT = 0x40;
  if (flags & AT) {
    if (buf.length < 55) throw new Error("认证数据缺少公钥");
    out.aaguid = buf.subarray(37, 53).toString("hex");
    const credIdLen = buf.readUInt16BE(53);
    const credId = buf.subarray(55, 55 + credIdLen);
    if (credId.length !== credIdLen) throw new Error("凭据 ID 长度不对");
    out.credentialId = credId;
    const key = cborDecode(buf, 55 + credIdLen);
    if (!(key.value instanceof Map)) throw new Error("公钥不是 COSE 映射");
    out.coseKey = key.value as Map<any, any>;
  }
  return out;
}

export function parseClientData(json: Buffer): any {
  try {
    return JSON.parse(json.toString("utf8"));
  } catch {
    throw new Error("客户端数据不是合法 JSON");
  }
}

/** authData 里的 rpIdHash 必须等于 sha256(rpId)，否则说明这把钥匙是给别的域名注册的 */
export function checkRpId(authData: AuthData, rpId: string) {
  const hash = crypto.createHash("sha256").update(rpId).digest();
  if (!crypto.timingSafeEqual(hash, authData.rpIdHash)) {
    throw new Error("通行密钥的域名不匹配");
  }
}

export function checkClientData(
  client: any,
  expectType: string,
  expectChallenge: string,
  expectOrigin: string,
) {
  if (!client || typeof client !== "object") throw new Error("客户端数据格式不对");
  if (client.type !== expectType) throw new Error("客户端数据类型不对");
  if (String(client.challenge || "") !== String(expectChallenge)) {
    throw new Error("挑战码不匹配，请重试");
  }
  const origin = String(client.origin || "");
  if (origin !== expectOrigin) throw new Error(`来源域名不匹配（${origin}）`);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

export interface RegistrationInput {
  rpId: string;
  origin: string;
  expectedChallenge: string;
  /** 前端 base64url 后的 attestationObject */
  attestationObject: string;
  /** 前端 base64url 后的 clientDataJSON */
  clientDataJSON: string;
}

export interface SavedCredential {
  credentialId: string;
  publicKey: string;
  alg: number;
  counter: number;
  rpId: string;
  aaguid?: string;
  transports?: string[];
}

/** 校验注册结果，返回可以落库的凭据 */
export function verifyRegistration(input: RegistrationInput): SavedCredential {
  const attRaw = fromB64u(input.attestationObject);
  const clientRaw = fromB64u(input.clientDataJSON);

  const client = parseClientData(clientRaw);
  checkClientData(client, "webauthn.create", input.expectedChallenge, input.origin);

  const att = cborDecode(attRaw).value;
  if (!(att instanceof Map)) throw new Error("证明对象格式不对");
  const authRaw = att.get("authData");
  if (!Buffer.isBuffer(authRaw)) throw new Error("证明对象里没有认证数据");

  const auth = parseAuthData(authRaw);
  checkRpId(auth, input.rpId);
  if (!(auth.flags & 0x01)) throw new Error("认证器未确认用户在场");
  if (!auth.credentialId) throw new Error("认证器没有提供凭据 ID");
  if (!auth.coseKey) throw new Error("认证器没有提供公钥");

  // 只做「解出来、转得动」，不校验证书链
  const { der, alg } = coseToSpki(auth.coseKey);
  const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" && key.asymmetricKeyType !== "rsa") {
    throw new Error("公钥类型不支持");
  }

  return {
    credentialId: b64u(auth.credentialId),
    publicKey: b64u(der),
    alg,
    counter: auth.signCount,
    rpId: input.rpId,
    aaguid: auth.aaguid,
  };
}

export interface AssertionInput {
  rpId: string;
  origin: string;
  expectedChallenge: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  /** 库里存的凭据 */
  credential: { publicKey: string; alg: number; counter: number };
}

/** 校验一次登录/复核断言 */
export function verifyAssertion(input: AssertionInput): { newCounter: number } {
  const authRaw = fromB64u(input.authenticatorData);
  const clientRaw = fromB64u(input.clientDataJSON);
  const sigRaw = fromB64u(input.signature);

  const client = parseClientData(clientRaw);
  checkClientData(client, "webauthn.get", input.expectedChallenge, input.origin);

  const auth = parseAuthData(authRaw);
  checkRpId(auth, input.rpId);
  if (!(auth.flags & 0x01)) throw new Error("认证器未确认用户在场");

  const spki = fromB64u(input.credential.publicKey);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const signedData = Buffer.concat([
    authRaw,
    crypto.createHash("sha256").update(clientRaw).digest(),
  ]);

  let sig = sigRaw;
  if (input.credential.alg === -7) sig = sigToDer(sigRaw);

  const ok =
    input.credential.alg === -7
      ? crypto.verify("sha256", signedData, { key, dsaEncoding: "der" }, sig)
      : crypto.verify("sha256", signedData, key, sig);
  if (!ok) throw new Error("签名校验失败");

  const prev = Number(input.credential.counter) || 0;
  const next = Number(auth.signCount) || 0;
  // 计数器都为 0 说明认证器不支持计数，这时没法判克隆，只能放行
  if (prev > 0 && next > 0 && next <= prev) {
    throw new Error("签名计数器异常，这把通行密钥可能被复制过");
  }

  return { newCounter: next };
}

/* ------------------------------------------------------------------ *
 * 落库
 * ------------------------------------------------------------------ */

export interface WebauthnCredentialDoc extends SavedCredential {
  _id?: any;
  userId: string;
  name: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
}

export async function listCredentials(db: any, userId: string): Promise<WebauthnCredentialDoc[]> {
  return db
    .collection(WEBAUTHN_CREDENTIALS)
    .find({ userId: String(userId) })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function countCredentials(db: any, userId: string): Promise<number> {
  return db.collection(WEBAUTHN_CREDENTIALS).countDocuments({ userId: String(userId) });
}

export async function findCredential(db: any, userId: string, credentialId: string) {
  return db
    .collection(WEBAUTHN_CREDENTIALS)
    .findOne({ userId: String(userId), credentialId: String(credentialId) });
}

/** 登录时还不知道是谁：按凭据 ID 反查（凭据 ID 本身就是随机数，猜不到） */
export async function findCredentialById(db: any, credentialId: string) {
  return db.collection(WEBAUTHN_CREDENTIALS).findOne({ credentialId: String(credentialId) });
}

export async function saveCredential(db: any, userId: string, cred: SavedCredential, name: string) {
  const now = new Date();
  await db.collection(WEBAUTHN_CREDENTIALS).insertOne({
    userId: String(userId),
    credentialId: cred.credentialId,
    publicKey: cred.publicKey,
    alg: cred.alg,
    counter: cred.counter,
    rpId: cred.rpId,
    aaguid: cred.aaguid || "",
    name: String(name || "通行密钥").slice(0, 30),
    createdAt: now,
    lastUsedAt: null,
  });
}

export async function touchCredential(db: any, credentialId: string, counter: number) {
  await db
    .collection(WEBAUTHN_CREDENTIALS)
    .updateOne(
      { credentialId: String(credentialId) },
      { $set: { counter, lastUsedAt: new Date() } },
    );
}

export async function deleteCredential(db: any, userId: string, id: string) {
  const { ObjectId } = await import("mongodb");
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : null;
  if (!_id) return false;
  const r = await db
    .collection(WEBAUTHN_CREDENTIALS)
    .deleteOne({ _id, userId: String(userId) });
  return r.deletedCount > 0;
}

export async function deleteAllCredentials(db: any, userId: string) {
  await db.collection(WEBAUTHN_CREDENTIALS).deleteMany({ userId: String(userId) });
}
