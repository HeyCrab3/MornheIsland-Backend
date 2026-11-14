/**
 * 班级委托（delegation）—— IAM 的第一阶段。
 *
 * 为什么是「委托」而不是「子账号」：
 *   本项目没有自己的密码体系（登录全靠上游 SSO），要做子账号就得从零建一套
 *   密码存储/锁定/找回，而现实里电教委员会把口令用微信发给学弟 —— 那是明文传凭证，
 *   比共享主账号还难追责。委托把「有时效 + 可吊销 + 可限制能力 + 能追到授权人」
 *   这几件事直接做到了，且不需要新密码。
 *
 * 模型：
 *   ci_grants          一条授权：主账号 ownerId 把若干班级 classIds、若干能力 caps，
 *                      在 expiresAt 之前、最多给 maxUses 个不同的人使用。
 *   ci_grant_members   谁接受了：{ grantId, userId }。撤销 = 删成员，立即失效。
 *
 * 权限只在读取时计算（expiresAt / revokedAt 每次现查），所以「到期」不需要定时任务：
 *   过期的那一刻起 activeGrantsReceived 就不再返回它。
 */
import { ObjectId } from "mongodb";
import { randomBytes, createHash } from "crypto";
import { log } from "./log";
import { forgetTokenVersion } from "./token_guard";

export const CI_GRANTS = "ci_grants";
export const CI_GRANT_MEMBERS = "ci_grant_members";

/** 能力位。后端是唯一开关，前端只用它决定按钮能不能点。 */
export type GrantCap =
  | "view" // 查看班级与资源
  | "resource.edit" // 编辑课表/时间表/科目/设置/策略
  | "resource.delete" // 删除资源
  | "device.control" // 下发插件、刷新数据、下发命令
  | "device.restart" // 重启客户端
  | "notify.send"; // 推送通知、看板公告

export const GRANT_CAPS: GrantCap[] = [
  "view",
  "resource.edit",
  "resource.delete",
  "device.control",
  "device.restart",
  "notify.send",
];

export const CAP_LABELS: Record<GrantCap, string> = {
  view: "查看班级与资源",
  "resource.edit": "编辑课表 / 时间表 / 科目 / 设置 / 策略",
  "resource.delete": "删除资源",
  "device.control": "下发插件、刷新数据、下发命令",
  "device.restart": "重启客户端",
  "notify.send": "推送通知、看板公告",
};

export function isGrantCap(v: any): v is GrantCap {
  return typeof v === "string" && (GRANT_CAPS as string[]).includes(v);
}

/** 过滤未知能力位；view 是基础能力，永远保留。 */
export function normalizeCaps(raw: any): GrantCap[] {
  const list = Array.isArray(raw) ? raw.filter(isGrantCap) : [];
  const set = new Set<GrantCap>(list);
  set.add("view");
  return GRANT_CAPS.filter((c) => set.has(c));
}

/** 下发类操作需要的能力（设备可见性按这组能力放开） */
export const DEVICE_CAPS: GrantCap[] = ["device.control", "device.restart", "notify.send"];

export interface GrantLite {
  _id: ObjectId;
  ownerId: ObjectId;
  classIds: ObjectId[];
  caps: GrantCap[];
  allowSharedEdit: boolean;
}

export function newGrantToken(): string {
  return randomBytes(16).toString("hex");
}

/** 未撤销且未过期 */
export function grantUsable(grant: any, now: Date = new Date()): boolean {
  if (!grant) return false;
  if (grant.revokedAt) return false;
  const exp = grant.expiresAt ? new Date(grant.expiresAt) : null;
  if (!exp || Number.isNaN(exp.getTime())) return false;
  return exp.getTime() > now.getTime();
}

/* ────────────────────────── 代登录码 ──────────────────────────
 * 受托人可能压根没有账号（学弟、家长、外包）。代登录码让他不注册也能进来，
 * 但进去的是一个「影子账号」：userId 独立、名字是他自己填的、权限完全来自这条委托。
 * 这样审计日志、水印、历史记录里写的都是「谁在操作」，而不是主账号。
 * 撤销委托时会顺手把影子账号的 tokenVersion +1，会话立即失效。
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 去掉 0/O/1/I/L

/** 8 位代登录码，形如 AB3D-9KMT */
export function newDelegateCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 归一化（去分隔符、转大写）后哈希；密码类凭据一律只存哈希 */
export function delegateCodeHash(code: string): string {
  const norm = String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  return createHash("sha256").update(norm).digest("hex");
}

