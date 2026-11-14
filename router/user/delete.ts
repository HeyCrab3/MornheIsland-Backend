import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { authLog } from "../../util/auth_log.ts";
import { checkReauth, rejectReauth } from "../../util/reauth.ts";

const router = express.Router();

/**
 * 注销账号需要**二次验证**：
 *  1. 必须是一次**新鲜登录**签发的 token（10 分钟内），或 5 分钟内刚通过二步验证复核；
 *  2. 还必须把账号名原样输一遍，避免误点。
 *
 * 我们只有 SSO 登录、本地没有密码可校验，所以「再验证一遍账号」的现实做法
 * 就是强制重新走一次登录（拿新 token）或输一次动态码，再加一道输入框确认。
 */

router.delete("/v1/user/delete", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const uid = new ObjectId(userId);

    // 代登录的影子账号不是一个真账号，注销它没有意义（也防止误操作删掉委托里的身份）
    if (req.auth?.delegate === true) {
      return res.status(403).json({
        code: 403,
        msg: "这是委托代登录身份，没有可注销的账号。请让委托人撤销委托，或直接退出登录。",
      });
    }

    // 子账户是主账号创建的从属身份，没有「自杀」权限：
    //  自己删自己会留下一条没有成员的内部委托，而主账号那边还以为子账户还在，
    //  且删除后名单里也不会再出现它（无痕消失）。只允许主账号在「组织 → 子账户」里删。
    if (req.auth?.subAccount === true) {
      return res.status(403).json({
        code: 403,
        msg: "这是子账户，不能自己注销。请让主账号在「组织 → 子账户」里删除它。",
      });
    }

    // ── 1. 再验证 ──
    const reauth = checkReauth(req);
    if (!reauth.ok) {
      return rejectReauth(res, "注销需要重新验证账户：请重新登录，或先完成一次二步验证");
    }

    const user = await db.collection("user").findOne({ _id: uid });
    if (!user) return res.status(404).json({ code: 404, msg: "账户不存在" });

    // 兜底：令牌里没带 subAccount 声明、但库里是子账户（例如旧令牌）也要拦
    if (user.isSubAccount === true) {
      return res.status(403).json({
        code: 403,
        msg: "这是子账户，不能自己注销。请让主账号在「组织 → 子账户」里删除它。",
      });
    }

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

    // 审计留痕：注销是不可撤销操作，必须能回答「谁、什么时候、用什么方式验明身份」
    await authLog(
      db,
      {
        userId,
        userName: user.userName,
        event: "sensitive",
        success: true,
        detail: `注销账号（再验证方式：${reauth.via === "mfa" ? "二步验证" : "重新登录"}，班级 ${classIds.length} 个）`,
      },
      req,
    );

    log(`[user] 用户 ${userId}（${user.userName}）已通过二次验证并注销，所有数据已清除`, "info", "auth");
    res.json({ code: 0, msg: "账户已注销" });
  } catch (e) {
    log(`[user/delete] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "注销失败" });
  }
});

export default router;
