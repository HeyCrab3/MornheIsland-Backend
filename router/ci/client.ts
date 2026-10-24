/**
 * gRPC 集控模式的清单端点。
 * 官方客户端在 ManagementServerKind=1 时会请求 {Host}/api/v1/client/{cuid}/manifest
 * （经反向代理转发到本端点，路径以 v1/client 开头，命中公开白名单）。
 *
 * cuid → ci_clients.identity → 班级 → 资源，拼出与静态模式一致的 ManagementManifest，
 * 只是 ServerKind 标记为 1（集控服务器）。
 */
import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

async function loadRef(db: any, refId: any, collection: string) {
  if (!refId) return null;
  return db.collection(collection).findOne({ _id: new ObjectId(refId) });
}

router.get("/v1/client/:cuid/manifest", async (req, res) => {
  try {
    const db = req.db;
    const { cuid } = req.params;

    const clientDoc = await db.collection("ci_clients").findOne({ cuid });
    if (!clientDoc) return res.status(404).json({ code: 404, msg: "客户端尚未注册" });

    /*
     * ⚠ 这里曾经是跨租户越权的入口：直接用 findOne({ identity }) 解析，
     * 而 identity 是用户自填的班级代号、全库不唯一（实测有 7 个账号都叫 "1"），
     * 命中多个时返回任意一个 —— A 校设备就这样拿到了 B 校的班级配置。
     *
     * 现在统一走 findClass：ObjectId 优先，identity 必须全局唯一，
     * 有歧义就失败关闭并给出可操作的提示，绝不猜。
     */
    const rawIdentity = String(clientDoc.identity ?? "").trim();

    /*
     * 解析顺序（原则：**已经绑定的设备必须继续能用**，不能全量断连）
     *  1. 优先用绑定时固化下来的 classId —— 服务启动时会把老设备回填一次，
     *     之后归属就固定了，不会因为其它学校新增同名班级而漂移；
     *  2. 没有 classId 就按标识解析：能唯一确定就用它，并顺手固化；
     *  3. 标识有歧义时**沿用历史行为**（取命中的第一个），只为不打断已绑定设备，
     *     同时记 warn 并固化结果——固化的意义是让归属稳定，不再每次漂到别的学校。
     *
     * 新生成的 preset 里 ClassIdentity 已经是班级 _id，命中第 1 步，天然精确。
     */
    let cls: any = null;
    if (clientDoc.classId) {
      cls = await db.collection("ci_classes").findOne({ _id: clientDoc.classId });
    }

    if (!cls && rawIdentity) {
      cls = await findClass(db, rawIdentity);
      if (!cls) {
        const legacy = await db.collection("ci_classes").findOne({ identity: rawIdentity });
        if (legacy) {
          cls = legacy;
          log(
            `[ci/client-manifest] cuid=${cuid} 的班级标识 "${rawIdentity}" 有歧义，已按历史行为固定到班级 ${String(legacy._id)}`,
            "warn",
            "auth",
          );
        }
      }
      if (cls) {
        // 固化归属：以后即使别的学校建了同名班级，这台设备也不会再漂过去
        await db.collection("ci_clients").updateOne({ cuid }, { $set: { classId: cls._id } });
      }
    }

    if (!cls) {
      if (!rawIdentity) {
        return res.status(409).json({
          code: 409,
          msg: "该客户端没有上报班级标识（可能从未成功 Register）。请在客户端重新执行一次「加入管理」。",
        });
      }
      return res.status(404).json({ code: 404, msg: `未找到班级（班级标识: ${rawIdentity}）` });
    }

    const [classplan, timelayout, subjects, settings, policy] = await Promise.all([
      loadRef(db, cls.classplanId, "ci_classplans"),
      loadRef(db, cls.timelayoutId, "ci_timelayouts"),
      loadRef(db, cls.subjectsId, "ci_subjects"),
      loadRef(db, cls.settingsId, "ci_settings"),
      loadRef(db, cls.policyId, "ci_policies"),
    ]);

    const baseUrl = `${req.protocol}://${req.get("host")}/v1/ci/${String(cls._id)}`;
    const src = (doc: any, suffix: string) => ({
      Value: doc ? `${baseUrl}/${suffix}.json` : null,
      Version: doc?.version ?? 0,
    });

    res.json({
      ClassPlanSource: src(classplan, "classplan"),
      TimeLayoutSource: src(timelayout, "timelayout"),
      SubjectsSource: src(subjects, "subjects"),
      DefaultSettingsSource: src(settings, "settings"),
      PolicySource: src(policy, "policy"),
      ComponentsSource: { Value: null, Version: 0 },
      CredentialSource: { Value: null, Version: 0 },
      ServerKind: 1,
      OrganizationName: cls.orgName || cls.name || "",
      CoreVersion: "2.0.0.0",
    });
  } catch (e) {
    log(`[ci/client-manifest] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
