/**
 * 插件包公开下载端点（无需 JWT，供 ClassIsland 客户端拉取 .cipx）。
 * 路径以 v1/ci 开头，命中 router_whitelist 的公开前缀。
 *
 * 只有「本机托管」（用户上传、无处托管）的插件才走这里；
 * 市场/直链来源的插件由客户端直接去上游下载，不经过本端点。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "../../util/log";

const router = express.Router();
const PLUGINS_DIR = path.join(process.cwd(), "plugins");

router.get("/v1/ci/plugin/:id/download", async (req, res) => {
  try {
    const doc = await req.db.collection("ci_plugins").findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ code: 404, msg: "插件不存在" });
    if (!doc.storedName) {
      // 直链来源的插件没有本地文件，客户端应该用登记的上游地址
      return res.status(404).json({ code: 404, msg: "该插件为直链来源，请从上游地址下载" });
    }

    const p = path.join(PLUGINS_DIR, doc.storedName);
    if (!existsSync(p)) return res.status(404).json({ code: 404, msg: "插件文件丢失" });

    log(`[plugin] 下发插件文件 ${doc.name} → ${req.ip}`, "info", "access");
    res.download(p, doc.fileName || `${doc.name}.cipx`);
  } catch (e) {
    log(`[plugin/download] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "下载失败" });
  }
});

export default router;
