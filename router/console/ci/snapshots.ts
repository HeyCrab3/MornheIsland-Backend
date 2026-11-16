/**
 * 资源快照：查看 + 回滚。
 *
 * 与 history.ts（正式版本历史）互补：
 *   - 这里能看到「删除前」「导入覆盖前」「批量修复前」的那些存档；
 *   - 资源已经被删掉时，快照依然存在，可以据此把整份资源原地恢复回来。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { scopeOf, visibleFilter, canWrite, validateResourceReferences } from "../../../util/ci_resource";
import {
  CI_SNAPSHOTS,
  getSnapshot,
  listSnapshots,
  reasonLabel,
  snapshotBaseline,
  snapshotDoc,
} from "../../../util/ci_snapshot";
import { mySchoolIds, getSchoolRole } from "../../../util/school";
import { log } from "../../../util/log";

const router = express.Router();

/** 与 history.ts 保持一致：不能靠 `ci_${type}s` 拼集合名 */
const COLLECTION: Record<string, string> = {
  classplan: "ci_classplans",
  timelayout: "ci_timelayouts",
  subjects: "ci_subjects",
  settings: "ci_settings",
  policy: "ci_policies",
};

function toOid(v: string): ObjectId | null {
  try {
    return new ObjectId(v);
  } catch {
    return null;
  }
}

/**
 * 快照能不能被这个人操作。
 * `live` 必须是**已经按可见性过滤过**的文档（看不到就是 null）：
 *   - 资源还在 → 按资源的写权限判；
 *   - 资源已经没了 → 按快照自身的归属判（原主或所在学校的管理员）。
 */
async function snapshotPermission(
  db: any,
  scope: any,
  live: any,
  snap: any,
): Promise<{ ok: boolean; reason?: string; writable: boolean }> {
  if (live) {
    const perm = await canWrite(db, live, scope);
    return { ok: true, writable: perm.ok, reason: perm.reason };
  }
  const mine = String(snap.userId) === String(scope.userId);
  if (mine) return { ok: true, writable: true };
  if (snap.schoolId && scope.schoolIds.some((s: any) => String(s) === String(snap.schoolId))) {
    const role = await getSchoolRole(db, snap.schoolId, scope.userId);
    if (role === "owner" || role === "admin") return { ok: true, writable: true };
    return { ok: true, writable: false, reason: "只有学校管理员或创建者能恢复" };
  }
  return { ok: false, writable: false };
}

// —— 基线快照：给自己可见的现有资源各存一份（幂等） ——
router.post("/v1/console/ci/snapshots/baseline", async (req: any, res: any) => {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });

  const result = await snapshotBaseline(req.db, {
    filter: visibleFilter(scope),
    detail: "基线快照（快照功能启用前的现有数据）",
  });
  res.json({ code: 0, msg: "ok", data: result });
});

// —— 全站最近的快照（不含正文） ——
router.get("/v1/console/ci/snapshots/recent", async (req: any, res: any) => {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
  const schoolIds = await mySchoolIds(req.db, scope.userId);

  const filter: any = {
    $or: [
      { userId: scope.userId },
      ...(schoolIds.length ? [{ schoolId: { $in: schoolIds } }] : []),
    ],
  };
  const wantCollection = String(req.query.collection || "").trim();
  if (wantCollection) filter.collection = wantCollection;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || "50"), 10) || 50, 1), 200);
  const docs = await req.db
    .collection(CI_SNAPSHOTS)
    .find(filter)
    .sort({ at: -1 })
    .limit(limit)
    .project({ data: 0 })
    .toArray();

  res.json({
    code: 0,
    msg: "ok",
    data: docs.map((d: any) => ({
      ...d,
      resourceId: String(d.resourceId),
      userId: d.userId ? String(d.userId) : null,
      schoolId: d.schoolId ? String(d.schoolId) : null,
      reasonLabel: reasonLabel(d.reason),
    })),
  });
});

