/**
 * 班级标识冲突诊断（控制台）。
 *
 * 背景：班级标识（identity）是用户自填的、全库不唯一。历史上服务端用它解析
 * 客户端归属，命中多个时会返回任意一个，导致跨校串数据。
 * 现在解析已改为「ObjectId 优先 + identity 必须唯一」，但**已经在跑的设备**
 * 如果其标识有歧义，会被拒绝下发配置（失败关闭）。
 *
 * 这个接口用来找出：当前账号下哪些班级标识有歧义、以及有哪几台设备正卡在上面，
 * 方便按班重新生成 preset 并重新导入。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

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

router.get("/v1/console/ci/identity-conflicts", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const db = req.db;

    const myClasses = await db
      .collection("ci_classes")
      .find({ userId })
      .project({ identity: 1, name: 1 })
      .toArray();

    const identities = [
      ...new Set(myClasses.map((c: any) => String(c.identity ?? "").trim()).filter(Boolean)),
    ];
    if (!identities.length) {
      return res.json({ code: 0, msg: "ok", data: { conflicts: [], affectedClients: [] } });
    }

    const grouped = await db
      .collection("ci_classes")
      .aggregate([
        { $match: { identity: { $in: identities } } },
        {
          $group: {
            _id: "$identity",
            ownerCount: { $addToSet: "$userId" },
            classCount: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const conflicts = grouped
      .filter((g: any) => (g.ownerCount?.length || 0) > 1)
      .map((g: any) => ({
        identity: String(g._id ?? ""),
        // 我的哪些班用了这个标识
        myClasses: myClasses
          .filter((c: any) => String(c.identity ?? "").trim() === String(g._id ?? ""))
          .map((c: any) => ({ id: String(c._id), name: c.name || "" })),
        otherAccountCount: (g.ownerCount?.length || 0) - 1,
        totalClassCount: g.classCount,
      }));

    // 卡在歧义标识上的设备：它们会被拒绝下发配置
    const conflictIdentities = conflicts.map((c: any) => c.identity);
    const affectedClients = conflictIdentities.length
      ? await db
          .collection("ci_clients")
          .find({ identity: { $in: conflictIdentities } })
          .project({ cuid: 1, identity: 1, online: 1, lastSeen: 1 })
          .toArray()
      : [];

    res.json({
      code: 0,
      msg: "ok",
      data: {
        conflicts,
        affectedClients: affectedClients.map((c: any) => ({
          cuid: String(c.cuid ?? ""),
          identity: String(c.identity ?? ""),
          online: !!c.online,
          lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null,
        })),
      },
    });
  } catch (e) {
    log(`[ci/identity-conflicts] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
