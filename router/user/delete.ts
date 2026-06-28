import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";

const router = express.Router();

router.delete("/v1/user/delete", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const uid = new ObjectId(userId);

    // 删除用户的所有 CI 数据
    const classes = await db.collection("ci_classes").find({ userId: uid }).toArray();
    const classIds = classes.map((c: any) => c._id);

    await Promise.all([
      db.collection("user").deleteOne({ _id: uid }),
      db.collection("ci_classes").deleteMany({ userId: uid }),
      db.collection("ci_classplans").deleteMany({ userId: uid }),
      db.collection("ci_timelayouts").deleteMany({ userId: uid }),
      db.collection("ci_subjects").deleteMany({ userId: uid }),
      db.collection("ci_settings").deleteMany({ userId: uid }),
      db.collection("ci_policies").deleteMany({ userId: uid }),
      db.collection("ci_history").deleteMany({ userId: uid }),
      ...(classIds.length > 0 ? [
        db.collection("ci_classplans").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_timelayouts").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_subjects").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_settings").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_policies").deleteMany({ classId: { $in: classIds } }),
      ] : []),
    ]);

    log(`[user] 用户 ${userId} 已注销，所有数据已清除`, "info", "auth");
    res.json({ code: 0, msg: "账户已注销" });
  } catch (e) {
    log(`[user/delete] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "注销失败" });
  }
});

export default router;
