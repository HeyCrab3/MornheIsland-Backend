/**
 * 设备接入探测（需 JWT）。
 *
 * GET /v1/console/ci/has-devices
 * 首页的「快速上手」引导要判断：这个账号的班级有没有 ClassIsland 设备接入过。
 * 做法是在 request_log 里找 `/v1/ci/<班级 id>/...` 这类客户端请求。
 *
 * 注意：这个文件原来只存在于线上服务器上，名字还叫 router/console/ci/stats.ts，
 * 仓库里没有 —— 从仓库干净部署会把这个接口丢掉，前端 QuickStartupGuide 就只剩
 * 报错。这里补进仓库，线上那份同名旧文件应当删除。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

router.get("/v1/console/ci/has-devices", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;

    // 查用户的所有班级
    const classes = await db
      .collection("ci_classes")
      .find({ userId: new ObjectId(String(userId)) })
      .project({ _id: 1 })
      .toArray();

    if (classes.length === 0) {
      return res.json({ code: 0, msg: "ok", data: { hasDevices: false, count: 0 } });
    }

    // 班级 _id 来自数据库，本身就是 24 位 hex，拼进正则没有注入风险
    const ids = classes.map((c: any) => String(c._id));
    const count = await db.collection("request_log").countDocuments({
      path: { $regex: `^/v1/ci/(${ids.join("|")})/` },
    });

    res.json({ code: 0, msg: "ok", data: { hasDevices: count > 0, count } });
  } catch (err: any) {
    log("[has-devices] " + (err?.message || err), "error", "default");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
