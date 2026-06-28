/**
 * CI 资源通用 CRUD 工具。
 * 课表/时间表/科目/设置/策略共用同一套操作逻辑，仅 collection 名称不同。
 */
import { ObjectId } from "mongodb";
import { log } from "./log";

const RESOURCE_LABELS: Record<string, string> = {
  ci_classplans: "课表",
  ci_timelayouts: "时间表",
  ci_subjects: "科目",
  ci_settings: "设置",
  ci_policies: "策略",
};

/** collection → ci_classes 中的引用字段名 */
const CLASS_REF_FIELD: Record<string, string> = {
  ci_classplans: "classplanId",
  ci_timelayouts: "timelayoutId",
  ci_subjects: "subjectsId",
  ci_settings: "settingsId",
  ci_policies: "policyId",
};

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

const label = (col: string) => RESOURCE_LABELS[col] || col;

/**
 * 查询哪些班级引用了该资源。
 */
async function findReferencingClasses(db: any, resourceId: ObjectId, collection: string) {
  const refField = CLASS_REF_FIELD[collection];
  if (!refField) return [];
  return db.collection("ci_classes").find({ [refField]: resourceId })
    .project({ identity: 1, name: 1 })
    .toArray();
}

/** GET /v1/console/ci/{collection}/list */
export async function list(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  const docs = await req.db.collection(collection)
    .find({ userId })
    .sort({ updatedAt: -1 })
    .toArray();
  res.json({ code: 0, msg: "ok", data: docs });
}

/** POST /v1/console/ci/{collection} */
export async function create(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { name, data } = req.body;
  if (!name) return res.status(400).json({ code: 400, msg: "name 为必填项" });

  // 课表创建时如果传了 data 就必须带 timelayoutId
  if (collection === "ci_classplans" && data !== undefined && !data.timelayoutId) {
    return res.status(400).json({ code: 400, msg: "课表必须关联一个时间表" });
  }

  const doc = {
    _id: new ObjectId(),
    userId,
    name,
    data: data ?? {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await req.db.collection(collection).insertOne(doc);
  log(`[ci] 用户 ${userId} 创建${label(collection)} ${name}`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: doc });
}

/** GET /v1/console/ci/{collection}/:id — 含用量信息 */
export async function get(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const doc = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    userId,
  });
  if (!doc) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const usedBy = await findReferencingClasses(req.db, doc._id, collection);

  // 时间表额外返回被哪些课表引用
  let usedByClassplans: any[] = [];
  if (collection === "ci_timelayouts") {
    usedByClassplans = await findReferencingClassplans(req.db, doc._id);
  }

  res.json({ code: 0, msg: "ok", data: { ...doc, usedBy, usedByClassplans } });
}

/** PUT /v1/console/ci/{collection}/:id */
export async function update(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const { name, data } = req.body;
  const existing = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    userId,
  });
  if (!existing) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  // 课表必须绑定时间表
  if (collection === "ci_classplans" && data && !data.timelayoutId) {
    return res.status(400).json({ code: 400, msg: "课表必须关联一个时间表" });
  }

  const nextVersion = existing.version + 1;
  const set: any = { updatedAt: new Date(), version: nextVersion };
  if (name !== undefined) set.name = name;
  if (data !== undefined) set.data = data;

  // 保存历史版本
  await req.db.collection("ci_history").insertOne({
    resourceCollection: collection,
    resourceId: existing._id,
    version: existing.version,
    name: existing.name,
    data: existing.data,
    userId,
    createdAt: new Date(),
  });

  await req.db.collection(collection).updateOne(
    { _id: existing._id },
    { $set: set },
  );
  log(`[ci] 用户 ${userId} 更新${label(collection)} ${existing.name} → v${nextVersion}`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { version: nextVersion } });
}

/** GET /v1/console/ci/{collection}/:id/history — 历史版本列表 */
export async function history(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const historyDocs = await req.db.collection("ci_history")
    .find({ resourceCollection: collection, resourceId: new ObjectId(req.params.id) })
    .sort({ version: -1 })
    .project({ version: 1, name: 1, createdAt: 1 })
    .toArray();

  res.json({ code: 0, msg: "ok", data: historyDocs });
}

/** GET /v1/console/ci/{collection}/:id/history/:version — 查看某版本内容 */
export async function getHistoryVersion(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const doc = await req.db.collection("ci_history").findOne({
    resourceCollection: collection,
    resourceId: new ObjectId(req.params.id),
    version: parseInt(req.params.version),
  });
  if (!doc) return res.status(404).json({ code: 404, msg: "版本不存在" });

  res.json({ code: 0, msg: "ok", data: doc });
}

/** POST /v1/console/ci/{collection}/:id/restore/:version — 恢复到某版本 */
export async function restore(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const existing = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    userId,
  });
  if (!existing) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const historyDoc = await req.db.collection("ci_history").findOne({
    resourceCollection: collection,
    resourceId: existing._id,
    version: parseInt(req.params.version),
  });
  if (!historyDoc) return res.status(404).json({ code: 404, msg: "版本不存在" });

  // 把当前版本也存进历史
  await req.db.collection("ci_history").insertOne({
    resourceCollection: collection,
    resourceId: existing._id,
    version: existing.version,
    name: existing.name,
    data: existing.data,
    userId,
    createdAt: new Date(),
  });

  const nextVersion = existing.version + 1;
  await req.db.collection(collection).updateOne(
    { _id: existing._id },
    { $set: { data: historyDoc.data, name: historyDoc.name, version: nextVersion, updatedAt: new Date() } },
  );
  log(`[ci] 用户 ${userId} 恢复${label(collection)} ${existing.name} → v${historyDoc.version} (now v${nextVersion})`, "info", "auth");
  res.json({ code: 0, msg: "ok", data: { version: nextVersion } });
}

/** 额外检查：时间表是否被课表引用 */
async function findReferencingClassplans(db: any, timelayoutId: ObjectId) {
  return db.collection("ci_classplans")
    .find({ "data.timelayoutId": timelayoutId.toString() })
    .project({ name: 1 })
    .toArray();
}

/** DELETE /v1/console/ci/{collection}/:id — 检查引用后删除 */
export async function remove(req: any, res: any, collection: string) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const doc = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    userId,
  });
  if (!doc) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  // 检查班级引用
  const usedBy = await findReferencingClasses(req.db, doc._id, collection);
  if (usedBy.length > 0) {
    const names = usedBy.map((c: any) => c.name || c.identity).join("、");
    return res.status(409).json({
      code: 409,
      msg: `无法删除：以下班级正在使用此${label(collection)}：${names}。请先取消关联后再试。`,
      data: { usedBy },
    });
  }

  // 时间表额外检查课表引用
  if (collection === "ci_timelayouts") {
    const usedByCp = await findReferencingClassplans(req.db, doc._id);
    if (usedByCp.length > 0) {
      const names = usedByCp.map((c: any) => c.name).join("、");
      return res.status(409).json({
        code: 409,
        msg: `无法删除：以下课表引用了此时间表：${names}。请先修改课表后再试。`,
        data: { usedBy: usedByCp },
      });
    }
  }

  await req.db.collection(collection).deleteOne({ _id: doc._id });
  log(`[ci] 用户 ${userId} 删除${label(collection)} ${doc.name}`, "info", "auth");
  res.json({ code: 0, msg: "ok" });
}
