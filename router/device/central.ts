/**
 * Class Widgets 2 集控 —— 设备侧协议。
 *
 * 路径与参考实现（Class-Widgets-2-Central-Control）完全一致：
 *   POST /api/v1/device/pair         一次性配对码换 device_token
 *   POST /api/v1/device/sync         每 poll_interval 秒一次，上行状态 + 下行课表/策略/命令
 *   POST /api/v1/device/unpair       撤销设备
 *   POST /api/v1/device/diagnostics  上报日志
 *
 * 同时挂一份 /v1/device/* 别名：控制台的 Nuxt 代理会把 /api 前缀 rewrite 掉，
 * 万一用户把设备指到了那种写法也能连上。
 *
 * 注意：这里的响应是**裸 JSON**，不能套本项目控制台的 {code,msg,data} 外壳，
 * 否则设备的 pydantic 模型对不上。
 */

import express from "express";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import {
  CC_ACKS,
  CC_COMMANDS,
  CC_DEVICES,
  CC_DIAGNOSTICS,
  CC_PAIRING_CODES,
  CC_REVISIONS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEVICE_ONLINE_TIMEOUT_SECONDS,
  generateDeviceToken,
  idStr,
  newId,
  sha256Hex,
} from "../../util/cw2_central";
import { validateCw2Schedule } from "../../util/cw2_schedule";

const router = express.Router();

const PROTOCOL_VERSION = 1;
const MAX_COMMANDS_PER_SYNC = 100;
const MAX_SNAPSHOT_BYTES = 2_000_000;

/** 设备鉴权：Authorization: Bearer <device_token>，服务端只存 sha256 */
async function requireDevice(req: any, res: any): Promise<any | null> {
  const header = String(req.headers?.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ detail: "device token required" });
    return null;
  }
  const token = header.slice(7).trim();
  const device = await req.db.collection(CC_DEVICES).findOne({ tokenHash: sha256Hex(token) });
  if (!device || device.revoked) {
    res.status(401).json({ detail: "invalid device token" });
    return null;
  }
  return device;
}

function badRequest(res: any, detail: string) {
  return res.status(400).json({ detail });
}

