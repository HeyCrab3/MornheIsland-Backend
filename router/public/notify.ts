/**
 * 扫码发通知 —— 公开侧（无 JWT，凭令牌）。
 *
 * 安全模型说明（重要）：
 * 这是**故意**不鉴权的。使用者是学生电教委员，让他们每人注册账号不现实。
 * 令牌 = 凭证，所以：
 *  1. 令牌是 32 位 hex，不可枚举；
 *  2. GET 只返回班级名和在线设备数，绝不返回账号、学校、课表等任何信息；
 *  3. 有频率限制，防止有人拿一个码刷屏；
 *  4. 控制台可以随时重置 / 停用二维码。
 * 剩下的风险就是二维码被拍照外传 —— 这点在控制台和扫码页上都写明了。
 */

import express from "express";
import { findClassByToken, resolveClassCuids } from "../../util/notify_token";
import { sendNotification } from "../../grpc/server";
import { isOnline } from "../../grpc/clients";
import { log } from "../../util/log";

const router = express.Router();

const MAX_LEN = 200;
const MAX_DURATION = 120;
const MAX_REPEAT = 5;

/** 每令牌 60 秒内最多 3 条；每 IP 60 秒内最多 10 条 */
const TOKEN_WINDOW_MS = 60_000;
const TOKEN_LIMIT = 3;
const IP_LIMIT = 10;

const tokenHits = new Map<string, number[]>();
const ipHits = new Map<string, number[]>();

function hit(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < TOKEN_WINDOW_MS);
  if (arr.length >= limit) {
    map.set(key, arr);
    return false;
  }
  arr.push(now);
  map.set(key, arr);
  return true;
}

/** 定期清理，避免 Map 无限增长 */
setInterval(() => {
  const now = Date.now();
  for (const m of [tokenHits, ipHits]) {
    for (const [k, v] of m) {
      const kept = v.filter((t) => now - t < TOKEN_WINDOW_MS);
      if (kept.length) m.set(k, kept);
      else m.delete(k);
    }
  }
}, 5 * 60_000).unref?.();

function clientIp(req: any): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || String(req.socket?.remoteAddress ?? "unknown");
}

/** GET /v1/public/notify/:token —— 扫码页需要的极少量信息 */
router.get("/v1/public/notify/:token", async (req, res) => {
  try {
    const cls = await findClassByToken(req.db, req.params.token);
    if (!cls) return res.status(404).json({ code: 404, msg: "这个二维码已失效" });

    const cuids = await resolveClassCuids(req.db, cls);
    const online = cuids.filter((c) => isOnline(c)).length;

    res.json({
      code: 0,
      msg: "ok",
      data: {
        className: cls.name || "",
        online,
        deviceCount: cuids.length,
      },
    });
  } catch (e) {
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/public/notify/:token —— 下发通知 */
router.post("/v1/public/notify/:token", async (req, res) => {
  try {
    if (!hit(tokenHits, String(req.params.token), TOKEN_LIMIT)) {
      return res.status(429).json({ code: 429, msg: "发送太频繁了，等一分钟再试" });
    }
    if (!hit(ipHits, clientIp(req), IP_LIMIT)) {
      return res.status(429).json({ code: 429, msg: "发送太频繁了，等一分钟再试" });
    }

    const cls = await findClassByToken(req.db, req.params.token);
    if (!cls) return res.status(404).json({ code: 404, msg: "这个二维码已失效" });

    const body = req.body || {};
    const message = String(body.message ?? "").trim();
    if (!message) return res.status(400).json({ code: 400, msg: "请填写通知内容" });
    if (message.length > MAX_LEN) {
      return res.status(400).json({ code: 400, msg: `通知内容最多 ${MAX_LEN} 个字` });
    }

    const durationSeconds = Math.max(0, Math.min(MAX_DURATION, Number(body.durationSeconds) || 10));
    const repeatCounts = Math.max(1, Math.min(MAX_REPEAT, Number(body.repeatCounts) || 1));

    const notif = {
      MessageContent: message,
      MessageMask: String(body.mask ?? "").slice(0, MAX_LEN),
      IsEmergency: !!body.isEmergency,
      IsSpeechEnabled: !!body.isSpeechEnabled,
      IsSoundEnabled: body.isSoundEnabled === undefined ? true : !!body.isSoundEnabled,
      IsTopmost: !!body.isTopmost,
      DurationSeconds: durationSeconds,
      RepeatCounts: repeatCounts,
    };

    const cuids = await resolveClassCuids(req.db, cls);
    const onlineCuids = cuids.filter((c) => isOnline(c));

    if (!onlineCuids.length) {
      return res.status(409).json({
        code: 409,
        msg: cuids.length ? "这个班的设备当前不在线，通知发不出去" : "这个班还没有绑定设备",
      });
    }

    let sent = 0;
    for (const c of onlineCuids) {
      if (sendNotification(c, notif)) sent++;
    }

    log(
      `[notify] 扫码发通知：班级 ${cls.name || cls._id}，在线 ${onlineCuids.length} 台，成功 ${sent} 台` +
        `，紧急=${notif.IsEmergency ? "是" : "否"}，置顶=${notif.IsTopmost ? "是" : "否"}`,
      "info",
      "auth",
    );

    res.json({ code: 0, msg: "ok", data: { sent, total: onlineCuids.length } });
  } catch (e) {
    log(`[notify] 下发失败：${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
