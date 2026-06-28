import express from "express";
import { list, create, get, update, remove } from "../../../util/ci_resource";

const COL = "ci_subjects";
const router = express.Router();
router.get("/v1/console/ci/subjects/list", (req, res) => list(req, res, COL));
router.post("/v1/console/ci/subjects", (req, res) => create(req, res, COL));
router.get("/v1/console/ci/subjects/:id", (req, res) => get(req, res, COL));
router.put("/v1/console/ci/subjects/:id", (req, res) => update(req, res, COL));
router.delete("/v1/console/ci/subjects/:id", (req, res) => remove(req, res, COL));
export default router;