/** POST /pair */
async function pair(req: any, res: any) {
  try {
    const db = req.db;
    const body = req.body || {};
    if (Number(body.protocol_version ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
      return badRequest(res, "unsupported protocol_version");
    }

    const code = String(body.pairing_code || "").trim();
    const installationId = String(body.installation_id || "").trim();
    const deviceName = String(body.device_name || "").trim();
    if (code.length < 6 || code.length > 64) return badRequest(res, "invalid pairing code");
    if (installationId.length < 8 || installationId.length > 120) return badRequest(res, "invalid installation_id");
    if (!deviceName || deviceName.length > 120) return badRequest(res, "invalid device_name");

    const now = new Date();
    const pairingCode = await db.collection(CC_PAIRING_CODES).findOne({ codeHash: sha256Hex(code) });
    if (!pairingCode || pairingCode.consumedAt || pairingCode.expiresAt <= now) {
      return badRequest(res, "invalid pairing code");
    }

    const existing = await db.collection(CC_DEVICES).findOne({ installationId });
    if (existing && !existing.revoked) {
      return res.status(409).json({ detail: "installation already paired" });
    }

    const cls = await db.collection("ci_classes").findOne({ _id: pairingCode.classId });
    if (!cls) return res.status(404).json({ detail: "group not found" });

    // 先原子消费配对码，避免同一码并发换出多个 token
    const consumed = await db.collection(CC_PAIRING_CODES).updateOne(
      { _id: pairingCode._id, consumedAt: null },
      { $set: { consumedAt: now } },
    );
    if (consumed.modifiedCount !== 1) return badRequest(res, "invalid pairing code");

    const token = generateDeviceToken();
    const tokenHash = sha256Hex(token);
    const common = {
      userId: pairingCode.userId,
      classId: pairingCode.classId,
      installationId,
      name: deviceName,
      tokenHash,
      revoked: false,
      appVersion: String(body.app_version || ""),
      pluginVersion: String(body.plugin_version || ""),
      platform: String(body.platform || ""),
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
      lastSeen: now,
      scheduleRevision: 0,
      policyRevision: 0,
      runtimeStatus: "",
      runtimeTitle: "",
      lastError: "",
      onlineSessionId: newId(),
      updatedAt: now,
    };

    let deviceId: string;
    if (existing) {
      deviceId = idStr(existing._id);
      await db.collection(CC_DEVICES).updateOne(
        { _id: existing._id },
        { $set: { ...common, lastCursor: 0 } },
      );
    } else {
      const doc = { _id: new ObjectId(), lastCursor: 0, createdAt: now, ...common };
      await db.collection(CC_DEVICES).insertOne(doc);
      deviceId = idStr(doc._id);
    }

    log(`[cw2] 设备 ${deviceName}(${installationId}) 配对到班级 ${cls.name || idStr(cls._id)}`, "info", "auth");
    res.json({
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
      device_token: token,
      organization_name: cls.orgName || cls.name || "",
      group_name: cls.name || "",
      poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
    });
  } catch (e) {
    log(`[cw2/device/pair] ${e}`, "error");
    res.status(500).json({ detail: "internal error" });
  }
}

/** POST /sync */
async function sync(req: any, res: any) {
  try {
    const db = req.db;
    const device = await requireDevice(req, res);
    if (!device) return;

    const body = req.body || {};
    if (Number(body.protocol_version ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
      return badRequest(res, "unsupported protocol_version");
    }

    const now = new Date();
    const runtime = body.runtime || {};
    const incomingCursor = Math.max(Number(body.cursor) || 0, 0);
    const incomingScheduleRevision = Math.max(Number(body.schedule_revision) || 0, 0);
    const incomingPolicyRevision = Math.max(Number(body.policy_revision) || 0, 0);

    const lastSeen = device.lastSeen ? new Date(device.lastSeen) : null;
    const wentOffline =
      !lastSeen || (now.getTime() - lastSeen.getTime()) / 1000 > DEVICE_ONLINE_TIMEOUT_SECONDS;

    const deviceSet: any = {
      appVersion: String(body.app_version || ""),
      pluginVersion: String(body.plugin_version || ""),
      platform: String(body.platform || ""),
      runtimeStatus: String(runtime.status || ""),
      runtimeTitle: String(runtime.title || ""),
      scheduleRevision: incomingScheduleRevision,
      policyRevision: incomingPolicyRevision,
      lastError: String(body.last_error || "").slice(0, 1000),
      lastCursor: Math.max(Number(device.lastCursor) || 0, incomingCursor),
      lastSeen: now,
      updatedAt: now,
    };
    if (wentOffline) deviceSet.onlineSessionId = newId();

    // ── 客户端上传的课表快照（服务端主动 request_schedule_snapshot 后才收） ──
    if (body.schedule_snapshot) {
      const snapshot = body.schedule_snapshot;
      const requestCommand = await db
        .collection(CC_COMMANDS)
        .findOne(
          { deviceId: device._id, type: "request_schedule_snapshot" },
          { sort: { cursor: -1 } },
        );
      if (requestCommand && requestCommand.payload?.request_id === snapshot.request_id) {
        const errs = validateCw2Schedule(snapshot.schedule);
        if (!errs.length) {
          // 与参考实现一致：算 hash 时剔除本地换课产生的 overrides
          const cleaned = {
            ...snapshot.schedule,
            overrides: (snapshot.schedule.overrides || []).filter(
              (o: any) => !String(o?.id || "").startsWith("swap_cc_"),
            ),
          };
          const encoded = JSON.stringify(cleaned);
          if (Buffer.byteLength(encoded, "utf8") <= MAX_SNAPSHOT_BYTES) {
            const stable = createHash("sha256").update(encoded, "utf8").digest("hex");
            await db.collection(CC_REVISIONS).updateOne(
              { deviceId: device._id, kind: "schedule_snapshot" },
              {
                $set: {
                  deviceId: device._id,
                  classId: device.classId,
                  kind: "schedule_snapshot",
                  requestId: snapshot.request_id,
                  data: snapshot.schedule,
                  hash: stable,
                  updatedAt: now,
                },
                $setOnInsert: { _id: new ObjectId(), createdAt: now },
              },
              { upsert: true },
            );
          }
        }
      }
    }

    // ── 命令回执 ──
    const acks: any[] = Array.isArray(body.acknowledgements) ? body.acknowledgements.slice(0, 100) : [];
    for (const ack of acks) {
      const commandId = String(ack?.command_id || "");
      if (!ObjectId.isValid(commandId)) continue;
      const command = await db.collection(CC_COMMANDS).findOne({ _id: new ObjectId(commandId) });
      if (!command) continue;
      const sameDevice = idStr(command.deviceId) === idStr(device._id);
      const sameClass = command.classId && idStr(command.classId) === idStr(device.classId);
      if (!sameDevice && !sameClass) continue;

      await db.collection(CC_ACKS).updateOne(
        { commandId: command._id, deviceId: device._id },
        {
          $set: {
            status: ["accepted", "running", "succeeded", "failed"].includes(ack?.status)
              ? ack.status
              : "accepted",
            errorCode: String(ack?.error_code || ""),
            message: String(ack?.message || "").slice(0, 500),
            updatedAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), commandId: command._id, deviceId: device._id, createdAt: now },
        },
        { upsert: true },
      );
    }

    await db.collection(CC_DEVICES).updateOne({ _id: device._id }, { $set: deviceSet });

    // ── 待下发的课表 / 策略（只有版本比设备新才给） ──
    const revisions = await db
      .collection(CC_REVISIONS)
      .find({ classId: device.classId, kind: { $in: ["schedule", "policy"] } })
      .toArray();
    const scheduleRev = revisions.find((r: any) => r.kind === "schedule");
    const policyRev = revisions.find((r: any) => r.kind === "policy");

    const scheduleOut =
      scheduleRev && Number(scheduleRev.revision) > incomingScheduleRevision
        ? { revision: Number(scheduleRev.revision), data: scheduleRev.data }
        : null;
    const policyOut =
      policyRev && Number(policyRev.revision) > incomingPolicyRevision
        ? { revision: Number(policyRev.revision), data: policyRev.data }
        : null;

    // ── 命令增量 ──
    const candidates = await db
      .collection(CC_COMMANDS)
      .find({
        cursor: { $gt: incomingCursor },
        expiresAt: { $gt: now },
        $or: [{ deviceId: device._id }, { classId: device.classId }],
      })
      .sort({ cursor: 1 })
      .limit(MAX_COMMANDS_PER_SYNC)
      .toArray();

    const commands = candidates.filter((command: any) => {
      const pct = Number(command.rolloutPercentage ?? 100);
      if (pct >= 100) return true;
      const bucket = parseInt(
        createHash("sha256").update(`${idStr(command._id)}:${idStr(device._id)}`).digest("hex").slice(0, 8),
        16,
      );
      return bucket % 100 < pct;
    });

    // 参考实现是把 cursor 推到**候选命令**的最大值（含被灰度筛掉的），这里保持一致，
    // 否则同一批命令会在每次 sync 里反复重放。
    const responseCursor = Math.max(
      incomingCursor,
      ...candidates.map((c: any) => Number(c.cursor) || 0),
    );
    await db.collection(CC_DEVICES).updateOne(
      { _id: device._id },
      { $set: { lastCursor: Math.max(Number(deviceSet.lastCursor) || 0, responseCursor) } },
    );

    const cls = await db.collection("ci_classes").findOne({ _id: device.classId });

    res.json({
      protocol_version: PROTOCOL_VERSION,
      server_time: now.toISOString(),
      poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
      cursor: responseCursor,
      organization_name: cls?.orgName || cls?.name || "",
      group_name: cls?.name || "",
      schedule: scheduleOut,
      policy: policyOut,
      commands: commands.map((command: any) => ({
        command_id: idStr(command._id),
        cursor: Number(command.cursor) || 0,
        type: command.type,
        payload: command.payload || {},
        issued_at: new Date(command.createdAt).toISOString(),
        expires_at: new Date(command.expiresAt).toISOString(),
      })),
    });
  } catch (e) {
    log(`[cw2/device/sync] ${e}`, "error");
    res.status(500).json({ detail: "internal error" });
  }
}

/** POST /unpair */
async function unpair(req: any, res: any) {
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    await req.db.collection(CC_DEVICES).updateOne(
      { _id: device._id },
      { $set: { revoked: true, tokenHash: sha256Hex(generateDeviceToken()), updatedAt: new Date() } },
    );
    log(`[cw2] 设备 ${device.name || idStr(device._id)} 已解除配对`, "info", "auth");
    res.status(204).end();
  } catch (e) {
    log(`[cw2/device/unpair] ${e}`, "error");
    res.status(500).json({ detail: "internal error" });
  }
}

/** POST /diagnostics */
async function diagnostics(req: any, res: any) {
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    const body = req.body || {};
    const doc = {
      _id: new ObjectId(),
      deviceId: device._id,
      classId: device.classId,
      userId: device.userId,
      appVersion: String(body.app_version || "").slice(0, 40),
      pluginVersion: String(body.plugin_version || "").slice(0, 40),
      lastError: String(body.last_error || "").slice(0, 1000),
      logs: Array.isArray(body.logs) ? body.logs.slice(0, 200) : [],
      createdAt: new Date(),
    };
    await req.db.collection(CC_DIAGNOSTICS).insertOne(doc);
    res.status(201).json({ id: idStr(doc._id) });
  } catch (e) {
    log(`[cw2/device/diagnostics] ${e}`, "error");
    res.status(500).json({ detail: "internal error" });
  }
}

// 规范路径 + 一份别名（控制台代理会吃掉 /api 前缀）
for (const base of ["/api/v1/device", "/v1/device"]) {
  router.post(`${base}/pair`, pair);
  router.post(`${base}/sync`, sync);
  router.post(`${base}/unpair`, unpair);
  router.post(`${base}/diagnostics`, diagnostics);
}

export default router;
