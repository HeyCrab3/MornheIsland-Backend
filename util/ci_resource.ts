/**
 * CI 资源通用 CRUD 工具。
 * 课表/时间表/科目/设置/策略共用同一套操作逻辑，仅 collection 名称不同。
 *
 * 可见性（学校维度）：
 *   个人资源 `userId = 我`
 *   学校共享资源 `schoolId ∈ 我加入的学校`
 * 两者取并集。写权限再分一层：个人资源只有本人能改；
 * 学校共享资源要求我是该校 owner/admin，普通成员只读。
 */
import { ObjectId } from "mongodb";
import { log } from "./log";
import { mySchoolIds, getSchoolRole } from "./school";

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

interface Scope {
  userId: ObjectId;
  schoolIds: ObjectId[];
}

async function scopeOf(req: any): Promise<Scope | null> {
  const userId = getUserId(req);
  if (!userId) return null;
  return { userId, schoolIds: await mySchoolIds(req.db, userId) };
}

/** 我能看到的资源：我的 ∪ 我所在学校共享的 */
function visibleFilter(scope: Scope): any {
  if (!scope.schoolIds.length) return { userId: scope.userId };
  return { $or: [{ userId: scope.userId }, { schoolId: { $in: scope.schoolIds } }] };
}

/** 单条资源能不能改 */
async function canWrite(db: any, doc: any, scope: Scope): Promise<{ ok: boolean; reason?: string }> {
  const isCreator = String(doc.userId) === String(scope.userId);
  if (!doc.schoolId) {
    return isCreator ? { ok: true } : { ok: false, reason: "这不是你的资源" };
  }
  // 学校共享资源：创建者始终能改自己的东西；学校管理员也能改
  if (isCreator) return { ok: true };

  const role = await getSchoolRole(db, doc.schoolId, scope.userId);
  if (!role) return { ok: false, reason: "你不在这所学校里" };
  if (role === "member") {
    return {
      ok: false,
      reason: "这份资源是其他成员共享给学校的，只有学校管理员或创建者能修改",
    };
  }
  return { ok: true };
}

/** 我能改的学校 id 集合（owner/admin） */
async function writableSchoolIds(db: any, scope: Scope): Promise<Set<string>> {
  if (!scope.schoolIds.length) return new Set();
  const memberships = await db
    .collection("ci_school_members")
    .find({ userId: scope.userId, schoolId: { $in: scope.schoolIds } })
    .project({ schoolId: 1, role: 1 })
    .toArray();
  return new Set(
    memberships
      .filter((m: any) => m.role === "owner" || m.role === "admin")
      .map((m: any) => String(m.schoolId)),
  );
}

/** 给返回给前端的文档补上归属信息 */
function decorate(doc: any, scope: Scope, writable: Set<string>) {
  const isSchoolLevel = !!doc.schoolId;
  const isMine = String(doc.userId) === String(scope.userId);
  return {
    ...doc,
    isSchoolLevel,
    schoolId: doc.schoolId ? String(doc.schoolId) : null,
    isMine,
    // 前端据此决定「共享」标签和编辑按钮的可用性
    editable: isSchoolLevel ? isMine || writable.has(String(doc.schoolId)) : isMine,
  };
}

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
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });

  const docs = await req.db.collection(collection)
    .find(visibleFilter(scope))
    .sort({ updatedAt: -1 })
    .toArray();

  const writable = await writableSchoolIds(req.db, scope);
  res.json({
    code: 0,
    msg: "ok",
    data: docs.map((d: any) => decorate(d, scope, writable)),
  });
}

