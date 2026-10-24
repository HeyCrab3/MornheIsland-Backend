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
import { log } from "./log";
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
 * 按班级加载关联资源。
 *
 * ⚠ 解析顺序很重要，踩过坑：**课表资源自己记录的 timelayoutId / subjectsId 优先**。
 * CSES 导入时会同时写 `cp.data.timelayoutId`，而 ClassPlans 里的 `TimeLayoutId`
 * 指向的也是那一份。用户之后如果在档案库里重新选了别的时间表，只会更新班级字段
 * （`cls.timelayoutId`），于是「档案库显示已关联」和「ClassPlan 实际引用」就分叉了：
 * ClassIsland 载入时找不到被引用的那份，报「您还未给课程表配置时间表」，
 * 下发的时间表也变成没有名字的空壳。
 *
 * 所以这里以**课表真正的引用**为准，班级字段只作兜底。
 */
export async function loadClassBundle(db: any, cls: any): Promise<ClassBundle> {
  const cpId = toObjectId(cls?.classplanId);
  const clsTlId = toObjectId(cls?.timelayoutId);
  const clsSubId = toObjectId(cls?.subjectsId);
  const polId = toObjectId(cls?.policyId);

  const [classplan, policy] = await Promise.all([
    cpId ? db.collection("ci_classplans").findOne({ _id: cpId }) : null,
    polId ? db.collection("ci_policies").findOne({ _id: polId }) : null,
  ]);

  const cpTlId = toObjectId(classplan?.data?.timelayoutId);
  const cpSubId = toObjectId(classplan?.data?.subjectsId);

  const [tlResolved, directSubjects] = await Promise.all([
    cpTlId
      ? db.collection("ci_timelayouts").findOne({ _id: cpTlId })
      : clsTlId
        ? db.collection("ci_timelayouts").findOne({ _id: clsTlId })
        : null,
    cpSubId
      ? db.collection("ci_subjects").findOne({ _id: cpSubId })
      : clsSubId
        ? db.collection("ci_subjects").findOne({ _id: clsSubId })
        : null,
  ]);
  // 下面的空壳兜底需要重新赋值，所以这里不能是 const
  let timelayout = tlResolved;

  let subjects = directSubjects;
  if (!subjects && clsSubId) {
    subjects = await db.collection("ci_subjects").findOne({ _id: clsSubId });
  }

  /*
   * 最后一道兜底：课表引用的那份时间表如果是**空壳**（没有 Layouts），
   * 而班级字段上那份是好的，就用好的那份。
   * 只影响看板/CW2 这类「只关心时间段」的用途；ClassIsland 侧仍需要引用一致，
   * 所以这里记一条 warning，控制台应把它作为数据体检项暴露出来。
   */
  const layoutCount = (doc: any) => {
    const data = doc?.data || {};
    return Object.values<any>(data).reduce(
      (n, v) => n + (Array.isArray(v?.Layouts) ? v.Layouts.length : 0),
      0,
    );
  };
  if (timelayout && layoutCount(timelayout) === 0 && clsTlId && clsTlId.toString() !== cpTlId?.toString()) {
    const fallback = await db.collection("ci_timelayouts").findOne({ _id: clsTlId });
    if (fallback && layoutCount(fallback) > 0) {
      log(
        `[ci] 班级 ${cls?.name || cls?._id}：课表引用的时间表为空壳，已退回班级关联的那份（${fallback.name || fallback._id}）`,
        "warn",
        "auth",
      );
      timelayout = fallback;
    }
  }

  /*
   * 引用不一致的数据修复：ClassPlans 引用的 uuid 在所选时间表里不存在，
   * 但那份时间表里恰好只有一条可用时间轴时，把它挂到被引用的 uuid 上。
   * 这样看板/CW2 能正常算出时间段；同时记警告，提醒这是数据不一致而非正常状态。
   */
  if (timelayout) {
    const plans = classplan?.data?.classPlans || classplan?.data || {};
    const referenced = [
      ...new Set(
        Object.values<any>(plans)
          .map((p) => String(p?.TimeLayoutId ?? ""))
          .filter(Boolean),
      ),
    ];
    const tlData = timelayout.data || {};
    const tlUuids = Object.keys(tlData);
    if (referenced.length === 1 && tlUuids.length === 1 && !tlUuids.includes(referenced[0])) {
      const only: any = tlData[tlUuids[0]];
      if (Array.isArray(only?.Layouts) && only.Layouts.length) {
        log(
          `[ci] 班级 ${cls?.name || cls?._id}：ClassPlan 引用的 ${referenced[0]} 不在时间表内，已把「${only.Name || "未命名"}」重映射到该 uuid（数据不一致）`,
          "warn",
          "auth",
        );
        timelayout = { ...timelayout, data: { [referenced[0]]: only } };
      }
    }
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
