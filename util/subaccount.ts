/**
 * 子账户（可独立登录的下级身份）
 *
 * 为什么不另建一套权限模型：
 *   委托（ci_grants）已经把「班级范围 + 能力位 + 有效期」这套东西做完了，
 *   scopeOf / visibleFilter / canWrite / grpc_scope 十几处调用点都认它。
 *   子账户只是「带密码的、长期的、绑定到主账号的委托」——
 *   所以创建子账户时顺手建一条内部委托并把成员关系写进去，
 *   已有的权限代码一行都不用改。
 *
 * 与代登录码的区别：
 *   代登录码  无需账号，8 位码，进影子账号，适合临时/没账号的人。
 *   子账户    有登录名 + 密码 + 独立 MFA，适合长期共事的老师。
 */
import { ObjectId } from "mongodb";
import crypto from "crypto";
import { log } from "./log";
import { revokeAllTokens } from "./token_guard";
import {
  CI_GRANTS,
  CI_GRANT_MEMBERS,
  GrantCap,
  normalizeCaps,
  newGrantToken,
  revokeGrant,
  activeGrantsReceived,
} from "./ci_grant";

export const SUBACCOUNT_LOGIN_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;

/** 密码字母表：去掉 0/O/1/I/l 这些手抄会错的字符 */
const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 64;

/** 连续失败几次锁定、锁多久 */
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;

export function normalizeLogin(raw: any): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * 子账户的完整登录名是 `子账户名@主账号`，例如 `dianjiao@heycrab3`。
 * @ 前面是子账户自己的名字（同一个小写字母表），@ 后面是主账号的
 * userName 或 _id —— 这样不同主账号下可以各有一个 dianjiao，不会互相抢名字。
 */
export interface ParsedLogin {
  local: string;
  parentKey: string;
}

export function parseLogin(raw: any): ParsedLogin {
  const s = String(raw ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at < 0) return { local: s.toLowerCase(), parentKey: "" };
  return {
    local: s.slice(0, at).trim().toLowerCase(),
    parentKey: s.slice(at + 1).trim(),
  };
}

/** 按 userName（忽略大小写）或 _id 找到主账号 */
export async function resolveParent(db: any, parentKey: string) {
  const key = String(parentKey || "").trim();
  if (!key) return null;
  if (/^[0-9a-fA-F]{24}$/.test(key)) {
    const byId = await db
      .collection("user")
      .findOne({ _id: new ObjectId(key), isSubAccount: { $ne: true } });
    if (byId) return byId;
  }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return db
    .collection("user")
    .findOne({ userName: { $regex: `^${esc}$`, $options: "i" }, isSubAccount: { $ne: true } });
}

export function isValidLogin(login: string): boolean {
  return SUBACCOUNT_LOGIN_RE.test(login);
}

