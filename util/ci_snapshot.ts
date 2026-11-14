/**
 * 敏感操作前的自动快照。
 *
 * 为什么不是只靠审计日志：
 *   审计日志能回答「谁在什么时候动了什么」，但答不了「动之前长什么样」。
 *   用户的原话是「万一课表变成滚木，用户自己都不知道账号在哪」——
 *   那种情况下需要的是一份改动前的原始数据，而不是一条记录。
 *
 * 和 ci_history 的区别：
 *   ci_history 只有 update/restore 会写，且是按 version 组织的「正式历史」；
 *   这里是「凡是会覆盖或删除数据的操作都留一份」，包括删除、导入、批量修复。
 *   两者并存，互为冗余。
 *
 * 清理策略：每份资源保留最近 SNAPSHOT_KEEP 份，超过 KEEP+SLACK 才触发清理
 * （避免每次写入都 count）。用户明确说过「数据冗余实际上多存几份没坏处」。
 */
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { log } from "./log";

export const CI_SNAPSHOTS = "ci_snapshots";
export const SNAPSHOT_KEEP = 200;
const PRUNE_SLACK = 40;

export type SnapshotReason =
  | "update"
  | "delete"
  | "restore"
  | "rename"
  | "import"
  | "health-fix"
  | "merge"
  | "share"
  | "manual";

export const REASON_LABELS: Record<string, string> = {
  update: "修改前",
  delete: "删除前",
  restore: "回滚前",
  rename: "重命名前",
  import: "导入覆盖前",
  "health-fix": "批量修复前",
  merge: "合并前",
  share: "共享变更前",
  manual: "手动备份",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] || reason;
}