/** POST /v1/console/ci/{collection} */
export async function create(req: any, res: any, collection: string) {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
  const userId = scope.userId;

  const { name, data, schoolId } = req.body;
  if (!name) return res.status(400).json({ code: 400, msg: "name 为必填项" });

  // 课表创建时如果传了 data 就必须带 timelayoutId
  if (collection === "ci_classplans" && data !== undefined && !data.timelayoutId) {
    return res.status(400).json({ code: 400, msg: "课表必须关联一个时间表" });
  }

  // 直接创建成学校级资源：必须是该校成员，否则等于往别人学校塞东西
  let schoolOid: ObjectId | null = null;
  if (schoolId) {
    if (!ObjectId.isValid(String(schoolId))) {
      return res.status(400).json({ code: 400, msg: "schoolId 非法" });
    }
    schoolOid = new ObjectId(String(schoolId));
    const role = await getSchoolRole(req.db, schoolOid, userId);
    if (!role) return res.status(403).json({ code: 403, msg: "你不在这所学校里" });
  }

  const doc: any = {
    _id: new ObjectId(),
    userId,
    name,
    data: data ?? {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (schoolOid) doc.schoolId = schoolOid;

  await req.db.collection(collection).insertOne(doc);
  log(
    `[ci] 用户 ${userId} 创建${label(collection)} ${name}${schoolOid ? `（学校级 ${schoolOid}）` : ""}`,
    "info",
    "auth",
  );
  res.json({ code: 0, msg: "ok", data: decorate(doc, scope, schoolOid ? new Set([String(schoolOid)]) : new Set()) });
}

/** GET /v1/console/ci/{collection}/:id — 含用量信息 */
export async function get(req: any, res: any, collection: string) {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });

  const doc = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    ...visibleFilter(scope),
  });
  if (!doc) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const usedBy = await findReferencingClasses(req.db, doc._id, collection);

  // 时间表额外返回被哪些课表引用
  let usedByClassplans: any[] = [];
  if (collection === "ci_timelayouts") {
    usedByClassplans = await findReferencingClassplans(req.db, doc._id);
  }

  const writable = await writableSchoolIds(req.db, scope);
  res.json({
    code: 0,
    msg: "ok",
    data: { ...decorate(doc, scope, writable), usedBy, usedByClassplans },
  });
}

/** PUT /v1/console/ci/{collection}/:id */
export async function update(req: any, res: any, collection: string) {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
  const userId = scope.userId;

  const { name, data } = req.body;
  const existing = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    ...visibleFilter(scope),
  });
  if (!existing) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const perm = await canWrite(req.db, existing, scope);
  if (!perm.ok) return res.status(403).json({ code: 403, msg: perm.reason || "无权修改" });

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
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });

  const resourceId = new ObjectId(req.params.id);
  // 先确认这份资源我看得到，否则等于能翻别人资源的版本记录
  const visible = await req.db.collection(collection).findOne(
    { _id: resourceId, ...visibleFilter(scope) },
    { projection: { _id: 1 } },
  );
  if (!visible) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const historyDocs = await req.db.collection("ci_history")
    .find({ resourceCollection: collection, resourceId })
    .sort({ version: -1 })
    .project({ version: 1, name: 1, createdAt: 1 })
    .toArray();

  res.json({ code: 0, msg: "ok", data: historyDocs });
}

/** GET /v1/console/ci/{collection}/:id/history/:version — 查看某版本内容 */
export async function getHistoryVersion(req: any, res: any, collection: string) {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });

  const resourceId = new ObjectId(req.params.id);
  const visible = await req.db.collection(collection).findOne(
    { _id: resourceId, ...visibleFilter(scope) },
    { projection: { _id: 1 } },
  );
  if (!visible) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const doc = await req.db.collection("ci_history").findOne({
    resourceCollection: collection,
    resourceId,
    version: parseInt(req.params.version),
  });
  if (!doc) return res.status(404).json({ code: 404, msg: "版本不存在" });

  res.json({ code: 0, msg: "ok", data: doc });
}

/** POST /v1/console/ci/{collection}/:id/restore/:version — 恢复到某版本 */
export async function restore(req: any, res: any, collection: string) {
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
  const userId = scope.userId;

  const existing = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    ...visibleFilter(scope),
  });
  if (!existing) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const perm = await canWrite(req.db, existing, scope);
  if (!perm.ok) return res.status(403).json({ code: 403, msg: perm.reason || "无权修改" });

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
  const scope = await scopeOf(req);
  if (!scope) return res.status(401).json({ code: 401, msg: "请先登录" });
  const userId = scope.userId;

  const doc = await req.db.collection(collection).findOne({
    _id: new ObjectId(req.params.id),
    ...visibleFilter(scope),
  });
  if (!doc) return res.status(404).json({ code: 404, msg: `${label(collection)}不存在` });

  const perm = await canWrite(req.db, doc, scope);
  if (!perm.ok) return res.status(403).json({ code: 403, msg: perm.reason || "无权删除" });

  // 学校级资源被同校其他班用着时，删掉影响的是别人的班 — 提示改成先取消关联
  if (doc.schoolId) {
    const schoolClasses = await findReferencingClasses(req.db, doc._id, collection);
    if (schoolClasses.length > 0) {
      const names = schoolClasses.map((c: any) => c.name || c.identity).join("、");
      return res.status(409).json({
        code: 409,
        msg: `无法删除：学校里有班级正在使用此${label(collection)}（${names}）。请先取消关联后再试。`,
        data: { usedBy: schoolClasses },
      });
    }
  }

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
