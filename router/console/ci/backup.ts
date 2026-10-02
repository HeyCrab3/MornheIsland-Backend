/**
 * 配置备份：全量导出 / 按班级导出 / 导入恢复（需 JWT）。
 *
 * 备份文件保留原始 _id，因为资源之间靠它关联：
 *   ci_classes.{classplanId,timelayoutId,subjectsId,settingsId,policyId}  → ObjectId
 *   ci_classplans.data.{timelayoutId,subjectsId}                          → **字符串**
 *   ci_plugin_profiles.{plugins,classIds}                                 → ObjectId[]
 * 所以导入时必须重映射，否则关联会全部断掉；字符串引用尤其容易漏。
 *
 * 导入策略：
 *   new（默认）：全部作为新副本，重新生成 id 并重映射引用，不覆盖任何现有数据
 *   overwrite  ：同 _id 且属于当前用户则覆盖；_id 被他人占用或不存在时退回生成新 id
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

export const BACKUP_FORMAT = "mornheisland-backup";
export const BACKUP_VERSION = 1;

/** 备份覆盖的集合：备份键 → 实际集合名 */
const COLLECTIONS: Record<string, string> = {
  classes: "ci_classes",
  classplans: "ci_classplans",
  timelayouts: "ci_timelayouts",
  subjects: "ci_subjects",
  settings: "ci_settings",
  policies: "ci_policies",
  plugins: "ci_plugins",
  pluginProfiles: "ci_plugin_profiles",
};

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

/** 导出时去掉账号字段，文件不绑定某个账号；_id 保留（导入要靠它重映射） */
function stripAccount(doc: any) {
  const { userId: _drop, ...rest } = doc;
  return rest;
}

function emptyData(): Record<string, any[]> {
  const data: Record<string, any[]> = {};
  for (const key of Object.keys(COLLECTIONS)) data[key] = [];
  return data;
}

/** 全量：当前账号下的所有可备份资源 */
async function buildFullBackup(db: any, userId: ObjectId) {
  const data = emptyData();
  for (const [key, col] of Object.entries(COLLECTIONS)) {
    const docs = await db.collection(col).find({ userId }).toArray();
    data[key] = docs.map(stripAccount);
  }
  return data;
}

/**
 * 按班级：班级 + 它引用的资源。
 * 课表 data 里的 timelayoutId / subjectsId 是字符串引用，也要一并带上，
 * 否则导入后课表会指向不存在的时间表和科目。
 */
async function buildClassBackup(db: any, userId: ObjectId, classId: ObjectId) {
  const cls = await db.collection("ci_classes").findOne({ _id: classId, userId });
  if (!cls) return null;

  const data = emptyData();
  data.classes = [stripAccount(cls)];

  const wanted: Record<string, Set<string>> = {
    classplans: new Set(),
    timelayouts: new Set(),
    subjects: new Set(),
    settings: new Set(),
    policies: new Set(),
  };
  const add = (key: string, id: any) => {
    if (id) wanted[key].add(String(id));
  };

  add("classplans", cls.classplanId);
  add("timelayouts", cls.timelayoutId);
  add("subjects", cls.subjectsId);
  add("settings", cls.settingsId);
  add("policies", cls.policyId);

  if (cls.classplanId && ObjectId.isValid(String(cls.classplanId))) {
    const cp = await db
      .collection("ci_classplans")
      .findOne({ _id: new ObjectId(String(cls.classplanId)), userId });
    add("timelayouts", cp?.data?.timelayoutId);
    add("subjects", cp?.data?.subjectsId);
  }

  for (const [key, ids] of Object.entries(wanted)) {
    if (!ids.size) continue;
    const oids = [...ids].filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));
    if (!oids.length) continue;
    const docs = await db.collection(COLLECTIONS[key]).find({ _id: { $in: oids }, userId }).toArray();
    data[key] = docs.map(stripAccount);
  }

  return { data, cls };
}

/** GET /v1/console/ci/backup/export — 全量导出 */
router.get("/v1/console/ci/backup/export", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  try {
    const data = await buildFullBackup(req.db, userId);
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) counts[k] = v.length;

    log(`[backup] 用户 ${userId} 全量导出：${JSON.stringify(counts)}`, "info", "auth");
    res.json({
      code: 0,
      msg: "ok",
      data: {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        scope: { type: "full" },
        counts,
        data,
      },
    });
  } catch (e) {
    log(`[backup/export] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导出失败：" + e });
  }
});

/** GET /v1/console/ci/backup/export/class/:id — 按班级导出 */
router.get("/v1/console/ci/backup/export/class/:id", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ code: 400, msg: "班级 id 无效" });

  try {
    const built = await buildClassBackup(req.db, userId, new ObjectId(req.params.id));
    if (!built) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(built.data)) counts[k] = v.length;

    log(`[backup] 用户 ${userId} 导出班级「${built.cls.name}」：${JSON.stringify(counts)}`, "info", "auth");
    res.json({
      code: 0,
      msg: "ok",
      data: {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        scope: {
          type: "class",
          classId: String(built.cls._id),
          className: built.cls.name || "",
          identity: built.cls.identity || "",
        },
        counts,
        data: built.data,
      },
    });
  } catch (e) {
    log(`[backup/export-class] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导出失败：" + e });
  }
});

/**
 * POST /v1/console/ci/backup/import — 导入恢复
 * body: 备份文件内容（即导出的 data 整体）
 * query: mode=new | overwrite
 */
