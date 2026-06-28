import express from "express";
import { list, create, get, update, remove } from "../../../util/ci_resource";

const COL = "ci_classplans";
const router = express.Router();
router.get("/v1/console/ci/classplan/list", (req, res) => list(req, res, COL));
router.post("/v1/console/ci/classplan", (req, res) => create(req, res, COL));
router.get("/v1/console/ci/classplan/:id", (req, res) => get(req, res, COL));
router.put("/v1/console/ci/classplan/:id", (req, res) => update(req, res, COL));
router.delete("/v1/console/ci/classplan/:id", (req, res) => remove(req, res, COL));
export default router;
