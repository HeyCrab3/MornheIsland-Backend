import express from "express";
import { history, getHistoryVersion, restore } from "../../../util/ci_resource";

const router = express.Router();

/**
 * 所有资源类型共享的历史路由。
 *
 * ⚠ 不能靠 `ci_${type}s` 拼集合名：policy → "ci_policys"（正确是 ci_policies），
 * 结果策略的历史版本接口静默失效。这里显式列出映射。
 */
const COLLECTION: Record<string, string> = {
  classplan: "ci_classplans",
  timelayout: "ci_timelayouts",
  subjects: "ci_subjects",
  settings: "ci_settings",
  policy: "ci_policies",
};

for (const [type, collection] of Object.entries(COLLECTION)) {
  router.get(`/v1/console/ci/${type}/:id/history`, (req, res) => history(req, res, collection));
  router.get(`/v1/console/ci/${type}/:id/history/:version`, (req, res) => getHistoryVersion(req, res, collection));
  router.post(`/v1/console/ci/${type}/:id/restore/:version`, (req, res) => restore(req, res, collection));
}

export default router;
