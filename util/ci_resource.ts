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
import { normalizeClassPlanData, normalizeTimeLayoutData } from "./ci_data";
import { snapshotDoc } from "./ci_snapshot";
import {
  activeGrantsReceived,
  grantCoversResource,
  type GrantLite,
} from "./ci_grant";

/**
 * 资源数据入库前的兜底规范化。
 * 只处理「会让客户端反序列化失败」的硬伤（Guid 字段为 null / 数组元素为 null），
 * 不改其它任何字段 —— 结构上的东西我们不懂语义，一律原样保留。
 */
function sanitizeResourceData(collection: string, data: any): any {
  if (!data || typeof data !== "object") return data;
  if (collection === "ci_classplans") {
    const r = normalizeClassPlanData(data);
    if (r.fixed) {
      log(
        `[ci] 课表数据里修正了 ${r.fixed} 处 Guid 为 null 的字段（否则客户端会反序列化失败）`,
        "warn",
        "auth",
      );
    }
  } else if (collection === "ci_timelayouts") {
    const r = normalizeTimeLayoutData(data);
    if (r.fixed) {
      log(`[ci] 时间表数据里修正了 ${r.fixed} 处 Guid 为 null 的字段`, "warn", "auth");
    }
  }
  return data;
}

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

export interface Scope {
  userId: ObjectId;
  schoolIds: ObjectId[];
  /** 别人委托给我的班级授权（IAM 第一阶段） */
  grants: GrantLite[];
  /** 受托班级引用的资源 id（可见） */
  grantResourceIds: ObjectId[];
  grantResourceSet: Set<string>;
  /** 其中我有权编辑 / 删除的 */
  grantEditableSet: Set<string>;
  grantDeletableSet: Set<string>;
}

/**
 * 算出受托班级连带可见的资源。
 *
 * 资源本身没有 classId —— 班级通过 classplanId/timelayoutId/... 反过来引用资源，
 * 所以要先把「受托班级」引用的资源收集起来，再反查每个资源还被哪些班引用，
 * 才能判断「改它会不会影响到受托范围外的班」。
 */
async function loadGrantScope(db: any, grants: GrantLite[], scope: Scope) {
  const fields = Object.values(CLASS_REF_FIELD);
  const classIds = [...new Set(grants.flatMap((g) => g.classIds.map((c) => String(c))))]
    .map((s) => new ObjectId(s));
  if (!classIds.length) return;

  const proj: any = { _id: 1 };
  for (const f of fields) proj[f] = 1;

  const myClasses = await db.collection("ci_classes").find({ _id: { $in: classIds } }).project(proj).toArray();
  const resIds = new Map<string, ObjectId>();
  for (const c of myClasses) {
    for (const f of fields) if (c[f]) resIds.set(String(c[f]), c[f]);
  }
  if (!resIds.size) return;

  const refOr = fields.map((f) => ({ [f]: { $in: [...resIds.values()] } }));
  const refs = await db.collection("ci_classes").find({ $or: refOr }).project(proj).toArray();

  const ownersOf = new Map<string, Set<string>>(); // 资源 id → 引用它的班级 id
  for (const c of refs) {
    for (const f of fields) {
      if (!c[f]) continue;
      const key = String(c[f]);
      if (!ownersOf.has(key)) ownersOf.set(key, new Set());
      ownersOf.get(key)!.add(String(c._id));
    }
  }

  for (const [rid, oid] of resIds) {
    scope.grantResourceIds.push(oid);
    scope.grantResourceSet.add(rid);
    const owners = ownersOf.get(rid) || new Set<string>();
    for (const g of grants) {
      const mine = new Set(g.classIds.map((c) => String(c)));
      const inside = [...owners].filter((id) => mine.has(id));
      if (!inside.length) continue;
      const allInside = inside.length === owners.size;
      if (!allInside && !g.allowSharedEdit) continue; // 共享资源默认不给改
      if (g.caps.includes("resource.edit")) scope.grantEditableSet.add(rid);
      if (g.caps.includes("resource.delete")) scope.grantDeletableSet.add(rid);
    }
  }
}

