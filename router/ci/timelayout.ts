import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

router.get("/v1/ci/:classIdentity/timelayout.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });
    if (!cls.timelayoutId) return res.status(404).json({ code: 404, msg: "未关联时间表" });

    const doc = await db.collection("ci_timelayouts").findOne({ _id: new ObjectId(cls.timelayoutId) });
    if (!doc) return res.status(404).json({ code: 404, msg: "时间表不存在" });
    res.json(doc.data);
  } catch (e) {
    log(`[ci/timelayout] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