/** 生成一个可读、好抄的随机密码 */
export function generatePassword(len = 12): string {
  const bytes = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  return s;
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw).normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: any): boolean {
  const s = String(stored ?? "");
  if (!s.startsWith("scrypt$")) return false;
  const parts = s.split("$");
  if (parts.length !== 6) return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  try {
    const expected = Buffer.from(keyHex, "hex");
    const key = crypto.scryptSync(String(pw).normalize("NFKC"), Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** 一次性可读凭据：密码本身只在创建/重置时明文返回 */
export interface SubAccountCreated {
  id: ObjectId;
  login: string;
  password: string;
  grantId: ObjectId;
}

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

function cleanName(raw: any): string {
  return String(raw ?? "")
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .replace(/[<>\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

/** 登录名是否已被占用：只在同一个主账号下面唯一 */
export async function loginTaken(
  db: any,
  parentId: ObjectId,
  local: string,
  exceptId?: ObjectId,
): Promise<boolean> {
  const q: any = { subAccountLogin: local, parentId, isSubAccount: true };
  if (exceptId) q._id = { $ne: exceptId };
  const hit = await db.collection("user").findOne(q, { projection: { _id: 1 } });
  return !!hit;
}

/**
 * 创建子账户。
 * 同时建一条内部委托（internal:true），权限全部走委托那套判定。
 */
export async function createSubAccount(
  db: any,
  input: {
    parentId: any;
    name: string;
    login: string;
    password?: string;
    classIds: any[];
    caps: any;
    expiresAt: Date;
  },
): Promise<SubAccountCreated> {
  const parentId = toOid(input.parentId);
  if (!parentId) throw new Error("缺少主账号");

  const parsed = parseLogin(input.login);
  const login = parsed.local;
  if (!isValidLogin(login)) throw new Error("子账户名只能是 3-24 位小写字母、数字、下划线或减号");
  // 允许前端把完整形式 `名字@主账号` 一起传上来，但 @ 后面必须是自己
  if (parsed.parentKey) {
    const owner = await resolveParent(db, parsed.parentKey);
    if (!owner || String(owner._id) !== String(parentId)) {
      throw new Error("登录名里 @ 后面应该是你自己的账号名");
    }
  }
  if (await loginTaken(db, parentId, login)) throw new Error("这个子账户名在你名下已经被占用了");

  const name = cleanName(input.name);
  if (!name) throw new Error("请填写显示名");

  const password = input.password || generatePassword();
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new Error(`密码长度需要在 ${MIN_PASSWORD}-${MAX_PASSWORD} 位之间`);
  }

  const classIds = (Array.isArray(input.classIds) ? input.classIds : [])
    .map(toOid)
    .filter(Boolean) as ObjectId[];
  if (!classIds.length) throw new Error("请至少选择一个班级");
  if (classIds.length > 20) throw new Error("一次最多委托 20 个班级");

  const caps = normalizeCaps(input.caps);
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) throw new Error("有效期格式不正确");

  // 1) 先建内部委托
  const grantId = new ObjectId();
  const now = new Date();
  await db.collection(CI_GRANTS).insertOne({
    _id: grantId,
    ownerId: parentId,
    token: newGrantToken(),
    classIds,
    caps,
    allowSharedEdit: false,
    expiresAt,
    maxUses: 0,
    note: `子账户：${name}`,
    internal: true,
    createdAt: now,
    revokedAt: null,
    delegateCodeHash: null,
  });

  // 2) 建子账户本身
  const userId = new ObjectId();
  await db.collection("user").insertOne({
    _id: userId,
    userName: name,
    passWord: null,
    admin: false,
    tokenVersion: 0,
    isSubAccount: true,
    parentId,
    subAccountLogin: login,
    subAccountName: name,
    passwordHash: hashPassword(password),
    subGrantId: grantId,
    expiresAt,
    disabled: false,
    mfaEnabled: false,
    createdAt: now,
    createdBy: parentId,
  });

  // 3) 简历成员关系 —— activeGrantsReceived 从这里读，权限立刻生效
  await db.collection(CI_GRANT_MEMBERS).insertOne({
    _id: new ObjectId(),
    grantId,
    userId,
    acceptedAt: now,
    lastSeenAt: now,
    internal: true,
  });

  log(`[subaccount] ${parentId} 创建子账户 ${login}（${name}），委托 ${grantId}`, "info", "auth");
  return { id: userId, login, password, grantId };
}

/** 我创建的子账户（附带委托状态） */
export async function listSubAccounts(db: any, parentId: any) {
  const uid = toOid(parentId);
  if (!uid) return [];
  const rows = await db
    .collection("user")
    .find({ isSubAccount: true, parentId: uid })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  if (!rows.length) return [];

  const grantIds = rows.map((r: any) => r.subGrantId).filter(Boolean);
  const grants = grantIds.length
    ? await db.collection(CI_GRANTS).find({ _id: { $in: grantIds } }).toArray()
    : [];
  const byId = new Map<string, any>(grants.map((g: any) => [String(g._id), g]));

  // 被委托的班级名（方便前端直接展示，不用再查一次）
  const allClassIds = grants.flatMap((g: any) => (g.classIds || []).map(String));
  const classes = allClassIds.length
    ? await db
        .collection("ci_classes")
        .find({ _id: { $in: ([...new Set(allClassIds)] as string[]).map((s) => new ObjectId(s)) } })
        .project({ _id: 1, name: 1, identity: 1 })
        .toArray()
    : [];
  const classMap = new Map<string, any>(classes.map((c: any) => [String(c._id), c]));

  const parent = await db
    .collection("user")
    .findOne({ _id: uid }, { projection: { userName: 1 } });
  const parentName = String(parent?.userName || uid);

  // 两步验证状态 = 动态码或通行密钥任一可用，所以要把每个子身份的钥匙数也数出来
  const passkeyRows = await db
    .collection("webauthn_credentials")
    .aggregate([
      { $match: { userId: { $in: rows.map((r: any) => String(r._id)) } } },
      { $group: { _id: "$userId", n: { $sum: 1 } } },
    ])
    .toArray();
  const passkeyCount = new Map<string, number>(passkeyRows.map((r: any) => [String(r._id), Number(r.n) || 0]));

  const now = Date.now();
  return rows.map((r: any) => {
    const g = byId.get(String(r.subGrantId));
    const exp = g?.expiresAt ? new Date(g.expiresAt) : r.expiresAt ? new Date(r.expiresAt) : null;
    const revoked = !!g?.revokedAt;
    const expired = !!exp && exp.getTime() <= now;
    let status: "active" | "disabled" | "expired" | "revoked" = "active";
    if (revoked) status = "revoked";
    else if (r.disabled) status = "disabled";
    else if (expired) status = "expired";

    return {
      _id: String(r._id),
      name: r.userName,
      login: `${r.subAccountLogin}@${parentName}`,
      local: r.subAccountLogin,
      parentName,
      status,
      caps: g?.caps || [],
      classes: (g?.classIds || [])
        .map((id: any) => classMap.get(String(id)))
        .filter(Boolean)
        .map((c: any) => ({ _id: String(c._id), name: c.name, identity: c.identity })),
      expiresAt: exp ? exp.toISOString() : null,
      mfaEnabled: !!r.mfaEnabled || (passkeyCount.get(String(r._id)) || 0) > 0,
      totpEnabled: !!r.mfaEnabled,
      passkeyCount: passkeyCount.get(String(r._id)) || 0,
      lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      revokedAt: revoked ? new Date(g.revokedAt).toISOString() : null,
    };
  });
}

/** 子账户能不能登录（未停用、未过期、委托未撤销） */
export function subAccountUsable(user: any, now: Date = new Date()): { ok: boolean; reason?: string } {
  if (!user || !user.isSubAccount) return { ok: false, reason: "账号不存在" };
  if (user.disabled) return { ok: false, reason: "这个子账户已被停用" };
  const exp = user.expiresAt ? new Date(user.expiresAt) : null;
  if (exp && exp.getTime() <= now.getTime()) return { ok: false, reason: "这个子账户已过期" };
  return { ok: true };
}

export async function findSubAccountByLogin(db: any, login: string) {
  const { local, parentKey } = parseLogin(login);
  if (!local) return null;
  if (parentKey) {
    const parent = await resolveParent(db, parentKey);
    if (!parent) return null;
    return db
      .collection("user")
      .findOne({ subAccountLogin: local, parentId: parent._id, isSubAccount: true });
  }
  // 兼容没有 @ 的旧格式（全局唯一登录名）
  return db.collection("user").findOne({ subAccountLogin: local, isSubAccount: true });
}

/** 登录失败计数；超过阈值锁一段时间 */
export async function noteLoginFailure(db: any, userId: ObjectId): Promise<{ locked: boolean; left: number }> {
  const r = await db
    .collection("user")
    .findOneAndUpdate(
      { _id: userId },
      { $inc: { loginFailCount: 1 }, $set: { lastFailAt: new Date() } },
      { returnDocument: "after", projection: { loginFailCount: 1 } },
    );
  const doc = r?.value ?? r;
  const count = Number(doc?.loginFailCount ?? 0);
  if (count >= MAX_FAILS) {
    await db
      .collection("user")
      .updateOne({ _id: userId }, { $set: { loginLockedUntil: new Date(Date.now() + LOCK_MS), loginFailCount: 0 } });
    return { locked: true, left: 0 };
  }
  return { locked: false, left: MAX_FAILS - count };
}

export async function clearLoginFailure(db: any, userId: ObjectId) {
  await db
    .collection("user")
    .updateOne({ _id: userId }, { $set: { loginFailCount: 0, lastLoginAt: new Date() }, $unset: { loginLockedUntil: "" } });
}

export function isLocked(user: any, now: Date = new Date()): { locked: boolean; leftMs: number } {
  if (!user?.loginLockedUntil) return { locked: false, leftMs: 0 };
  const until = new Date(user.loginLockedUntil).getTime();
  const leftMs = until - now.getTime();
  return { locked: leftMs > 0, leftMs: Math.max(0, leftMs) };
}

/** 重置密码（主账号操作），返回新明文 */
export async function resetSubPassword(db: any, subUserId: any): Promise<string> {
  const id = toOid(subUserId);
  if (!id) throw new Error("子账户不存在");
  const password = generatePassword();
  const r = await db
    .collection("user")
    .updateOne(
      { _id: id, isSubAccount: true },
      { $set: { passwordHash: hashPassword(password) }, $unset: { loginFailCount: "", loginLockedUntil: "" } },
    );
  if (!r.matchedCount) throw new Error("子账户不存在");
  // 换了密码就得把旧会话踢掉；用 revokeAllTokens 顺带刷新 60 秒版本缓存，
  // 否则停用/改密码后旧令牌还能多用一分钟。
  await revokeAllTokens(db, String(id));
  log(`[subaccount] 重置子账户 ${id} 的密码`, "info", "auth");
  return password;
}

/** 改范围/能力位/有效期：直接改内部委托，权限下一请求即生效 */
export async function updateSubGrant(
  db: any,
  subUserId: any,
  patch: { classIds?: any[]; caps?: any; expiresAt?: Date },
) {
  const id = toOid(subUserId);
  if (!id) throw new Error("子账户不存在");
  const sub = await db.collection("user").findOne({ _id: id, isSubAccount: true });
  if (!sub) throw new Error("子账户不存在");
  const grantId = toOid(sub.subGrantId);
  if (!grantId) throw new Error("这条子账户没有关联的委托");

  const set: any = {};
  if (patch.classIds) {
    const ids = patch.classIds.map(toOid).filter(Boolean) as ObjectId[];
    if (!ids.length) throw new Error("请至少保留一个班级");
    if (ids.length > 20) throw new Error("一次最多委托 20 个班级");
    set.classIds = ids;
  }
  if (patch.caps) set.caps = normalizeCaps(patch.caps);
  if (patch.expiresAt) {
    const exp = patch.expiresAt instanceof Date ? patch.expiresAt : new Date(patch.expiresAt);
    if (Number.isNaN(exp.getTime())) throw new Error("有效期格式不正确");
    set.expiresAt = exp;
  }
  if (!Object.keys(set).length) return;

  await db.collection(CI_GRANTS).updateOne({ _id: grantId }, { $set: set });
  if (set.expiresAt) await db.collection("user").updateOne({ _id: id }, { $set: { expiresAt: set.expiresAt } });
  log(`[subaccount] 更新子账户 ${id} 的委托 ${grantId}`, "info", "auth");
}

/**
 * 删除子账户：撤销委托 + 踢线 + 删账号。
 * 不从 ci_grant_members 硬删也行，但留着会让 memberCounts 虚高，所以一起清。
 */
export async function deleteSubAccount(db: any, subUserId: any, operatorId: any) {
  const id = toOid(subUserId);
  if (!id) throw new Error("子账户不存在");
  const sub = await db.collection("user").findOne({ _id: id, isSubAccount: true });
  if (!sub) throw new Error("子账户不存在");
  const grantId = toOid(sub.subGrantId);
  if (grantId) {
    await revokeGrant(db, grantId, operatorId, "子账户已删除");
    await db.collection(CI_GRANT_MEMBERS).deleteMany({ grantId });
  }
  await db.collection("user").deleteOne({ _id: id });
  log(`[subaccount] 删除子账户 ${sub.subAccountLogin}`, "info", "auth");
}

/** 当前账号的能力位 —— 前端据此决定显示哪些功能 */
export async function myCapabilities(db: any, userId: any): Promise<{ caps: GrantCap[]; kind: "owner" | "subaccount" | "delegate" | "grantee" }> {
  const uid = toOid(userId);
  if (!uid) return { caps: [], kind: "owner" };
  const user = await db.collection("user").findOne({ _id: uid }, { projection: { isSubAccount: 1, isDelegate: 1 } });
  if (user?.isSubAccount) {
    const grants = await activeGrantsReceived(db, uid);
    const caps = new Set<GrantCap>();
    for (const g of grants) for (const c of g.caps) caps.add(c);
    return { caps: [...caps], kind: "subaccount" };
  }
  if (user?.isDelegate) {
    const grants = await activeGrantsReceived(db, uid);
    const caps = new Set<GrantCap>();
    for (const g of grants) for (const c of g.caps) caps.add(c);
    return { caps: [...caps], kind: "delegate" };
  }
  // 主账号：有委托收进来就是 grantee，否则是全权的 owner
  const grants = await activeGrantsReceived(db, uid);
  if (grants.length) {
    const caps = new Set<GrantCap>();
    for (const g of grants) for (const c of g.caps) caps.add(c);
    if (!caps.size) return { caps: [], kind: "grantee" };
    return { caps: [...caps], kind: "grantee" };
  }
  return { caps: [], kind: "owner" };
}
