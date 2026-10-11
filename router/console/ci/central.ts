/**
 * Class Widgets 2 集控 —— 控制台管理侧。
 *
 * 模型映射：**班级 = CW2 的分组**。管理员给某个班级签发配对码，
 * 教室机器上的 CW2 集控插件用该码配对，之后从 /api/v1/device/sync 拉课表、策略与命令。
 *
 * 全部端点需要 JWT，且只能操作自己名下的班级（与 router/console/ci/class.ts 一致）。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import {
  CC_ACKS,
  CC_COMMANDS,
  CC_DEVICES,
  CC_PAIRING_CODES,
  CC_REVISIONS,
  deriveScheduleForClass,
  generatePairingCode,
  idStr,
  nextCommandCursor,
  sha256Hex,
  toObjectId,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEVICE_ONLINE_TIMEOUT_SECONDS,
} from "../../../util/cw2_central";
import { validateCw2Policy, validateCw2Schedule } from "../../../util/cw2_schedule";

const router = express.Router();

/** 参考实现允许的命令白名单（CommandCreate.type） */
const COMMAND_TYPES = new Set([
  "refresh_status",
  "restart_app",
  "upload_diagnostics",
  "show_notification",
  "trigger_action",
  "apply_config",
  "switch_schedule",
  "request_schedule_snapshot",
  "apply_class_swap",
  "restore_class_swap",
]);

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

function ok(res: any, data: any = null) {
  res.json({ code: 0, msg: "ok", data });
}

function fail(res: any, status: number, msg: string) {
  res.status(status).json({ code: status, msg });
}

/** 取班级并校验归属，避免用别人的 classId 操作 */
async function ownedClass(req: any, res: any, classId: any): Promise<any | null> {
  const userId = getUserId(req);
  if (!userId) {
    fail(res, 401, "请先登录");
    return null;
  }
  const oid = toObjectId(classId);
  if (!oid) {
    fail(res, 400, "classId 非法");
    return null;
  }
  const cls = await req.db.collection("ci_classes").findOne({ _id: oid, userId });
  if (!cls) {
    fail(res, 404, "班级不存在");
    return null;
  }
  return cls;
}

/** GET /protocol — 供前端展示设备该填什么地址 */
router.get("/v1/console/ci/central/protocol", (req, res) => {
  ok(res, {
    name: "Class Widgets 2 Central Control",
    protocolVersion: 1,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    endpoints: {
      pair: "/api/v1/device/pair",
      sync: "/api/v1/device/sync",
      unpair: "/api/v1/device/unpair",
      diagnostics: "/api/v1/device/diagnostics",
    },
    commandTypes: [...COMMAND_TYPES],
    note: "设备侧插件尚未公开；本实现按 contracts/ 对齐，供拿到插件后直接接入。",
  });
});

