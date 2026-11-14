/**
 * gRPC 下发目标的统一作用域解析。
 *
 * 为什么要单独抽出来：
 *   内存里的 `clients` Map 是**整个进程所有账号**的设备。凡是写成
 *   `for (const c of clients.keys())` 的地方，都等于能把指令广播到别人的机器上。
 *   这个问题在 notification / data-updated / restart 上已经修过一次，
 *   但 plugin/deliver 的 `all` 仍然是全进程广播 —— 插件下发会往别校机器装东西。
 *
 * 所以规则集中在这里：
 *   · all          → 本账号名下全部设备
 *   · cuids/cuid   → 只能是本账号名下的，否则进 rejected
 *   · schoolId     → 该学校的设备（要求我是该校成员）
 * 任何新增的下发接口都应该走 resolveTargets，别再自己遍历 clients。
 */
import { ObjectId } from "mongodb";
import { safeClientIdentities } from "./ci_public";
import { getSchoolRole } from "./school";
import { grantedClassIds, type GrantCap } from "./ci_grant";

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/**
 * 本账号可下发的设备 cuid 集合。
 *
 * 除了自己名下的班，还包括「别人委托给我的班」—— 只要委托里有对应的设备能力
 * （cap 传 device.control / device.restart / notify.send）。委托一旦撤销，
 * 这里立刻取不到，所以不需要额外清理。
 */
export async function ownCuidSet(
  db: any,
  userId: any,
  cap: GrantCap = "device.control",
): Promise<Set<string>> {
  const uid = toOid(userId);
  if (!uid) return new Set();

  const classes = await db
    .collection("ci_classes")
    .find({ userId: uid })
    .project({ _id: 1, identity: 1 })
    .toArray();

  const grantedIds = await grantedClassIds(db, uid, [cap]);
  const grantedClasses = grantedIds.length
    ? await db
        .collection("ci_classes")
        .find({ _id: { $in: grantedIds } })
        .project({ _id: 1, identity: 1 })
        .toArray()
    : [];

  const all = [...classes, ...grantedClasses];
  if (!all.length) return new Set();

  const classIds = all.map((c: any) => c._id);
  const { ids: safeIdentities } = await safeClientIdentities(db, all);

  const rows = await db
    .collection("ci_clients")
    .find({ $or: [{ classId: { $in: classIds } }, { identity: { $in: safeIdentities } }] })
    .project({ cuid: 1 })
    .toArray();
  return new Set(rows.map((r: any) => String(r.cuid)));
}

/**
 * 某所学校的设备 cuid 集合。
 * 设备是通过 班级 → 学校 聚合出来的，不额外写设备数据。
 */
export async function schoolCuidSet(
  db: any,
  userId: any,
  schoolId: any,
): Promise<{ ok: boolean; reason?: string; cuids: Set<string> }> {
  const sid = toOid(schoolId);
  if (!sid) return { ok: false, reason: "schoolId 非法", cuids: new Set() };

  const role = await getSchoolRole(db, sid, userId);
  if (!role) return { ok: false, reason: "你不在这所学校里", cuids: new Set() };

  const classes = await db
    .collection("ci_classes")
    .find({ schoolId: sid })
    .project({ _id: 1 })
    .toArray();
  if (!classes.length) return { ok: true, cuids: new Set() };

  const rows = await db
    .collection("ci_clients")
    .find({ classId: { $in: classes.map((c: any) => c._id) } })
    .project({ cuid: 1 })
    .toArray();
  return { ok: true, cuids: new Set(rows.map((r: any) => String(r.cuid))) };
}

export interface ResolvedTargets {
  allowed: string[];
  rejected: string[];
  /** 作用域说明，便于日志与前端提示 */
  scope: "own" | "school" | "explicit";
  error?: string;
}

/**
 * 把请求里的目标收敛到合法范围。
 * 返回 null 表示"没指定目标"；带 error 表示作用域非法（比如不属于那所学校）。
 */
export async function resolveTargets(
  db: any,
  userId: any,
  body: any,
  cap: GrantCap = "device.control",
): Promise<ResolvedTargets | null> {
  if (!userId) return null;
  const { cuid, cuids, all, schoolId } = body || {};

  // 学校作用域优先：只允许该校设备
  if (schoolId) {
    const scoped = await schoolCuidSet(db, userId, schoolId);
    if (!scoped.ok) return { allowed: [], rejected: [], scope: "school", error: scoped.reason };

    const requested = Array.isArray(cuids) && cuids.length ? cuids.map(String) : cuid ? [String(cuid)] : null;
    if (!requested) {
      // 没点具体设备 = 全校在线设备
      return { allowed: [...scoped.cuids], rejected: [], scope: "school" };
    }
    return {
      allowed: requested.filter((c) => scoped.cuids.has(c)),
      rejected: requested.filter((c) => !scoped.cuids.has(c)),
      scope: "school",
    };
  }

  const own = await ownCuidSet(db, userId, cap);
  let targets: string[] = [];
  if (all) targets = [...own];
  else if (Array.isArray(cuids) && cuids.length) targets = cuids.map(String);
  else if (cuid) targets = [String(cuid)];
  else return null;

  return {
    allowed: targets.filter((c) => own.has(c)),
    rejected: targets.filter((c) => !own.has(c)),
    scope: all ? "own" : "explicit",
  };
}
