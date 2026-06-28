import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

/** POST /v1/console/ci/class — 创建班级，可选关联已有资源 */
router.post("/v1/console/ci/class", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const { identity, name, orgName, classplanId, timelayoutId, subjectsId, settingsId, policyId } = req.body;
    if (!name) {
      return res.status(400).json({ code: 400, msg: "name 为必填项" });
    }

    const toRef = (id: string | undefined) => (id ? new ObjectId(id) : null);

    const doc = {
      _id: new ObjectId(),
      userId,
      identity,
      name,
      orgName: orgName || "",
      classplanId: toRef(classplanId),
      timelayoutId: toRef(timelayoutId),
      subjectsId: toRef(subjectsId),
      settingsId: toRef(settingsId),
      policyId: toRef(policyId),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("ci_classes").insertOne(doc);
    log(`[ci] 用户 ${userId} 创建班级 ${identity}`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: doc });
  } catch (e) {
    log(`[ci/class/create] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** GET /v1/console/ci/class/list */
router.get("/v1/console/ci/class/list", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const classes = await req.db.collection("ci_classes")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ code: 0, msg: "ok", data: classes });
  } catch (e) {
    log(`[ci/class/list] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/**
 * 填充班级关联的资源名称和版本号（用于详情展示）。
 */
async function populateResources(db: any, cls: any) {
  const refFields = ["classplanId", "timelayoutId", "subjectsId", "settingsId", "policyId"];
  const collMap: Record<string, string> = {
    classplanId: "ci_classplans",
    timelayoutId: "ci_timelayouts",
    subjectsId: "ci_subjects",
    settingsId: "ci_settings",
    policyId: "ci_policies",
  };

  const populated: any = { ...cls };
  await Promise.all(
    refFields.map(async (field) => {
      const refId = (cls as any)[field];
      if (!refId) { populated[field] = null; return; }
      const doc = await db.collection(collMap[field]).findOne({ _id: refId });
      populated[field] = doc
        ? { _id: doc._id, name: doc.name, version: doc.version, data: doc.data }
        : null;
    }),
  );
  return populated;
}

/** GET /v1/console/ci/class/:id */
router.get("/v1/console/ci/class/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const cls = await req.db.collection("ci_classes").findOne({
      _id: new ObjectId(req.params.id),
      userId,
    });
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const data = await populateResources(req.db, cls);
    res.json({ code: 0, msg: "ok", data });
  } catch (e) {
    log(`[ci/class/detail] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** PUT /v1/console/ci/class/:id */
router.put("/v1/console/ci/class/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const { name, orgName, classplanId, timelayoutId, subjectsId, settingsId, policyId } = req.body;
    const toRef = (id: string | undefined) => (id === undefined ? undefined : id ? new ObjectId(id) : null);

    const set: any = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (orgName !== undefined) set.orgName = orgName;
    if (classplanId !== undefined) set.classplanId = toRef(classplanId);
    if (timelayoutId !== undefined) set.timelayoutId = toRef(timelayoutId);
    if (subjectsId !== undefined) set.subjectsId = toRef(subjectsId);
    if (settingsId !== undefined) set.settingsId = toRef(settingsId);
    if (policyId !== undefined) set.policyId = toRef(policyId);

    const result = await db.collection("ci_classes").updateOne(
      { _id: new ObjectId(req.params.id), userId },
      { $set: set },
    );
    if (result.matchedCount === 0) return res.status(404).json({ code: 404, msg: "班级不存在" });
    res.json({ code: 0, msg: "ok" });
  } catch (e) {
    log(`[ci/class/update] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** DELETE /v1/console/ci/class/:id — 只删班级，不删关联资源 */
router.delete("/v1/console/ci/class/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const classId = new ObjectId(req.params.id);
    const cls = await db.collection("ci_classes").findOne({ _id: classId, userId });
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    await db.collection("ci_classes").deleteOne({ _id: classId });
    log(`[ci] 用户 ${userId} 删除班级 ${(cls as any).identity}`, "info", "auth");
    res.json({ code: 0, msg: "ok" });
  } catch (e) {
    log(`[ci/class/delete] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