export function normalizeDelegateCode(code: string): string {
  return String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

/** 按代登录码找委托（只返回未撤销的；过期与否由调用方用 grantUsable 判） */
export async function findGrantByDelegateCode(db: any, code: string) {
  const norm = normalizeDelegateCode(code);
  if (norm.length !== 8) return null;
  const hash = delegateCodeHash(norm);
  // 注意：委托文档建的时候写的是 revokedAt: null，用 $exists:false 永远匹配不到
  return db.collection(CI_GRANTS).findOne({ delegateCodeHash: hash, revokedAt: null });
}

/** 撤销委托时，连带踢掉这条委托下所有代登录会话 */
export async function killDelegateSessions(db: any, grantId: ObjectId) {
  const shadows = await db
    .collection("user")
    .find({ delegateGrantId: grantId })
    .project({ _id: 1 })
    .toArray();
  if (!shadows.length) return 0;
  await db
    .collection("user")
    .updateMany({ _id: { $in: shadows.map((s: any) => s._id) } }, { $inc: { tokenVersion: 1 } });
  // 版本号缓存 60 秒，不主动失效的话「撤销即下线」会晚一分钟才生效
  for (const s of shadows) forgetTokenVersion(String(s._id));
  log(`[grant] 踢掉委托 ${grantId} 下 ${shadows.length} 个代登录会话`, "info", "auth");
  return shadows.length;
}

let indexed = false;
async function ensureIndexes(db: any) {
  if (indexed) return;
  indexed = true;
  try {
    await db.collection(CI_GRANTS).createIndex({ token: 1 });
    await db.collection(CI_GRANTS).createIndex({ ownerId: 1, createdAt: -1 });
    await db.collection(CI_GRANT_MEMBERS).createIndex({ userId: 1 });
    await db.collection(CI_GRANT_MEMBERS).createIndex({ grantId: 1 });
  } catch {
    /* 索引失败不影响功能 */
  }
}

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/** 我发出的授权（含已过期/已撤销，便于展示历史） */
export async function listIssuedGrants(db: any, userId: any) {
  await ensureIndexes(db);
  const uid = toOid(userId);
  if (!uid) return [];
  return db.collection(CI_GRANTS).find({ ownerId: uid }).sort({ createdAt: -1 }).limit(100).toArray();
}

/**
 * 别人给我的、当前有效的授权。
 * 这是所有权限判定的入口 —— scopeOf / 设备作用域都从这里取。
 */
export async function activeGrantsReceived(db: any, userId: any): Promise<GrantLite[]> {
  const uid = toOid(userId);
  if (!uid) return [];
  await ensureIndexes(db);

  const members = await db
    .collection(CI_GRANT_MEMBERS)
    .find({ userId: uid })
    .project({ grantId: 1 })
    .toArray();
  if (!members.length) return [];

  const grants = await db
    .collection(CI_GRANTS)
    .find({ _id: { $in: members.map((m: any) => m.grantId) }, revokedAt: null })
    .toArray();

  return grants
    .filter((g: any) => grantUsable(g))
    .map((g: any) => ({
      _id: g._id,
      ownerId: g.ownerId,
      classIds: (g.classIds || []).filter((c: any) => c instanceof ObjectId),
      caps: normalizeCaps(g.caps),
      allowSharedEdit: !!g.allowSharedEdit,
    }));
}

/** 我收到的授权里，按能力筛出的班级 id（设备/通知作用域用） */
export async function grantedClassIds(
  db: any,
  userId: any,
  caps: GrantCap[],
): Promise<ObjectId[]> {
  const grants = await activeGrantsReceived(db, userId);
  const out = new Map<string, ObjectId>();
  for (const g of grants) {
    if (!caps.some((c) => g.caps.includes(c))) continue;
    for (const cid of g.classIds) out.set(String(cid), cid);
  }
  return [...out.values()];
}

/** 我收到的授权里可见的全部班级 id（任何能力都至少给 view） */
export async function grantedClassIdsAny(db: any, userId: any): Promise<ObjectId[]> {
  return grantedClassIds(db, userId, GRANT_CAPS);
}

export async function memberCounts(db: any, grantIds: ObjectId[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!grantIds.length) return map;
  const rows = await db
    .collection(CI_GRANT_MEMBERS)
    .aggregate([
      { $match: { grantId: { $in: grantIds } } },
      { $group: { _id: "$grantId", n: { $sum: 1 } } },
    ])
    .toArray();
  for (const r of rows) map.set(String(r._id), Number(r.n) || 0);
  return map;
}

export async function listGrantMembers(db: any, grantId: ObjectId) {
  const rows = await db
    .collection(CI_GRANT_MEMBERS)
    .find({ grantId })
    .sort({ acceptedAt: -1 })
    .toArray();
  if (!rows.length) return [];
  const users = await db
    .collection("user")
    .find({ _id: { $in: rows.map((r: any) => r.userId) } })
    .project({ userName: 1 })
    .toArray();
  const nameOf = new Map(users.map((u: any) => [String(u._id), u.userName]));
  return rows.map((r: any) => ({
    userId: String(r.userId),
    userName: nameOf.get(String(r.userId)) || null,
    acceptedAt: r.acceptedAt,
    lastSeenAt: r.lastSeenAt || null,
  }));
}

/** 撤销授权：删掉所有接受者，立即失去访问权（权限是每次现查的） */
export async function revokeGrant(db: any, grantId: ObjectId, operatorId: any, reason = "") {
  await db
    .collection(CI_GRANTS)
    .updateOne({ _id: grantId }, { $set: { revokedAt: new Date(), revokedBy: toOid(operatorId) } });
  const r = await db.collection(CI_GRANT_MEMBERS).deleteMany({ grantId });
  const killed = await killDelegateSessions(db, grantId);
  log(
    `[grant] ${operatorId} 撤销委托 ${grantId}（移除 ${r.deletedCount} 名被授权人，踢下线 ${killed} 个代登录会话）${reason ? ` ${reason}` : ""}`,
    "info",
    "auth",
  );
  return r.deletedCount;
}

/** 接受授权：同一人重复接受只保留一条，且不重复占用名额 */
export async function acceptGrant(db: any, grant: any, userId: any) {
  const uid = toOid(userId);
  if (!uid) throw new Error("userId 非法");
  await ensureIndexes(db);

  const existing = await db
    .collection(CI_GRANT_MEMBERS)
    .findOne({ grantId: grant._id, userId: uid });
  if (existing) {
    await db
      .collection(CI_GRANT_MEMBERS)
      .updateOne({ _id: existing._id }, { $set: { lastSeenAt: new Date() } });
    return { already: true };
  }

  const maxUses = Number(grant.maxUses || 0);
  if (maxUses > 0) {
    const used = await db.collection(CI_GRANT_MEMBERS).countDocuments({ grantId: grant._id });
    if (used >= maxUses) {
      return { full: true, used, maxUses };
    }
  }

  await db.collection(CI_GRANT_MEMBERS).insertOne({
    _id: new ObjectId(),
    grantId: grant._id,
    userId: uid,
    acceptedAt: new Date(),
    lastSeenAt: new Date(),
  });
  log(`[grant] 用户 ${uid} 接受了 ${grant.ownerId} 的班级委托 ${grant._id}`, "info", "auth");
  return { already: false };
}

export async function leaveGrant(db: any, grantId: ObjectId, userId: any) {
  const uid = toOid(userId);
  if (!uid) return 0;
  const r = await db.collection(CI_GRANT_MEMBERS).deleteOne({ grantId, userId: uid });
  return r.deletedCount;
}

/**
 * 该资源是否被「我受托的班级」引用，且引用者全部在我的受托范围内。
 * 用于判断委托账号能不能改一份资源。
 */
export async function grantCoversResource(
  db: any,
  scopeGrants: GrantLite[],
  doc: any,
  refFields: Record<string, string>,
  cap: GrantCap,
): Promise<{ ok: boolean; reason?: string }> {
  if (!scopeGrants.length || !doc?._id) return { ok: false };

  const capable = scopeGrants.filter((g) => g.caps.includes(cap));
  if (!capable.length) {
    return { ok: false, reason: `你的委托不包含「${CAP_LABELS[cap] || cap}」` };
  }

  const refOr = Object.values(refFields).map((f) => ({ [f]: doc._id }));
  const classes = await db
    .collection("ci_classes")
    .find({ $or: refOr })
    .project({ _id: 1, name: 1, identity: 1 })
    .toArray();
  if (!classes.length) return { ok: false };

  const ids = classes.map((c: any) => String(c._id));
  for (const g of capable) {
    const mine = new Set(g.classIds.map((c) => String(c)));
    const covered = ids.filter((id: string) => mine.has(id));
    if (!covered.length) continue;
    if (covered.length === ids.length) return { ok: true };
    // 被受托范围外的班级也在用 —— 改它会影响别人，默认不允许
    if (g.allowSharedEdit) return { ok: true };
    const outside = classes.filter((c: any) => !mine.has(String(c._id)));
    const names = outside.slice(0, 3).map((c: any) => c.name || c.identity).join("、");
    return {
      ok: false,
      reason: `这份资源还被你受托范围外的 ${outside.length} 个班级使用（${names}${outside.length > 3 ? " 等" : ""}），修改会影响它们。需要主账号开启「允许修改共享资源」。`,
    };
  }
  return { ok: false, reason: "这份资源不属于你受托的班级" };
}
