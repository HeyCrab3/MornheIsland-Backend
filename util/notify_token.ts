/**
 * 扫码发通知的令牌。
 *
 * 场景：老师/电教委员拿手机扫班牌上的二维码，直接给这个班下发通知，
 * 不登录控制台。所以令牌本身就是唯一凭证 —— 一旦外传，任何人都能给这个班发通知，
 * 这就是为什么控制台那侧必须把「二维码不要外传」讲清楚，并且支持随时重置。
 *
 * 存储放在 ci_classes 上（notifyToken / notifyTokenCreatedAt），
 * 好处是删班级时令牌自动失效，不用维护第二张表的生命周期。
 */
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { log } from "./log";

/** 32 位 hex：二维码足够短，猜中概率可忽略（2^128） */
export function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(String(token ?? ""));
}

/** 拿到班级当前令牌，没有就生成一个（幂等，重复调用不会换码） */
export async function ensureNotifyToken(db: any, classId: ObjectId): Promise<string | null> {
  const cls = await db.collection("ci_classes").findOne(
    { _id: classId },
    { projection: { notifyToken: 1 } },
  );
  if (!cls) return null;

  if (isValidToken(cls.notifyToken)) return cls.notifyToken;

  const token = generateToken();
  await db.collection("ci_classes").updateOne(
    { _id: classId },
    { $set: { notifyToken: token, notifyTokenCreatedAt: new Date() } },
  );
  return token;
}

/** 换一个新令牌，旧二维码立刻失效 */
export async function rotateNotifyToken(db: any, classId: ObjectId): Promise<string | null> {
  const token = generateToken();
  const r = await db.collection("ci_classes").updateOne(
    { _id: classId },
    { $set: { notifyToken: token, notifyTokenCreatedAt: new Date() } },
  );
  if (!r.matchedCount) return null;
  log(`[notify] 班级 ${classId} 的通知二维码已重置，旧码失效`, "info", "auth");
  return token;
}

/** 吊销：清掉令牌，二维码变成无效页 */
export async function revokeNotifyToken(db: any, classId: ObjectId): Promise<boolean> {
  const r = await db.collection("ci_classes").updateOne(
    { _id: classId },
    { $unset: { notifyToken: "", notifyTokenCreatedAt: "" } },
  );
  return !!r.matchedCount;
}

/** 按令牌反查班级（公开端点用） */
export async function findClassByToken(db: any, token: string) {
  if (!isValidToken(token)) return null;
  return db.collection("ci_classes").findOne({ notifyToken: token });
}

/** 该班级名下的设备 cuid（classId 已固化优先，旧设备按唯一 identity 兜底） */
export async function resolveClassCuids(db: any, cls: any): Promise<string[]> {
  const or: any[] = [{ classId: cls._id }];

  const identity = String(cls?.identity ?? "").trim();
  if (identity) {
    const dup = await db.collection("ci_classes").countDocuments({ identity });
    if (dup === 1) {
      // 只有全库唯一才敢按代号兜底，否则会把别校同代号设备的记录拉进来
      or.push({ identity });
    }
  }

  const rows = await db
    .collection("ci_clients")
    .find({ $or: or })
    .project({ cuid: 1 })
    .toArray();
  return [...new Set(rows.map((r: any) => String(r.cuid)).filter(Boolean))];
}
