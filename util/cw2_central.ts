/**
 * Class Widgets 2 集控（Central Control）服务端的共用逻辑。
 *
 * 协议参考：IsHPDuwu/Class-Widgets-2-Central-Control 的 `contracts/README.md`
 * 与 `server/app/{routers/device,dependencies,security}.py`：
 *   · 设备用一次性配对码换 device_token，服务端只存 token 的 sha256
 *   · 设备每 poll_interval_seconds 发一次 POST /sync，带 Bearer token
 *   · 命令靠单调递增的 cursor 增量下发，客户端按 command_id 去重后 ack
 *
 * 本项目的模型映射：**班级（ci_classes）= CW2 的分组**，设备配对进某个班级。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { buildCw2Schedule, validateCw2Schedule } from "./cw2_schedule";

export const CC_PAIRING_CODES = "cc_pairing_codes";
export const CC_DEVICES = "cc_devices";
export const CC_REVISIONS = "cc_revisions";
export const CC_COMMANDS = "cc_commands";
export const CC_ACKS = "cc_acks";
export const CC_DIAGNOSTICS = "cc_diagnostics";
export const CC_COUNTERS = "cc_counters";

/** 参考实现用 sha256(value) 的十六进制串存密钥 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 参考实现用 secrets.token_urlsafe(32) */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePairingCode(): string {
  // 便于人工输入：去掉容易混淆的字符，分组显示
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
  const part = () => Array.from({ length: 4 }, pick).join("");
  return `${part()}-${part()}`;
}

/** 命令游标：单调递增整数（参考实现用数据库自增列） */
export async function nextCommandCursor(db: any): Promise<number> {
  const res = await db.collection(CC_COUNTERS).findOneAndUpdate(
    { _id: "command_cursor" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  // mongodb driver 5.x 返回 { value }，6.x 直接返回文档
  const doc = res && typeof res === "object" && "value" in res ? res.value : res;
  return Number(doc?.seq ?? 0);
}

/** 统一把 ObjectId / 字符串 / {$oid} 变成字符串 id */
export function idStr(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof ObjectId) return value.toHexString();
  if (value.$oid) return String(value.$oid);
  if (value._id) return idStr(value._id);
  return String(value);
}

/** 把任意输入解析成 ObjectId，失败返回 null（避免 new ObjectId 抛异常） */
export function toObjectId(value: any): ObjectId | null {
  try {
    if (value instanceof ObjectId) return value;
    const s = idStr(value);
    return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
  } catch {
    return null;
  }
}

export interface ClassBundle {
  classplan: any;
  timelayout: any;
  subjects: any;
  policy: any;
}

/**
 * 按班级加载关联资源。科目优先取课表里记录的 subjectsId（和
 * router/ci/subjects.ts 的行为保持一致），其次才用班级上的 subjectsId。
 */
export async function loadClassBundle(db: any, cls: any): Promise<ClassBundle> {
  const cpId = toObjectId(cls?.classplanId);
  const tlId = toObjectId(cls?.timelayoutId);
  const subId = toObjectId(cls?.subjectsId);
  const polId = toObjectId(cls?.policyId);

  const [classplan, timelayout, directSubjects, policy] = await Promise.all([
    cpId ? db.collection("ci_classplans").findOne({ _id: cpId }) : null,
    tlId ? db.collection("ci_timelayouts").findOne({ _id: tlId }) : null,
    subId ? db.collection("ci_subjects").findOne({ _id: subId }) : null,
    polId ? db.collection("ci_policies").findOne({ _id: polId }) : null,
  ]);

  let subjects = directSubjects;
  const indirect = toObjectId(classplan?.data?.subjectsId);
  if (!subjects && indirect) {
    subjects = await db.collection("ci_subjects").findOne({ _id: indirect });
  }

  return { classplan, timelayout, subjects, policy };
}

export interface DeriveResult {
  schedule: any;
  warnings: string[];
  errors: string[];
}

/** 由班级已关联的课表/时间表/科目推导 CW2 课表 v1，并在服务端先做一次校验 */
export async function deriveScheduleForClass(db: any, cls: any): Promise<DeriveResult> {
  const bundle = await loadClassBundle(db, cls);
  if (!bundle.classplan) {
    return { schedule: null, warnings: [], errors: ["该班级还没有关联课表（ClassIsland 档案），无法生成 CW2 课表"] };
  }
  if (!bundle.timelayout) {
    return { schedule: null, warnings: [], errors: ["该班级还没有关联时间表，无法生成 CW2 课表"] };
  }

  const { schedule, warnings } = buildCw2Schedule({
    classplanData: bundle.classplan.data,
    timelayoutData: bundle.timelayout.data,
    subjectsData: bundle.subjects?.data || {},
    metaId: idStr(bundle.classplan._id),
    startDate: cls?.cw2StartDate || undefined,
  });

  const errors = validateCw2Schedule(schedule);
  return { schedule, warnings, errors };
}

/** 参考实现的默认轮询间隔是 10 秒 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 10;
/** 在线判定：超过这个时间没 sync 就算离线（参考实现有 device_online_timeout_seconds） */
export const DEVICE_ONLINE_TIMEOUT_SECONDS = 35;

export function newId(): string {
  return randomUUID();
}