export async function scopeOf(req: any): Promise<Scope | null> {
  const userId = getUserId(req);
  if (!userId) return null;
  const schoolIds = await mySchoolIds(req.db, userId);
  const grants = await activeGrantsReceived(req.db, userId);
  const scope: Scope = {
    userId,
    schoolIds,
    grants,
    grantResourceIds: [],
    grantResourceSet: new Set(),
    grantEditableSet: new Set(),
    grantDeletableSet: new Set(),
  };
  if (grants.length) await loadGrantScope(req.db, grants, scope);
  return scope;
}

/** 我能看到的资源：我的 ∪ 我所在学校共享的 ∪ 受托班级引用的 */
export function visibleFilter(scope: Scope): any {
  const or: any[] = [{ userId: scope.userId }];
  if (scope.schoolIds.length) or.push({ schoolId: { $in: scope.schoolIds } });
  if (scope.grantResourceIds.length) or.push({ _id: { $in: scope.grantResourceIds } });
  return or.length === 1 ? or[0] : { $or: or };
}

/** 单条资源能不能改 */
export async function canWrite(
  db: any,
  doc: any,
  scope: Scope,
  cap: "resource.edit" | "resource.delete" = "resource.edit",
): Promise<{ ok: boolean; reason?: string }> {
  const isCreator = String(doc.userId) === String(scope.userId);

  if (!doc.schoolId) {
    if (isCreator) return { ok: true };
  } else {
    // 学校共享资源：创建者始终能改自己的东西；学校管理员也能改
    if (isCreator) return { ok: true };
    const role = await getSchoolRole(db, doc.schoolId, scope.userId);
    if (role && role !== "member") return { ok: true };
    if (!role) {
      // 可能只是受托账号，落到下面按委托判
    }
  }

  // 委托：资源在我受托班级的引用范围内才允许
  if (scope.grantResourceSet.has(String(doc._id))) {
    const r = await grantCoversResource(db, scope.grants, doc, CLASS_REF_FIELD, cap);
    if (r.ok) return { ok: true };
    return { ok: false, reason: r.reason || "无权修改" };
  }

  if (!doc.schoolId) return { ok: false, reason: "这不是你的资源" };
  const role = await getSchoolRole(db, doc.schoolId, scope.userId);
  if (!role) return { ok: false, reason: "你不在这所学校里" };
  return {
    ok: false,
    reason: "这份资源是其他成员共享给学校的，只有学校管理员或创建者能修改",
  };
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
  const key = String(doc._id);
  const viaGrant = scope.grantResourceSet.has(key);
  return {
    ...doc,
    isSchoolLevel,
    schoolId: doc.schoolId ? String(doc.schoolId) : null,
    isMine,
    /** 我是通过别人的班级委托看到这份资源的 */
    viaGrant,
    // 前端据此决定「共享」标签和编辑按钮的可用性
    editable: isSchoolLevel
      ? isMine || writable.has(String(doc.schoolId)) || scope.grantEditableSet.has(key)
      : isMine || scope.grantEditableSet.has(key),
    deletable:
      isMine || (isSchoolLevel && writable.has(String(doc.schoolId))) || scope.grantDeletableSet.has(key),
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
    // 兜底：Guid 字段一律不许为 null（`"SubjectId": null` 会让 ClassIsland
    // 反序列化整个档案时抛异常）。详见 util/ci_data.ts 的说明。
    data: sanitizeResourceData(collection, data ?? {}),
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
  if (data !== undefined) set.data = sanitizeResourceData(collection, data);

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

  // 快照：与 ci_history 互为冗余，导入/批量修复等旁路也能在这里查到「改之前」
  await snapshotDoc({
    db: req.db,
    collection,
    doc: existing,
    reason: "update",
    userId,
    detail: `更新后为 v${nextVersion}`,
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

  await snapshotDoc({
    db: req.db,
    collection,
    doc: existing,
    reason: "restore",
    userId,
    detail: `回滚到 v${historyDoc.version} 之前`,
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

  const perm = await canWrite(req.db, doc, scope, "resource.delete");
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

  // 删除前存档：删掉的资源不会进 ci_history，只有这里留得住
  await snapshotDoc({
    db: req.db,
    collection,
    doc,
    reason: "delete",
    userId,
    detail: `删除 v${doc.version ?? "?"}`,
  });

  await req.db.collection(collection).deleteOne({ _id: doc._id });
  log(`[ci] 用户 ${userId} 删除${label(collection)} ${doc.name}`, "info", "auth");
  res.json({ code: 0, msg: "ok" });
}
