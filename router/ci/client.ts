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

    const cls = await db.collection("ci_classes").findOne({ identity: clientDoc.identity });
    if (!cls) {
      return res.status(404).json({ code: 404, msg: `未找到班级（identity: ${clientDoc.identity}）` });
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
