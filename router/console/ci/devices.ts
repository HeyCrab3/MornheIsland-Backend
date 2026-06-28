import express from "express";
import { log } from "../../../util/log";

const router = express.Router();

/**
 * GET /v1/console/ci/devices
 * 返回当前用户所有班级对应的设备连接记录。
 */
router.get("/v1/console/ci/devices", async (req, res) => {
  try {
    const db = req.db;
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    // 查出当前用户的所有班级 identity，用于匹配请求路径
    const classes = await db.collection("ci_classes")
      .find({ userId: userId })
      .project({ identity: 1 })
      .toArray();
    const identities = classes.map((c: any) => c.identity);

    if (identities.length === 0) {
      return res.json({ code: 0, msg: "ok", data: [] });
    }

    // 从请求日志中找出访问过这些班级 CI 端点的设备
    const devices = await db.collection("request_log").aggregate([
      {
        $match: {
          path: {
            $in: identities.flatMap((id: string) => [
              `/v1/ci/${id}/manifest.json`,
              `/v1/ci/${id}/classplan.json`,
              `/v1/ci/${id}/timelayout.json`,
              `/v1/ci/${id}/subjects.json`,
              `/v1/ci/${id}/settings.json`,
              `/v1/ci/${id}/policy.json`,
            ]),
          },
        },
      },
      { $sort: { ts: -1 } },
      {
        $group: {
          _id: "$ip",
          lastSeen: { $first: "$ts" },
          lastPath: { $first: "$path" },
          requestCount: { $sum: 1 },
        },
      },
      { $sort: { lastSeen: -1 } },
    ]).toArray();

    res.json({ code: 0, msg: "ok", data: devices });
  } catch (e) {
    log(`[ci/console/devices] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
