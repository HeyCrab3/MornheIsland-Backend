import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

router.get("/v1/ci/:classIdentity/subjects.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    if (cls.classplanId) {
      const cp = await db.collection("ci_classplans").findOne({ _id: new ObjectId(cls.classplanId) });
      if (cp?.data?.subjectsId) {
        const sub = await db.collection("ci_subjects").findOne({ _id: new ObjectId(cp.data.subjectsId) });
        if (sub) return res.json(sub.data);
      }
    }
    if (cls.subjectsId) {
      const doc = await db.collection("ci_subjects").findOne({ _id: new ObjectId(cls.subjectsId) });
      if (doc) return res.json(doc.data);
    }
    res.status(404).json({ code: 404, msg: "未配置科目" });
  } catch (e) {
    log(`[ci/subjects] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