for (const [type, collection] of Object.entries(COLLECTION)) {
  // 快照列表（资源被删后仍可查）
  router.get(`/v1/console/ci/${type}/:id/snapshots`, async (req: any, res: any) => {
    const scope = await scopeOf(req);
    if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
    const resourceId = toOid(req.params.id);
    if (!resourceId) return res.status(400).json({ code: 400, msg: "id 不合法" });

    const live = await req.db.collection(collection).findOne({ _id: resourceId, ...visibleFilter(scope) });
    if (!live) {
      // 资源没了，但可能还有快照 —— 有就当作「已删除资源」返回
      const anySnap = await req.db
        .collection(CI_SNAPSHOTS)
        .findOne({ collection, resourceId }, { sort: { at: -1 } });
      if (!anySnap) return res.status(404).json({ code: 404, msg: "资源不存在" });
      const perm = await snapshotPermission(req.db, scope, null, anySnap);
      if (!perm.ok) return res.status(404).json({ code: 404, msg: "资源不存在" });
    }

    const docs = await listSnapshots(req.db, { collection, resourceId, limit: parseInt(String(req.query.limit || "50"), 10) });
    res.json({
      code: 0,
      msg: "ok",
      data: {
        deleted: !live,
        resource: live
          ? { _id: String(live._id), name: live.name, version: live.version }
          : { _id: String(resourceId), name: docs[0]?.name ?? null, version: null },
        snapshots: docs.map((d: any) => ({
          ...d,
          resourceId: String(d.resourceId),
          userId: d.userId ? String(d.userId) : null,
          schoolId: d.schoolId ? String(d.schoolId) : null,
          reasonLabel: reasonLabel(d.reason),
        })),
      },
    });
  });

  // 查看某份快照的完整内容
  router.get(`/v1/console/ci/${type}/:id/snapshots/:snapshotId`, async (req: any, res: any) => {
    const scope = await scopeOf(req);
    if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
    const resourceId = toOid(req.params.id);
    const snapshotId = toOid(req.params.snapshotId);
    if (!resourceId || !snapshotId) return res.status(400).json({ code: 400, msg: "id 不合法" });

    const snap = await getSnapshot(req.db, snapshotId);
    if (!snap || snap.collection !== collection || String(snap.resourceId) !== String(resourceId)) {
      return res.status(404).json({ code: 404, msg: "快照不存在" });
    }
    const live = await req.db.collection(collection).findOne({ _id: resourceId, ...visibleFilter(scope) });
    const perm = await snapshotPermission(req.db, scope, live, snap);
    if (!perm.ok) return res.status(404).json({ code: 404, msg: "快照不存在" });

    res.json({ code: 0, msg: "ok", data: { ...snap, reasonLabel: reasonLabel(snap.reason) } });
  });

  // 回滚到某份快照（资源已被删除时会原地重建）
  router.post(`/v1/console/ci/${type}/:id/snapshots/:snapshotId/restore`, async (req: any, res: any) => {
    const scope = await scopeOf(req);
    if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
    const userId = scope.userId;
    const resourceId = toOid(req.params.id);
    const snapshotId = toOid(req.params.snapshotId);
    if (!resourceId || !snapshotId) return res.status(400).json({ code: 400, msg: "id 不合法" });

    const snap = await getSnapshot(req.db, snapshotId);
    if (!snap || snap.collection !== collection || String(snap.resourceId) !== String(resourceId)) {
      return res.status(404).json({ code: 404, msg: "快照不存在" });
    }
    const liveNow = await req.db.collection(collection).findOne({ _id: resourceId, ...visibleFilter(scope) });
    const perm = await snapshotPermission(req.db, scope, liveNow, snap);
    if (!perm.ok) return res.status(404).json({ code: 404, msg: "快照不存在" });
    if (!perm.writable) return res.status(403).json({ code: 403, msg: perm.reason || "无权恢复" });

    if (collection === "ci_classplans") {
      const refs = await validateResourceReferences(req.db, scope, snap.data);
      if (!refs.ok) return res.status(refs.status).json({ code: refs.status, msg: refs.msg });
    }

    const live = await req.db.collection(collection).findOne({ _id: resourceId });

    // 先把当前状态也存一份，避免「回滚之后才发现回滚错了」
    if (live) {
      await snapshotDoc({
        db: req.db,
        collection,
        doc: live,
        reason: "restore",
        userId,
        detail: `回滚到 ${snap.at?.toISOString?.() ?? ""} 的快照之前`,
      });
    }

    const nextVersion = (live?.version ?? 0) + 1;
    await req.db.collection(collection).updateOne(
      { _id: resourceId },
      {
        $set: {
          name: snap.name ?? live?.name ?? "未命名",
          data: snap.data ?? null,
          version: nextVersion,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          userId: snap.userId ?? userId,
          schoolId: snap.schoolId ?? null,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    log(
      `[snapshot] 用户 ${userId} 从快照恢复${live ? "" : "（资源曾已删除）"} ${collection} ${snap.name} → v${nextVersion}`,
      "info",
      "auth",
    );
    res.json({ code: 0, msg: "ok", data: { version: nextVersion, recreated: !live } });
  });
}

export default router;
