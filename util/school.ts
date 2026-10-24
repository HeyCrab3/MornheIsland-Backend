/**
 * 学校（租户）维度。
 *
 * 背景：班级原本直接挂在账号下（ci_classes.userId），而班级标识是用户自填的，
 * 多个学校用同一个代号就会串数据。学校作为租户后：
 *   · 班级挂在 ci_classes.schoolId 下，班级标识只需**校内唯一**；
 *   · 时间表/科目/设置/策略等资源可以提升到学校级，由学校统一分配（各班只排课）；
 *   · 设备通过 班级 → 学校 天然聚合，不需要新字段。
 *
 * 现实约束（来自产品负责人的说明）：
 *   · 纯公益免费，没有计费/配额概念；
 *   · 实际操作者多是**学生电教委员**，不是学校电教主任 —— 所以不搞厚重的
 *     管理员审批流程，学校实体就是个轻量的分组容器；
 *   · orgName 为空的历史班级**不做任何处理**，也不要求用户补学校信息，
 *     它们留在"个人模式"（schoolId 为空，行为和现在一致）。
 */

import { ObjectId } from "mongodb";

export const CI_SCHOOLS = "ci_schools";
export const CI_SCHOOL_MEMBERS = "ci_school_members";

export type SchoolRole = "owner" | "admin" | "member";

export interface SchoolDoc {
  _id?: ObjectId;
  name: string;
  /** 归一化后的名字，用于查重（去空白、去尾部括号备注、统一大小写） */
  normalizedName: string;
  /**
   * 除了 normalizedName 之外的所有原始写法。
   * 例："石家庄一中实验学校" 与 "石家庄一中实验学校(jian yu)" 归为同一所，
   * 后者进 aliases，避免历史上同一个学校被拆成两个。
   */
  aliases: string[];
  ownerUserId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 把用户随手填的组织名归一化，用于判断"是不是同一所学校"。
 *
 * 只做保守处理，宁可漏合并也不要把两所学校错误合并：
 *   · 去首尾空白、合并连续空白
 *   · 去掉末尾的括号备注，如「石家庄一中实验学校(jian yu)」→「石家庄一中实验学校」
 *   · 全角括号同样处理
 *   · 拉丁字母统一小写（"CLXX" / "clxx" 视为同一个）
 */
export function normalizeSchoolName(raw: any): string {
  let s = String(raw ?? "").trim().replace(/\s+/g, " ");
  // 去掉末尾括号备注（中英文括号都算）
  s = s.replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
  // 去掉结尾的标点/空白
  s = s.replace(/[\s·、,，.。;；:：\-_]+$/, "").trim();
  return s.toLowerCase();
}

/** 该学校成员可用的角色值 */
export function isSchoolRole(v: any): v is SchoolRole {
  return v === "owner" || v === "admin" || v === "member";
}

/** 取当前账号在指定学校的角色；不是成员返回 null */
export async function getSchoolRole(
  db: any,
  schoolId: any,
  userId: any,
): Promise<SchoolRole | null> {
  const sid = toOid(schoolId);
  const uid = toOid(userId);
  if (!sid || !uid) return null;
  const doc = await db.collection(CI_SCHOOL_MEMBERS).findOne({ schoolId: sid, userId: uid });
  return (doc?.role as SchoolRole) ?? null;
}

/** 列出当前账号加入的所有学校（含角色） */
export async function listMySchools(db: any, userId: any): Promise<any[]> {
  const uid = toOid(userId);
  if (!uid) return [];
  const memberships = await db.collection(CI_SCHOOL_MEMBERS).find({ userId: uid }).toArray();
  if (!memberships.length) return [];
  const ids = memberships.map((m: any) => m.schoolId);
  const schools = await db.collection(CI_SCHOOLS).find({ _id: { $in: ids } }).toArray();
  const roleById = new Map(memberships.map((m: any) => [String(m.schoolId), m.role]));
  return schools.map((s: any) => ({
    id: String(s._id),
    name: s.name,
    role: roleById.get(String(s._id)) ?? "member",
    createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
  }));
}

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/** 当前账号加入的所有学校 id（资源可见性用） */
export async function mySchoolIds(db: any, userId: any): Promise<ObjectId[]> {
  const uid = toOid(userId);
  if (!uid) return [];
  const memberships = await db
    .collection(CI_SCHOOL_MEMBERS)
    .find({ userId: uid })
    .project({ schoolId: 1 })
    .toArray();
  return memberships.map((m: any) => m.schoolId).filter(Boolean);
}

/**
 * 学校级资源能不能改。
 *
 * 产品背景：实际使用者是学生电教委员，一个学校往往只有一个固定账号，
 * 那个账号是 owner，所以这里卡得松一点不会有实际影响；
 * 但学校真有多人时，普通成员只读能避免互相覆盖 —— 学校的统一时间表被
 * 随手改掉，影响的是整校所有班。
 */
export async function canWriteSchoolResource(
  db: any,
  schoolId: any,
  userId: any,
): Promise<boolean> {
  const role = await getSchoolRole(db, schoolId, userId);
  return role === "owner" || role === "admin";
}
