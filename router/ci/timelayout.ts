import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

/**
 * 时间表源。
 *
 * ⚠ 必须优先用**课表资源自己记录的 timelayoutId**：ClassPlans 里的 TimeLayoutId
 * 指向的就是那一份。如果这里只按班级字段 `cls.timelayoutId` 取，
 * 用户换了关联之后两者会分叉，ClassIsland 仍然找不到被引用的时间表。
 */
router.get("/v1/ci/:classIdentity/timelayout.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    let tlId = cls.timelayoutId;
    if (cls.classplanId) {
      const cp = await db.collection("ci_classplans").findOne({ _id: new ObjectId(cls.classplanId) });
      if (cp?.data?.timelayoutId) tlId = cp.data.timelayoutId;
    }
    if (!tlId) return res.status(404).json({ code: 404, msg: "未关联时间表" });

    const doc = await db.collection("ci_timelayouts").findOne({ _id: new ObjectId(tlId) });
    if (!doc) return res.status(404).json({ code: 404, msg: "时间表不存在" });

    // data 应该是 { uuid: { Name, Layouts } }；空壳会导致 CI 里时间表没有名字，先记一笔
    const keys = Object.keys(doc.data || {});
    const first: any = keys.length ? (doc.data as any)[keys[0]] : null;
    if (!keys.length || !first?.Layouts?.length) {
      log(`[ci/timelayout] 时间表 ${String(doc._id)}（${doc.name || "未命名"}）没有有效 Layouts，下发后 CI 会显示为空白时间表`, "warn", "routes");
    }

    res.json({ Name: doc.name || "", TimeLayouts: doc.data, ClassPlans: {}, Subjects: {} });
  } catch (e) {
    log(`[ci/timelayout] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
