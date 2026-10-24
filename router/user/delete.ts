import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";

const router = express.Router();

/**
 * 注销账号需要**二次验证**：
 *  1. 必须是一次**新鲜登录**签发的 token（默认 10 分钟内），旧 token 一律拒绝；
 *  2. 还必须把账号名原样输一遍，避免误点。
 *
 * 我们只有 SSO 登录、本地没有密码可校验，所以「再验证一遍账号」的现实做法
 * 就是强制重新走一次登录（拿新 token），再加一道输入框确认。
 */
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

router.delete("/v1/user/delete", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const uid = new ObjectId(userId);

    // ── 1. 新鲜度校验 ──
    const iat = Number(req.auth?.iat);
    if (!Number.isFinite(iat) || Date.now() - iat * 1000 > REAUTH_WINDOW_MS) {
      return res.status(403).json({
        code: 403,
        msg: "注销需要重新验证账户，请先重新登录后再试",
        needReauth: true,
      });
    }

    const user = await db.collection("user").findOne({ _id: uid });
    if (!user) return res.status(404).json({ code: 404, msg: "账户不存在" });

    // ── 2. 账号名二次确认 ──
    const confirm = String(req.body?.confirm ?? "").trim();
    if (!confirm) {
      return res.status(400).json({ code: 400, msg: "请把账号名原样输入一遍以确认注销" });
    }
    if (confirm !== String(user.userName ?? "")) {
      return res.status(400).json({ code: 400, msg: "账号名不匹配，已取消注销" });
    }

    // 删除用户的所有 CI 数据
    const classes = await db.collection("ci_classes").find({ userId: uid }).toArray();
    const classIds = classes.map((c: any) => c._id);

    // 学校级共享资源**不能跟着账号删**：同校其他班还在用，
    // 删了等于注销一个账号把全校的课表/时间表拆掉。这类资源留下来归学校。
    const personalOnly = { userId: uid, schoolId: { $exists: false } };

    await Promise.all([
      db.collection("user").deleteOne({ _id: uid }),
      db.collection("ci_classes").deleteMany({ userId: uid }),
      db.collection("ci_classplans").deleteMany(personalOnly),
      db.collection("ci_timelayouts").deleteMany(personalOnly),
      db.collection("ci_subjects").deleteMany(personalOnly),
      db.collection("ci_settings").deleteMany(personalOnly),
      db.collection("ci_policies").deleteMany(personalOnly),
      db.collection("ci_history").deleteMany({ userId: uid }),
      // 考试安排 / CW2 集控数据（按账号存的，必须一起清）
      db.collection("ci_exams").deleteMany({ userId: uid }),
      db.collection("cc_pairing_codes").deleteMany({ userId: uid }),
      db.collection("cc_devices").deleteMany({ userId: uid }),
      db.collection("cc_revisions").deleteMany({ userId: uid }),
      db.collection("cc_commands").deleteMany({ userId: uid }),
      db.collection("cc_diagnostics").deleteMany({ userId: uid }),
      // 学校成员关系一并退出（学校实体本身保留，里面还有其他人的班级）
      db.collection("ci_school_members").deleteMany({ userId: uid }),
      ...(classIds.length > 0 ? [
        db.collection("ci_classplans").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_timelayouts").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_subjects").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_settings").deleteMany({ classId: { $in: classIds } }),
        db.collection("ci_policies").deleteMany({ classId: { $in: classIds } }),
      ] : []),
    ]);

    log(`[user] 用户 ${userId}（${user.userName}）已通过二次验证并注销，所有数据已清除`, "info", "auth");
    res.json({ code: 0, msg: "账户已注销" });
  } catch (e) {
    log(`[user/delete] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "注销失败" });
  }
});

export default router;
