/**
 * 考试安排（公开只读，给看板用）。
 *
 * 看板是壁纸页，没有登录态，所以这里按**班级标识/ID**取：
 * 先找到班级，再取该班级所属账号的考试安排。
 * 因为考试安排是按账号存的，同一账号下所有班级天然共享一份，
 * 不需要每个班重复录入。
 *
 * 暴露面与 /v1/ci/:identity/manifest.json 一致——都是该班本来就公开的课表数据。
 */

import express from "express";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

router.get("/v1/ci/:classIdentity/exams.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const doc = await db.collection("ci_exams").findOne({ userId: cls.userId });
    res.json({
      identity: cls.identity || "",
      className: cls.name || "",
      entries: doc?.entries || [],
      updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    });
  } catch (e) {
    log(`[ci/exams] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