/** 内容指纹：用于跳过「内容完全没变」的重复快照 */
export function fingerprintOf(name: any, data: any): string {
  const payload = JSON.stringify({ name: name ?? null, data: data ?? null });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

let indexReady = false;
async function ensureIndexes(db: any) {
  if (indexReady) return;
  indexReady = true;
  try {
    await db.collection(CI_SNAPSHOTS).createIndex({ collection: 1, resourceId: 1, at: -1 });
    await db.collection(CI_SNAPSHOTS).createIndex({ at: -1 });
  } catch (e: any) {
    log(`[snapshot] 索引创建失败（忽略）：${e?.message || e}`, "warn", "auth");
  }
}

async function prune(db: any, collection: string, resourceId: ObjectId) {
  const col = db.collection(CI_SNAPSHOTS);
  const total = await col.countDocuments({ collection, resourceId });
  if (total <= SNAPSHOT_KEEP + PRUNE_SLACK) return;
  const victims = await col
    .find({ collection, resourceId })
    .sort({ at: -1 })
    .skip(SNAPSHOT_KEEP)
    .project({ _id: 1 })
    .toArray();
  if (!victims.length) return;
  await col.deleteMany({ _id: { $in: victims.map((v: any) => v._id) } });
  log(`[snapshot] 清理 ${collection} ${resourceId} 的 ${victims.length} 份旧快照`, "info", "auth");
}

export interface SnapshotInput {
  db: any;
  /** ci_classplans / ci_timelayouts / ci_subjects / ci_settings / ci_policies … */
  collection: string;
  /** 被覆盖或即将被删除的完整文档（改动前的那一份） */
  doc: any;
  reason: SnapshotReason;
  userId?: any;
  detail?: string;
  /** 默认 true：与最近一份内容完全一致时跳过 */
  dedup?: boolean;
}

/**
 * 存一份「改动前」的快照。永远不会抛错 —— 快照失败不应该阻断用户的正常操作，
 * 但会在日志里留下痕迹。
 */
export async function snapshotDoc(input: SnapshotInput): Promise<{ saved: boolean; id?: ObjectId }> {
  const { db, collection, doc, reason } = input;
  if (!db || !doc || !doc._id) return { saved: false };
  try {
    await ensureIndexes(db);
    const col = db.collection(CI_SNAPSHOTS);
    const fingerprint = fingerprintOf(doc.name, doc.data);

    // 删除和回滚是「动作」，即使内容与上一份完全相同也要留痕：
    // 「谁在什么时候把它删了 / 回滚了」本身就是需要被记住的事实。
    const forceRecord = reason === "delete" || reason === "restore";
    if (input.dedup !== false && !forceRecord) {
      const last = await col.findOne(
        { collection, resourceId: doc._id },
        { sort: { at: -1 }, projection: { fingerprint: 1 } },
      );
      if (last && last.fingerprint === fingerprint) return { saved: false };
    }

    const rec = {
      collection,
      resourceId: doc._id,
      name: doc.name ?? null,
      version: doc.version ?? null,
      data: doc.data ?? null,
      userId: input.userId ?? doc.userId ?? null,
      schoolId: doc.schoolId ?? null,
      reason,
      detail: input.detail ?? null,
      fingerprint,
      at: new Date(),
    };
    const r = await col.insertOne(rec);
    await prune(db, collection, doc._id);
    return { saved: true, id: r.insertedId };
  } catch (e: any) {
    log(`[snapshot] 写入失败（已忽略）：${e?.message || e}`, "error", "auth");
    return { saved: false };
  }
}

/** 批量快照（导入、批量修复一类） */
export async function snapshotDocs(
  db: any,
  docs: any[],
  opts: { collection: string; reason: SnapshotReason; userId?: any; detail?: string },
): Promise<number> {
  let saved = 0;
  for (const doc of docs) {
    const r = await snapshotDoc({ db, collection: opts.collection, doc, reason: opts.reason, userId: opts.userId, detail: opts.detail });
    if (r.saved) saved++;
  }
  return saved;
}

/** 某份资源的快照列表（不含 data，列表页不需要那么大的正文） */
export async function listSnapshots(
  db: any,
  opts: { collection: string; resourceId: ObjectId; limit?: number },
) {
  return db
    .collection(CI_SNAPSHOTS)
    .find({ collection: opts.collection, resourceId: opts.resourceId })
    .sort({ at: -1 })
    .limit(Math.min(Math.max(opts.limit || 50, 1), 200))
    .project({ data: 0 })
    .toArray();
}

/** 全站最近的快照（不含 data） */
export async function listRecentSnapshots(
  db: any,
  opts: { limit?: number; collection?: string; userId?: ObjectId } = {},
) {
  const filter: any = {};
  if (opts.collection) filter.collection = opts.collection;
  if (opts.userId) filter.userId = opts.userId;
  return db
    .collection(CI_SNAPSHOTS)
    .find(filter)
    .sort({ at: -1 })
    .limit(Math.min(Math.max(opts.limit || 50, 1), 200))
    .project({ data: 0 })
    .toArray();
}

export async function getSnapshot(db: any, snapshotId: ObjectId) {
  return db.collection(CI_SNAPSHOTS).findOne({ _id: snapshotId });
}

/** 五类教学资源 —— 与 util/ci_resource.ts 的 RESOURCE_LABELS 对应 */
export const BASELINE_COLLECTIONS = [
  "ci_classplans",
  "ci_timelayouts",
  "ci_subjects",
  "ci_settings",
  "ci_policies",
];

/**
 * 基线快照：把「现在这一份」全部存一遍。
 *
 * 用途是给「快照功能上线之前就已经存在的坏数据」留一条退路 ——
 * 自动快照只在改动发生时留下「改动前」，上线前就已经坏了的东西没人存过。
 *
 * `filter` 用来限定范围（普通用户传 visibleFilter(scope)，运维脚本传 {} 表示全库）。
 * 默认 dedup，所以重复执行不会让库变大。
 */
export async function snapshotBaseline(
  db: any,
  opts: { filter?: any; detail?: string; collections?: string[] } = {},
): Promise<{ total: number; saved: number; skipped: number; byCollection: Record<string, { total: number; saved: number }> }> {
  const detail = opts.detail ?? "基线快照";
  const byCollection: Record<string, { total: number; saved: number }> = {};
  let total = 0;
  let saved = 0;

  for (const collection of opts.collections ?? BASELINE_COLLECTIONS) {
    const docs = await db
      .collection(collection)
      .find(opts.filter && Object.keys(opts.filter).length ? opts.filter : {})
      .limit(5000)
      .toArray();
    let savedHere = 0;
    for (const doc of docs) {
      const r = await snapshotDoc({ db, collection, doc, reason: "manual", detail });
      if (r.saved) savedHere++;
    }
    byCollection[collection] = { total: docs.length, saved: savedHere };
    total += docs.length;
    saved += savedHere;
  }

  log(`[snapshot] 基线快照完成：扫描 ${total} 份，新存 ${saved} 份`, "info", "auth");
  return { total, saved, skipped: total - saved, byCollection };
}

