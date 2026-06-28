import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

router.get("/v1/ci/:classIdentity/classplan.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });
    if (!cls.classplanId) return res.status(404).json({ code: 404, msg: "未关联课表" });

    const cp = await db.collection("ci_classplans").findOne({ _id: new ObjectId(cls.classplanId) });
    if (!cp) return res.status(404).json({ code: 404, msg: "课表不存在" });
    res.json(cp.data.classPlans || cp.data);
  } catch (e) {
    log(`[ci/classplan] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