/** POST /pairing-code — 给某个班级签发一次性配对码 */
router.post("/v1/console/ci/central/pairing-code", async (req, res) => {
  try {
    const cls = await ownedClass(req, res, req.body?.classId);
    if (!cls) return;

    const minutes = Math.min(Math.max(Number(req.body?.expiresInMinutes) || 15, 1), 1440);
    const code = generatePairingCode();
    const now = new Date();
    await req.db.collection(CC_PAIRING_CODES).insertOne({
      _id: new ObjectId(),
      userId: getUserId(req),
      classId: cls._id,
      codeHash: sha256Hex(code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + minutes * 60 * 1000),
      consumedAt: null,
    });
    log(`[cw2] 为班级 ${cls.name || idStr(cls._id)} 签发配对码`, "info", "auth");
    ok(res, {
      code,
      classId: idStr(cls._id),
      className: cls.name || "",
      expiresAt: new Date(now.getTime() + minutes * 60 * 1000).toISOString(),
      expiresInMinutes: minutes,
    });
  } catch (e) {
    log(`[cw2/pairing-code] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** GET /devices — 设备列表（含在离线判定与最近错误） */
router.get("/v1/console/ci/central/devices", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "请先登录");

    const query: any = { userId };
    if (req.query.classId) {
      const oid = toObjectId(req.query.classId);
      if (!oid) return fail(res, 400, "classId 非法");
      query.classId = oid;
    }
    const devices = await req.db.collection(CC_DEVICES).find(query).sort({ createdAt: -1 }).toArray();
    const classIds = [...new Set(devices.map((d: any) => idStr(d.classId)).filter(Boolean))];
    const classes = await req.db
      .collection("ci_classes")
      .find({ _id: { $in: classIds.map((x) => new ObjectId(x)) } })
      .toArray();
    const nameOf = new Map(classes.map((c: any) => [idStr(c._id), c.name || ""]));

    const now = Date.now();
    const timeoutMs = DEVICE_ONLINE_TIMEOUT_SECONDS * 1000;
    ok(
      res,
      devices.map((d: any) => ({
        id: idStr(d._id),
        classId: idStr(d.classId),
        className: nameOf.get(idStr(d.classId)) || "",
        installationId: d.installationId || "",
        name: d.name || "",
        revoked: !!d.revoked,
        online: !d.revoked && d.lastSeen && now - new Date(d.lastSeen).getTime() < timeoutMs,
        lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
        appVersion: d.appVersion || "",
        pluginVersion: d.pluginVersion || "",
        platform: d.platform || "",
        runtimeStatus: d.runtimeStatus || "",
        runtimeTitle: d.runtimeTitle || "",
        scheduleRevision: Number(d.scheduleRevision) || 0,
        policyRevision: Number(d.policyRevision) || 0,
        lastError: d.lastError || "",
      })),
    );
  } catch (e) {
    log(`[cw2/devices] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** POST /devices/:id/revoke */
router.post("/v1/console/ci/central/devices/:id/revoke", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "请先登录");
    const oid = toObjectId(req.params.id);
    if (!oid) return fail(res, 400, "设备 ID 非法");
    const result = await req.db.collection(CC_DEVICES).updateOne(
      { _id: oid, userId },
      { $set: { revoked: true, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return fail(res, 404, "设备不存在");
    ok(res);
  } catch (e) {
    log(`[cw2/revoke] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** GET /preview/schedule?classId= — 只转换不发布，用来先看警告/错误 */
router.get("/v1/console/ci/central/preview/schedule", async (req, res) => {
  try {
    const cls = await ownedClass(req, res, req.query.classId);
    if (!cls) return;
    const { schedule, warnings, errors } = await deriveScheduleForClass(req.db, cls);
    ok(res, { schedule, warnings, errors });
  } catch (e) {
    log(`[cw2/preview] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** GET /revisions?classId= — 当前已发布的课表/策略版本 */
router.get("/v1/console/ci/central/revisions", async (req, res) => {
  try {
    const cls = await ownedClass(req, res, req.query.classId);
    if (!cls) return;
    const revisions = await req.db.collection(CC_REVISIONS).find({ classId: cls._id }).toArray();
    const pick = (kind: string) => {
      const r = revisions.find((x: any) => x.kind === kind);
      return r ? { revision: Number(r.revision) || 0, updatedAt: new Date(r.updatedAt).toISOString() } : null;
    };
    ok(res, { schedule: pick("schedule"), policy: pick("policy") });
  } catch (e) {
    log(`[cw2/revisions] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/**
 * POST /publish/schedule
 * body: { classId, schedule? }
 * 不给 schedule 就按班级已关联的 ClassIsland 资源自动转换；给了就用给的（逃生舱）。
 */
router.post("/v1/console/ci/central/publish/schedule", async (req, res) => {
  try {
    const cls = await ownedClass(req, res, req.body?.classId);
    if (!cls) return;

    let schedule = req.body?.schedule;
    let warnings: string[] = [];
    if (!schedule) {
      const derived = await deriveScheduleForClass(req.db, cls);
      if (derived.errors.length) return fail(res, 400, derived.errors.join("；"));
      schedule = derived.schedule;
      warnings = derived.warnings;
    }

    const errors = validateCw2Schedule(schedule);
    if (errors.length) return fail(res, 400, `课表未通过校验：${errors.slice(0, 5).join("；")}`);

    const current = await req.db
      .collection(CC_REVISIONS)
      .findOne({ classId: cls._id, kind: "schedule" });
    const revision = (Number(current?.revision) || 0) + 1;
    const now = new Date();
    await req.db.collection(CC_REVISIONS).updateOne(
      { classId: cls._id, kind: "schedule" },
      {
        $set: { userId: getUserId(req), classId: cls._id, kind: "schedule", revision, data: schedule, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true },
    );
    log(`[cw2] 班级 ${cls.name || idStr(cls._id)} 发布 CW2 课表 v${revision}`, "info", "auth");
    ok(res, { revision, warnings });
  } catch (e) {
    log(`[cw2/publish/schedule] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/**
 * POST /publish/policy
 * body: { classId, policy: { overrides, locked_keys, schedule_readonly } }
 * CW2 的策略键和 ClassIsland 的策略不是一套语义，所以这里不做自动转换，直接收 CW2 形态。
 */
router.post("/v1/console/ci/central/publish/policy", async (req, res) => {
  try {
    const cls = await ownedClass(req, res, req.body?.classId);
    if (!cls) return;

    const policy = req.body?.policy;
    const errors = validateCw2Policy(policy);
    if (errors.length) return fail(res, 400, `策略未通过校验：${errors.slice(0, 5).join("；")}`);

    const current = await req.db.collection(CC_REVISIONS).findOne({ classId: cls._id, kind: "policy" });
    const revision = (Number(current?.revision) || 0) + 1;
    const now = new Date();
    await req.db.collection(CC_REVISIONS).updateOne(
      { classId: cls._id, kind: "policy" },
      {
        $set: {
          userId: getUserId(req),
          classId: cls._id,
          kind: "policy",
          revision,
          data: {
            overrides: policy.overrides ?? {},
            locked_keys: policy.locked_keys ?? [],
            schedule_readonly: policy.schedule_readonly ?? true,
          },
          updatedAt: now,
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true },
    );
    ok(res, { revision });
  } catch (e) {
    log(`[cw2/publish/policy] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** POST /commands — 下发命令（班级级或设备级，二选一） */
router.post("/v1/console/ci/central/commands", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "请先登录");

    const body = req.body || {};
    const type = String(body.type || "");
    if (!COMMAND_TYPES.has(type)) return fail(res, 400, `不支持的命令类型：${type || "空"}`);

    const hasClass = !!body.classId;
    const hasDevice = !!body.deviceId;
    if (hasClass === hasDevice) return fail(res, 400, "classId 与 deviceId 必须且只能给一个");

    const payload = { ...(body.payload || {}) };
    if (type === "trigger_action") {
      const actionId = String(payload.action_id || "").trim();
      if (!actionId || actionId.length > 240) return fail(res, 400, "trigger_action 需要非空 action_id（≤240 字符）");
      payload.action_id = actionId;
    }
    if (type === "switch_schedule") {
      const name = String(payload.name || "").trim();
      if (!name) return fail(res, 400, "switch_schedule 需要 name");
      payload.name = name;
    }
    if (type === "apply_config") {
      const overrides = payload.overrides;
      if (!overrides || typeof overrides !== "object" || !Object.keys(overrides).length) {
        return fail(res, 400, "apply_config 需要非空的 overrides");
      }
    }

    let classId: ObjectId | null = null;
    let deviceId: ObjectId | null = null;
    if (hasClass) {
      const cls = await ownedClass(req, res, body.classId);
      if (!cls) return;
      classId = cls._id;
    } else {
      deviceId = toObjectId(body.deviceId);
      if (!deviceId) return fail(res, 400, "deviceId 非法");
      const device = await req.db.collection(CC_DEVICES).findOne({ _id: deviceId, userId });
      if (!device) return fail(res, 404, "设备不存在");
    }

    const expiresInSeconds = Math.min(Math.max(Number(body.expiresInSeconds) || 300, 10), 86400);
    const rolloutPercentage = Math.min(Math.max(Number(body.rolloutPercentage) || 100, 1), 100);
    const now = new Date();
    const cursor = await nextCommandCursor(req.db);
    const doc = {
      _id: new ObjectId(),
      cursor,
      userId,
      classId,
      deviceId,
      type,
      payload,
      createdAt: now,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      rolloutPercentage,
    };
    await req.db.collection(CC_COMMANDS).insertOne(doc);
    log(`[cw2] 下发命令 ${type}（cursor=${cursor}）`, "info", "auth");
    ok(res, { commandId: idStr(doc._id), cursor, expiresAt: doc.expiresAt.toISOString() });
  } catch (e) {
    log(`[cw2/commands] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

/** GET /commands?classId= — 最近命令及各设备回执汇总 */
router.get("/v1/console/ci/central/commands", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "请先登录");

    const query: any = { userId };
    if (req.query.classId) {
      const oid = toObjectId(req.query.classId);
      if (!oid) return fail(res, 400, "classId 非法");
      query.classId = oid;
    }
    const commands = await req.db
      .collection(CC_COMMANDS)
      .find(query)
      .sort({ cursor: -1 })
      .limit(50)
      .toArray();

    const acks = await req.db
      .collection(CC_ACKS)
      .find({ commandId: { $in: commands.map((c: any) => c._id) } })
      .toArray();

    ok(
      res,
      commands.map((c: any) => {
        const own = acks.filter((a: any) => idStr(a.commandId) === idStr(c._id));
        const byStatus: Record<string, number> = {};
        for (const a of own) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
        return {
          commandId: idStr(c._id),
          cursor: Number(c.cursor) || 0,
          type: c.type,
          payload: c.payload || {},
          classId: idStr(c.classId),
          deviceId: idStr(c.deviceId),
          createdAt: new Date(c.createdAt).toISOString(),
          expiresAt: new Date(c.expiresAt).toISOString(),
          expired: new Date(c.expiresAt).getTime() < Date.now(),
          rolloutPercentage: Number(c.rolloutPercentage ?? 100),
          ackCount: own.length,
          ackByStatus: byStatus,
        };
      }),
    );
  } catch (e) {
    log(`[cw2/commands/list] ${e}`, "error");
    fail(res, 500, "内部服务器错误");
  }
});

export default router;
