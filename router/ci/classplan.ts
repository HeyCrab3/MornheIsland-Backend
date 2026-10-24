import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

/**
 * 课表源。
 *
 * ⚠ 必须**自包含**：ClassPlan 里的每个 TimeLayoutId 都指向时间表里的某个 key，
 * 如果这里只发 ClassPlans 而把 TimeLayouts 发成 {}，ClassIsland 载入这份档案时
 * 找不到被引用的时间表，就会报「您还未给课程表配置时间表」——
 * 而且时间表在档案里也变成没有名字的空条目。
 *
 * 所以这里连同被引用的 TimeLayouts 和 Subjects 一起下发。
 * （时间表/科目另有独立端点，重复下发没有副作用，ClassIsland 会按 id 合并。）
 */
router.get("/v1/ci/:classIdentity/classplan.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });
    if (!cls.classplanId) return res.status(404).json({ code: 404, msg: "未关联课表" });

    const cp = await db.collection("ci_classplans").findOne({ _id: new ObjectId(cls.classplanId) });
    if (!cp) return res.status(404).json({ code: 404, msg: "课表不存在" });

    // 时间表/科目优先取课表资源里记录的那份（CSES 导入时就是写在这里），再退回班级上的关联
    const tlId = cp.data?.timelayoutId || cls.timelayoutId;
    const subId = cp.data?.subjectsId || cls.subjectsId;

    const [tl, sub] = await Promise.all([
      tlId ? db.collection("ci_timelayouts").findOne({ _id: new ObjectId(tlId) }) : null,
      subId ? db.collection("ci_subjects").findOne({ _id: new ObjectId(subId) }) : null,
    ]);

    res.json({
      Name: cp.name || "",
      TimeLayouts: tl?.data || {},
      ClassPlans: cp.data.classPlans || cp.data,
      Subjects: sub?.data || {},
    });
  } catch (e) {
    log(`[ci/classplan] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