router.post("/v1/console/ci/backup/import", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

  const backup = req.body?.backup ?? req.body;
  const mode = String(req.query.mode || req.body?.mode || "new") === "overwrite" ? "overwrite" : "new";

  if (!backup || typeof backup !== "object") {
    return res.status(400).json({ code: 400, msg: "缺少备份内容" });
  }
  if (backup.format !== BACKUP_FORMAT) {
    return res.status(400).json({ code: 400, msg: `不是莫宁岛备份文件（format=${backup.format ?? "缺失"}）` });
  }
  if (Number(backup.version) > BACKUP_VERSION) {
    return res.status(400).json({ code: 400, msg: `备份版本 ${backup.version} 高于当前支持的 ${BACKUP_VERSION}，请升级平台` });
  }

  const db = req.db;
  const data = backup.data || {};
  const idMap = new Map<string, ObjectId>(); // 旧 id → 新 id
  const created: Record<string, number> = {};
  const updated: Record<string, number> = {};
  const skipped: { collection: string; name: string; reason: string }[] = [];

  /**
   * 决定这一条用什么 _id：
   *  overwrite 模式尽量沿用原 id（属于自己或位置空着），否则生成新的
   *  plugins 另外按 manifest id 去重，避免重复导入堆副本
   */
  async function resolveId(colKey: string, raw: any) {
    const oldId = String(raw._id || "");
    const col = COLLECTIONS[colKey];

    if (colKey === "plugins" && raw.pluginId) {
      const found = await db.collection(col).findOne({ userId, pluginId: raw.pluginId });
      if (found) return { _id: found._id as ObjectId, existing: true };
    }

    if (mode === "overwrite" && oldId && ObjectId.isValid(oldId)) {
      const oid = new ObjectId(oldId);
      const found = await db.collection(col).findOne({ _id: oid });
      if (!found) return { _id: oid, existing: false };
      if (String(found.userId) === String(userId)) return { _id: oid, existing: true };
      skipped.push({ collection: colKey, name: raw.name || oldId, reason: "id 已被其他账号占用，已另建新副本" });
    }

    return { _id: new ObjectId(), existing: false };
  }

  async function importCollection(colKey: string, remap?: (doc: any) => void) {
    const docs = Array.isArray(data[colKey]) ? data[colKey] : [];
    created[colKey] = 0;
    updated[colKey] = 0;

    for (const raw of docs) {
      const { _id, userId: _drop, ...rest } = raw;
      const resolved = await resolveId(colKey, raw);

      const doc: any = { ...rest, _id: resolved._id, userId };
      if (remap) remap(doc);

      if (resolved.existing) {
        await db.collection(COLLECTIONS[colKey]).replaceOne({ _id: resolved._id }, doc);
        updated[colKey]++;
      } else {
        await db.collection(COLLECTIONS[colKey]).insertOne(doc);
        created[colKey]++;
      }
      if (_id) idMap.set(String(_id), resolved._id);
    }
  }

  /** 把可能是 ObjectId / 字符串的旧 id 映射成新 ObjectId；映射不到就返回 null */
  const mapRef = (v: any): ObjectId | null => {
    if (!v) return null;
    const mapped = idMap.get(String(v));
    return mapped || null;
  };
  /** 字符串形式的引用（课表 data 里那些） */
  const mapRefStr = (v: any): string => {
    if (!v) return "";
    const mapped = idMap.get(String(v));
    return mapped ? String(mapped) : "";
  };

  try {
    // 顺序即依赖顺序：被引用的先建，引用方后建才能映射到新 id
    // 1) 先登记插件（配置组要引用它）
    await importCollection("plugins");

    // 2) 无依赖的资源
    await importCollection("timelayouts");
    await importCollection("subjects");
    await importCollection("settings");
    await importCollection("policies");

    // 3) 课表：data 里是字符串引用
    await importCollection("classplans", (doc) => {
      if (doc.data && typeof doc.data === "object") {
        if (doc.data.timelayoutId) doc.data.timelayoutId = mapRefStr(doc.data.timelayoutId);
        if (doc.data.subjectsId) doc.data.subjectsId = mapRefStr(doc.data.subjectsId);
      }
    });

    // 4) 班级：ObjectId 引用
    await importCollection("classes", (doc) => {
      for (const f of ["classplanId", "timelayoutId", "subjectsId", "settingsId", "policyId"]) {
        doc[f] = mapRef(doc[f]);
      }
    });

    // 5) 插件配置组：引用插件与班级
    await importCollection("pluginProfiles", (doc) => {
      doc.plugins = (doc.plugins || []).map(mapRef).filter(Boolean);
      doc.classIds = (doc.classIds || []).map(mapRef).filter(Boolean);
    });

    const totals = {
      created: Object.values(created).reduce((a, b) => a + b, 0),
      updated: Object.values(updated).reduce((a, b) => a + b, 0),
    };

    log(
      `[backup] 用户 ${userId} 导入备份（mode=${mode}）：新建 ${totals.created}，覆盖 ${totals.updated}`,
      "info",
      "auth",
    );
    res.json({
      code: 0,
      msg: "ok",
      data: {
        mode,
        scope: backup.scope || null,
        created,
        updated,
        skipped,
        totals,
      },
    });
  } catch (e) {
    log(`[backup/import] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导入失败：" + e });
  }
});

export default router;
