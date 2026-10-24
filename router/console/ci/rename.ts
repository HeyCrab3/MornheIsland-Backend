/**
 * 资源改名（课表 / 时间表 / 科目 / 设置 / 策略）。
 *
 * 为什么不复用 PUT /v1/console/ci/{type}/:id：
 * 那个接口每次都会 **version+1 并写历史版本**，而改名纯粹是显示层的事——
 * 走它会让所有客户端把配置当成"有新版本"重新拉一遍，白白刷新一轮。
 * 所以这里单独做一个只改 name 的轻量接口。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

/** type 段 → 集合名 + 中文名 */
const TYPE_MAP: Record<string, { collection: string; label: string }> = {
  classplan: { collection: "ci_classplans", label: "课表" },
  timelayout: { collection: "ci_timelayouts", label: "时间表" },
  subjects: { collection: "ci_subjects", label: "课程表" },
  settings: { collection: "ci_settings", label: "设置" },
  policy: { collection: "ci_policies", label: "策略" },
};

const MAX_NAME_LEN = 100;

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

router.post("/v1/console/ci/:type/:id/rename", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const meta = TYPE_MAP[String(req.params.type)];
    if (!meta) return res.status(400).json({ code: 400, msg: "不支持的资源类型" });

    const oid = String(req.params.id);
    if (!ObjectId.isValid(oid)) return res.status(400).json({ code: 400, msg: "资源 ID 非法" });

    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ code: 400, msg: "名称不能为空" });
    if (name.length > MAX_NAME_LEN) {
      return res.status(400).json({ code: 400, msg: `名称不能超过 ${MAX_NAME_LEN} 个字符` });
    }

    const col = req.db.collection(meta.collection);
    const existing = await col.findOne({ _id: new ObjectId(oid), userId });
    if (!existing) return res.status(404).json({ code: 404, msg: `${meta.label}不存在` });

    if (String(existing.name ?? "") === name) {
      return res.json({ code: 0, msg: "ok", data: { name, changed: false } });
    }

    // 同名容易在班级关联下拉里选错，直接拦掉
    const dup = await col.findOne({ userId, name, _id: { $ne: existing._id } });
    if (dup) {
      return res.status(409).json({ code: 409, msg: `已存在同名的${meta.label}：${name}` });
    }

    // 只改 name：不动 version、不写历史版本
    await col.updateOne({ _id: existing._id }, { $set: { name, updatedAt: new Date() } });
    log(`[ci] 用户 ${userId} 重命名${meta.label}：「${existing.name}」→「${name}」`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { name, changed: true } });
  } catch (e) {
    log(`[ci/rename] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
