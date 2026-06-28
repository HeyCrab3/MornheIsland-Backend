import express from "express";
import { history, getHistoryVersion, restore } from "../../../util/ci_resource";

const router = express.Router();

// 所有资源类型共享的历史路由
const TYPES = ["classplan", "timelayout", "subjects", "settings", "policy"];

for (const type of TYPES) {
  router.get(`/v1/console/ci/${type}/:id/history`, (req, res) => history(req, res, `ci_${type}s`));
  router.get(`/v1/console/ci/${type}/:id/history/:version`, (req, res) => getHistoryVersion(req, res, `ci_${type}s`));
  router.post(`/v1/console/ci/${type}/:id/restore/:version`, (req, res) => restore(req, res, `ci_${type}s`));
}

export default router;
