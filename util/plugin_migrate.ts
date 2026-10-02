/**
 * 补齐历史 ci_plugins 文档缺失的 pluginId。
 *
 * 早期上传/市场导入的插件没有存 manifest id，而插件对账必须用它比对
 * （客户端上报的是 manifest id），缺了就会被当成「未识别 id」跳过，
 * 导致这些插件永远下发不出去。
 *
 * marketId 本身就是市场索引里的 Manifest.Id，可直接用；
 * 手动上传的则从落盘的 .cipx 里读回来。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { client as mongoClient } from "./db";
import { config } from "../config";
import { readCipxManifest } from "./cipx";
import { log } from "./log";

const PLUGINS_DIR = path.join(process.cwd(), "plugins");

export async function backfillPluginIds(): Promise<void> {
  try {
    const db = mongoClient.db(config.db_name);
    const docs: any[] = await db
      .collection("ci_plugins")
      .find({ $or: [{ pluginId: { $exists: false } }, { pluginId: "" }, { pluginId: null }] })
      .toArray();
    if (!docs.length) return;

    let fixed = 0;
    for (const d of docs) {
      let id = String(d.marketId || "");

      if (!id && d.storedName) {
        const p = path.join(PLUGINS_DIR, String(d.storedName));
        if (existsSync(p)) {
          try {
            id = readCipxManifest(readFileSync(p)).id;
          } catch { /* 单个文件读失败不影响其它 */ }
        }
      }

      if (!id) continue;
      await db.collection("ci_plugins").updateOne({ _id: d._id }, { $set: { pluginId: id } });
      fixed++;
    }

    if (fixed) log(`[plugin] 已为 ${fixed} 个历史插件补齐 pluginId`, "info", "auth");
  } catch (e) {
    log(`[plugin] 补齐 pluginId 失败：${e}`, "error", "auth");
  }
}
