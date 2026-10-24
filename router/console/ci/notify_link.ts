/**
 * 扫码发通知 —— 控制台侧（需 JWT）。
 *
 * 给班级生成一个二维码链接，老师扫码就能给这个班发通知，不用登录。
 * 这里只负责发码 / 换码 / 吊销，以及告诉前端「现在有几种在线设备」。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { ensureNotifyToken, rotateNotifyToken, revokeNotifyToken, resolveClassCuids } from "../../../util/notify_token";
import { isOnline } from "../../../grpc/clients";
import { siteBaseUrl } from "../../../util/site_url";

const router = express.Router();

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

function toOid(v: any): ObjectId | null {
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/**
 * 站点基地址。二维码里写的是**绝对地址**，写错就是一串死链接，
 * 统一走 util/site_url（配置项 → 环境变量 → 反代头 → 请求头）。
 */
function buildUrl(req: any, token: string): string {
  return `${siteBaseUrl(req)}/n/${token}`;
}

/** 校验班级归属 */
async function ownClass(req: any) {
  const userId = getUserId(req);
  if (!userId) return { error: { status: 401, body: { code: 401, msg: "请先登录" } } };

  const classId = toOid(req.params?.classId);
  if (!classId) return { error: { status: 400, body: { code: 400, msg: "classId 非法" } } };

  const cls = await req.db.collection("ci_classes").findOne({ _id: classId, userId });
  if (!cls) return { error: { status: 404, body: { code: 404, msg: "班级不存在" } } };
  return { cls, classId, userId };
}

/** GET /v1/console/ci/notify-link/:classId —— 取（或首次生成）二维码链接 */
router.get("/v1/console/ci/notify-link/:classId", async (req, res) => {
  try {
    const r: any = await ownClass(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const token = await ensureNotifyToken(req.db, r.classId);
    if (!token) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const cuids = await resolveClassCuids(req.db, r.cls);
    const online = cuids.filter((c) => isOnline(c)).length;

    res.json({
      code: 0,
      msg: "ok",
      data: {
        token,
        url: buildUrl(req, token),
        createdAt: r.cls.notifyTokenCreatedAt || null,
        deviceCount: cuids.length,
        online,
      },
    });
  } catch (e) {
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/notify-link/:classId/rotate —— 换新码，旧码立即失效 */
router.post("/v1/console/ci/notify-link/:classId/rotate", async (req, res) => {
  try {
    const r: any = await ownClass(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const token = await rotateNotifyToken(req.db, r.classId);
    if (!token) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const cuids = await resolveClassCuids(req.db, r.cls);
    res.json({
      code: 0,
      msg: "ok",
      data: {
        token,
        url: buildUrl(req, token),
        createdAt: new Date(),
        deviceCount: cuids.length,
        online: cuids.filter((c) => isOnline(c)).length,
      },
    });
  } catch (e) {
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** POST /v1/console/ci/notify-link/:classId/revoke —— 停用二维码 */
router.post("/v1/console/ci/notify-link/:classId/revoke", async (req, res) => {
  try {
    const r: any = await ownClass(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const ok = await revokeNotifyToken(req.db, r.classId);
    if (!ok) return res.status(404).json({ code: 404, msg: "班级不存在" });
    res.json({ code: 0, msg: "ok", data: { revoked: true } });
  } catch (e) {
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
