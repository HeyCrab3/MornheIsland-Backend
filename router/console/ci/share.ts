/**
 * 资源学校级共享：把一份个人资源发布给学校，或收回成个人资源。
 *
 * 产品背景：学校层面统一分配时间表/课程表/设置/策略，各班只排课。
 * 所以「分享到学校」是升级后最常做的动作 —— 一个人配好，全校班级都能选。
 *
 * 权限：
 *   · 发布/收回只有资源归属人能做（别人不能把你东西挂到学校上去）；
 *   · 目标学校必须是我加入的学校；
 *   · 收回时如果学校里还有班级在用，拒绝 —— 否则那些班会突然失去资源。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { CI_SCHOOLS, getSchoolRole } from "../../../util/school";

const router = express.Router();

const TYPE_MAP: Record<string, { collection: string; label: string; refField: string }> = {
  classplan: { collection: "ci_classplans", label: "课表", refField: "classplanId" },
  timelayout: { collection: "ci_timelayouts", label: "时间表", refField: "timelayoutId" },
  subjects: { collection: "ci_subjects", label: "课程表", refField: "subjectsId" },
  settings: { collection: "ci_settings", label: "设置", refField: "settingsId" },
  policy: { collection: "ci_policies", label: "策略", refField: "policyId" },
};

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

function toOid(v: any): ObjectId | null {
  if (v instanceof ObjectId) return v;
  const s = String(v ?? "").trim();
  return s && ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/**
 * POST /v1/console/ci/:type/:id/share   body { schoolId: string | null }
 * 传 schoolId = 共享给该学校；传 null / 空 = 收回为个人资源。
 */
router.post("/v1/console/ci/:type/:id/share", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const t = TYPE_MAP[String(req.params.type ?? "")];
    if (!t) return res.status(400).json({ code: 400, msg: "资源类型非法" });

    const id = toOid(req.params.id);
    if (!id) return res.status(400).json({ code: 400, msg: "资源 id 非法" });

    const doc = await req.db.collection(t.collection).findOne({ _id: id });
    if (!doc) return res.status(404).json({ code: 404, msg: `${t.label}不存在` });

    // ⚠ 这里不能一刀切「只有归属人能操作」：
    // 收回共享的时候，学校管理员也要能处置**别人**共享进来的东西，
    // 否则一份成员共享的资源永远撤不掉（成员毕业/账号废了就成死锁）。
    // 所以权限按动作分别在下面各自判断。
    const isCreator = String(doc.userId) === String(userId);
    const rawSchoolId = req.body?.schoolId;

    // ── 收回 ──
    if (rawSchoolId === null || rawSchoolId === undefined || rawSchoolId === "") {
      if (!doc.schoolId) {
        return res.json({ code: 0, msg: "ok", data: { shared: false, changed: false } });
      }
      // 收回：创建者收回自己的；学校管理员收回任何人的
      if (!isCreator) {
        const role = await getSchoolRole(req.db, doc.schoolId, userId);
        if (!role || role === "member") {
          return res.status(403).json({
            code: 403,
            msg: `只能收回自己共享的${t.label}，或者由学校管理员处理`,
          });
        }
      }
      const inUse = await req.db
        .collection("ci_classes")
        .countDocuments({ [t.refField]: id, schoolId: doc.schoolId });
      if (inUse > 0) {
        return res.status(409).json({
          code: 409,
          msg: `学校里还有 ${inUse} 个班级在用这份${t.label}，不能收回。请先给它们换一份。`,
        });
      }
      await req.db.collection(t.collection).updateOne(
        { _id: id },
        { $unset: { schoolId: "" }, $set: { updatedAt: new Date() } },
      );
      log(`[ci/share] 用户 ${userId} 收回${t.label}「${doc.name}」为个人资源`, "info", "auth");
      return res.json({ code: 0, msg: "ok", data: { shared: false, changed: true } });
    }

    // ── 共享 ──
    // 共享是「把自己做的东西交给学校用」，所以必须是自己的资源；
    // 别人的东西不能由你替它公开。
    if (!isCreator) {
      return res.status(403).json({ code: 403, msg: `只能共享自己创建的${t.label}` });
    }

    const schoolId = toOid(rawSchoolId);
    if (!schoolId) return res.status(400).json({ code: 400, msg: "schoolId 非法" });

    const school = await req.db.collection(CI_SCHOOLS).findOne({ _id: schoolId });
    if (!school) return res.status(404).json({ code: 404, msg: "学校不存在" });

    // 共享是「把自己做的东西交给学校用」，任何校内成员都可以做；
    // 真正需要管理员的是「改别人的学校级资源」，那一条在 util/ci_resource 里卡。
    const role = await getSchoolRole(req.db, schoolId, userId);
    if (!role) return res.status(403).json({ code: 403, msg: "你不在这所学校里" });

    if (doc.schoolId && String(doc.schoolId) !== String(schoolId)) {
      return res.status(409).json({ code: 409, msg: "这份资源已经共享给另一所学校了，先收回再共享" });
    }
    if (doc.schoolId && String(doc.schoolId) === String(schoolId)) {
      return res.json({ code: 0, msg: "ok", data: { shared: true, changed: false } });
    }

    await req.db.collection(t.collection).updateOne(
      { _id: id },
      { $set: { schoolId, updatedAt: new Date() } },
    );
    log(`[ci/share] 用户 ${userId} 把${t.label}「${doc.name}」共享给学校「${school.name}」`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { shared: true, changed: true } });
  } catch (e) {
    log(`[ci/share] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
