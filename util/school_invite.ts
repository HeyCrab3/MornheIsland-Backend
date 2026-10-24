/**
 * 学校邀请链接。
 *
 * 为什么必须有这个（安全事件记录）：
 * 最早的升级流程是「按机构名自动合并」—— 同名学校已存在就**复用**它，
 * 并把点升级的那个账号写成 owner。而机构名是用户自己填的自由文本，
 * 于是任何账号只要把班级机构名改成某校名字、点一下升级，
 * 就能拿到那所学校的 owner 权限（改删全校共享资源）。
 * 凭名字猜测就能接管别人的学校，这是真实的提权漏洞。
 *
 * 现在的规则：
 *   · 建学校只能「新建」，不会因为重名就并进别人的学校；
 *   · 要进别人已经建好的学校，只能拿到 owner/admin 发出的**邀请链接**；
 *   · 邀请默认是 member（只读学校级资源），管理员邀请可以给 admin；
 *   · 邀请本身可设有效期与使用次数，可随时吊销，token 32 位 hex 不可枚举。
 *
 * 注意：邀请 token 和通知二维码 token 一样，本身就是凭证 ——
 * 拿到链接且已登录账号的人就能进校，所以控制台要提示不要外传。
 */

import crypto from "crypto";
import { ObjectId } from "mongodb";
import { log } from "./log";
import type { SchoolRole } from "./school";

export const CI_SCHOOL_INVITES = "ci_school_invites";

/** 默认 72 小时、10 次 */
export const DEFAULT_EXPIRES_HOURS = 72;
export const DEFAULT_MAX_USES = 10;
const MAX_EXPIRES_HOURS = 24 * 30; // 最长 30 天
const MAX_USES_LIMIT = 200;

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function isValidInviteToken(token: any): boolean {
  return TOKEN_RE.test(String(token ?? ""));
}

function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export interface CreateInviteOptions {
  expiresInHours?: number;
  maxUses?: number;
  role?: SchoolRole;
}

/** 建一个邀请，返回明文 token（只此一次，库里存的就是它本身，方便吊销） */
export async function createInvite(
  db: any,
  schoolId: ObjectId,
  createdByUserId: ObjectId,
  opts: CreateInviteOptions = {},
) {
  const expiresInHours = Math.min(
    MAX_EXPIRES_HOURS,
    Math.max(1, Number(opts.expiresInHours) || DEFAULT_EXPIRES_HOURS),
  );
  const maxUses = Math.min(
    MAX_USES_LIMIT,
    Math.max(1, Number(opts.maxUses) || DEFAULT_MAX_USES),
  );
  const role: SchoolRole = opts.role === "admin" ? "admin" : "member";

  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    token: generateToken(),
    schoolId,
    role,
    createdByUserId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + expiresInHours * 3600_000),
    maxUses,
    uses: 0,
    revoked: false,
  };
  await db.collection(CI_SCHOOL_INVITES).insertOne(doc);
  log(
    `[school-invite] 用户 ${createdByUserId} 为学校 ${schoolId} 生成邀请（${role}，${expiresInHours}h，${maxUses} 次）`,
    "info",
    "auth",
  );
  return doc;
}

/** 校验邀请是否还能用；不能用返回 { ok:false, reason } */
export async function checkInvite(db: any, token: any) {
  if (!isValidInviteToken(token)) return { ok: false as const, reason: "邀请链接无效" };

  const invite = await db.collection(CI_SCHOOL_INVITES).findOne({ token: String(token) });
  if (!invite) return { ok: false as const, reason: "邀请链接不存在或已被吊销" };
  if (invite.revoked) return { ok: false as const, reason: "这条邀请已被吊销" };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return { ok: false as const, reason: "这条邀请已过期，请让管理员重新生成" };
  }
  if (Number(invite.uses || 0) >= Number(invite.maxUses || 0)) {
    return { ok: false as const, reason: "这条邀请的使用次数已用完" };
  }
  return { ok: true as const, invite };
}

/** 吊销一条邀请 */
export async function revokeInvite(db: any, inviteId: ObjectId, schoolId: ObjectId) {
  const r = await db
    .collection(CI_SCHOOL_INVITES)
    .updateOne({ _id: inviteId, schoolId }, { $set: { revoked: true, revokedAt: new Date() } });
  return !!r.matchedCount;
}
