/**
 * 代登录 —— 没有账号的受托人凭「代登录码」进入。
 *
 * 安全模型：
 *  1. 码 8 位（31^8 ≈ 8.5e11），只存 sha256，库里没有明文；
 *  2. 进来的是**影子账号**（isDelegate），userId 独立，名字由他自己填 ——
 *     所以审计日志、页面水印、资源历史里写的都是「谁在操作」；
 *  3. 能力位、班级范围、有效期全部来自那条委托，撤销委托 = 立即踢下线；
 *  4. 消耗委托的可用名额，主账号能看见「谁、什么时候、用哪个名字进来的」；
 *  5. 影子账号不能发委托、不能接受其他委托、不能动账号本身（见 grants.ts / delete.ts 的拒绝逻辑）。
 */
import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { config } from "../../config";
import { log } from "../../util/log";
import { authLog } from "../../util/auth_log";
import {
  acceptGrant,
  findGrantByDelegateCode,
  grantUsable,
  normalizeDelegateCode,
  CAP_LABELS,
} from "../../util/ci_grant";

const router = express.Router();

const WINDOW_MS = 10 * 60_000;
const IP_LIMIT = 15;
const GRANT_LIMIT = 20;

const ipHits = new Map<string, number[]>();
const grantHits = new Map<string, number[]>();

function hit(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    map.set(key, arr);
    return false;
  }
  arr.push(now);
  map.set(key, arr);
  return true;
}

/** 名字只允许中英文、数字、空格与常见分隔符，去掉零宽字符 */
function cleanName(raw: any): string {
  const s = String(raw ?? "")
    .replace(/[\u200b-\u200f\u2028\u2029]/g, "")
    .replace(/[<>\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 20);
}

const delegateLoginRouter = router.post("/v1/public/delegate/login", async (req, res) => {
  try {
    const db = req.db;
    const code = normalizeDelegateCode(req.body?.code);
    const name = cleanName(req.body?.name);

    if (code.length !== 8) {
      return res.status(400).json({ code: 400, msg: "代登录码应为 8 位字母数字" });
    }
    if (name.length < 1) {
      return res.status(400).json({ code: 400, msg: "请填写你的名字（会显示在操作记录里）" });
    }

    const ip = String((req as any).ip || req.socket?.remoteAddress || "unknown");
    if (!hit(ipHits, ip, IP_LIMIT)) {
      return res.status(429).json({ code: 429, msg: "尝试太频繁，请稍后再试" });
    }

    const grant = await findGrantByDelegateCode(db, code);
    if (!grant) {
      await authLog(db, { event: "login_fail", success: false, userName: `代登录·${name}`, detail: "代登录码不存在" }, req);
      return res.status(404).json({ code: 404, msg: "代登录码不正确，或这条委托已被撤销" });
    }
    if (!hit(grantHits, String(grant._id), GRANT_LIMIT)) {
      return res.status(429).json({ code: 429, msg: "这条委托登录太频繁，请稍后再试" });
    }
    if (!grantUsable(grant)) {
      await authLog(
        db,
        { event: "login_fail", success: false, userName: `代登录·${name}`, detail: "委托已过期" },
        req,
      );
      return res.status(410).json({ code: 410, msg: "这条委托已过期或被撤销" });
    }

    const users = db.collection("user");
    let shadow = await users.findOne({ delegateGrantId: grant._id, delegateName: name });
    let createdNow = false;
    if (!shadow) {
      const doc: any = {
        _id: new ObjectId(),
        userName: `委托·${name}`,
        passWord: null,
        admin: false,
        tokenVersion: 0,
        isDelegate: true,
        delegateOwnerId: grant.ownerId,
        delegateGrantId: grant._id,
        delegateName: name,
        createdAt: new Date(),
      };
      await users.insertOne(doc);
      shadow = doc;
      createdNow = true;
      log(`[grant] 代登录创建影子账号 ${doc._id}（${doc.userName}）`, "info", "auth");
    } else {
      await users.updateOne({ _id: shadow!._id }, { $set: { lastSeenAt: new Date() } });
    }

    if (!shadow) return res.json({ code: 500, msg: "创建代登录身份失败" });
    const acc = await acceptGrant(db, grant, shadow!._id);
    if ((acc as any).full) {
      // 名额已满：把刚建的空影子账号收回去，别留垃圾账号
      if (createdNow) await users.deleteOne({ _id: shadow!._id });
      return res.status(409).json({
        code: 409,
        msg: `这份委托的代登录名额已满（${(acc as any).used}/${(acc as any).maxUses}）`,
      });
    }

    const tv = Number(shadow!.tokenVersion ?? 0) || 0;
    const token = jwt.sign(
      {
        userId: shadow!._id,
        userName: shadow!.userName,
        admin: false,
        tv,
        delegate: true,
        delegateGrantId: String(grant._id),
      },
      config.jwt.secret,
      { expiresIn: "7d" },
    );

    const owner = await users.findOne({ _id: grant.ownerId });
    await authLog(
      db,
      {
        userId: shadow!._id,
        userName: shadow!.userName,
        event: "login",
        success: true,
        detail: `代登录（委托 ${grant._id}，委托人 ${owner?.userName || grant.ownerId}）`,
      },
      req,
    );

    res.json({
      code: 0,
      msg: "已进入委托",
      data: {
        token,
        userId: String(shadow!._id),
        userName: shadow!.userName,
        delegate: true,
        ownerName: owner?.userName || "",
        caps: (grant.caps || []).map((c: any) => CAP_LABELS[c as keyof typeof CAP_LABELS] || c),
        expiresAt: grant.expiresAt,
      },
    });
  } catch (error: any) {
    log(`代登录失败：${error?.message || error}`, "error", "auth");
    res.status(500).json({ code: 500, msg: "服务器错误，请稍后再试" });
  }
});

export default delegateLoginRouter;
