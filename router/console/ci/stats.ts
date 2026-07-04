import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

/**
 * GET /v1/console/ci/has-devices
 * 查询当前用户是否有 ClassIsland 设备接入过。
 * 在 request_log 中查找任一 CI 端点被访问过的记录。
 */
router.get("/v1/console/ci/has-devices", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const uid = new ObjectId(userId);

    // 查用户的所有班级
    const classes = await db.collection("ci_classes")
      .find({ userId: uid })
      .project({ _id: 1 })
      .toArray();

    if (classes.length === 0) {
      return res.json({ code: 0, data: { hasDevices: false } });
    }

    const ids = classes.map((c: any) => String(c._id));

    // 查 request_log 中是否有匹配这些班级的 CI 路径
    const count = await db.collection("request_log").countDocuments({
      path: { $regex: `^/v1/ci/(${ids.join("|")})/` },
    });

    res.json({ code: 0, data: { hasDevices: count > 0, count } });
  } catch (e) {
    log(`[ci/stats] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
