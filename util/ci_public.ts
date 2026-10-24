/**
 * CI 公开端点工具。
 *
 * ⚠ 安全约束（跨校串数据事故后加固）：
 * `identity` 是用户自己填的班级代号（"1"、"1-101"…），**全库不唯一**——
 * 实测 110 个班里有 7 个账号都用了 "1"、3 个账号用了 "1-101"。
 * 以前这里用 findOne({ identity }) 兜底，命中多个时直接返回任意一个，
 * 导致 A 校设备的集控清单解析到 B 校班级，是真实的跨租户越权。
 *
 * 现在的规则：
 *  1. 优先按 ObjectId 精确命中（静态模式 URL、新 preset 的 ClassIdentity 都用这个，全局唯一）；
 *  2. 只有**全局唯一**的 identity 才允许兜底；
 *  3. 命中多个 → 记警告并返回 null（fail closed），绝不猜。
 */
import { ObjectId } from "mongodb";
import { log } from "./log";

/** 某班级标识在全库出现几次，供调用方区分「不存在」和「有歧义」 */
export async function countClassesByIdentity(db: any, classIdentity: string): Promise<number> {
  return db.collection("ci_classes").countDocuments({ identity: String(classIdentity ?? "") });
}

export async function findClass(db: any, classIdentity: string) {
  const key = String(classIdentity ?? "").trim();
  if (!key) return null;

  // 1) 按 ObjectId 精确查找
  if (ObjectId.isValid(key)) {
    const cls = await db.collection("ci_classes").findOne({ _id: new ObjectId(key) });
    if (cls) return cls;
    // 24 位 hex 也可能恰好是某个班级的 identity，继续走下面的兜底
  }

  // 2) 旧式班级标识：必须全局唯一才接受
  const matches = await db.collection("ci_classes").find({ identity: key }).limit(2).toArray();
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    log(
      `[ci] 拒绝按班级标识解析：identity="${key}" 在多个账号下重复，无法确定归属（可能是跨校串数据）`,
      "warn",
      "auth",
    );
    return null;
  }
  return null;
}

/**
 * 算出可以安全用于匹配 ci_clients 的标识集合。
 *
 * ci_clients 只记录了客户端上报的 identity，没有 userId/classId，
 * 所以「我的设备」只能靠标识匹配。但班级代号全库不唯一，
 * 直接拿它去 `$in` 会把**别校同代号设备的记录一起拉进来**
 * （插件对账、配置组下发都走这条路，等于能读到甚至命令到别人的设备）。
 *
 * 规则：永远包含班级 _id（全局唯一，新 preset 就是这么上报的）；
 * 班级代号只有在**全库唯一**时才纳入，否则丢弃并回报，由调用方决定怎么提示。
 */
export async function safeClientIdentities(
  db: any,
  classes: any[],
): Promise<{ ids: string[]; ambiguous: string[] }> {
  const ids: string[] = [];
  const rawIdentities: string[] = [];

  for (const c of classes || []) {
    const id = String(c?._id ?? "").trim();
    if (id) ids.push(id);
    const ident = String(c?.identity ?? "").trim();
    if (ident) rawIdentities.push(ident);
  }

  const ambiguous: string[] = [];
  const unique = [...new Set(rawIdentities)];
  if (unique.length) {
    const grouped = await db
      .collection("ci_classes")
      .aggregate([
        { $match: { identity: { $in: unique } } },
        { $group: { _id: "$identity", count: { $sum: 1 } } },
      ])
      .toArray();
    const countMap = new Map<string, number>(
      grouped.map((g: any) => [String(g._id), Number(g.count) || 0]),
    );
    for (const ident of unique) {
      if ((countMap.get(ident) || 0) === 1) ids.push(ident);
      else {
        ambiguous.push(ident);
        log(
          `[ci] 匹配设备时忽略有歧义的班级标识 "${ident}"：全库重复，可能属于其他学校`,
          "warn",
          "auth",
        );
      }
    }
  }

  return { ids: [...new Set(ids)], ambiguous };
}
