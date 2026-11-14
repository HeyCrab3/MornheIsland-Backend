import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
import { getSchoolRole } from "../../../util/school";
import { grantedClassIdsAny } from "../../../util/ci_grant";

const router = express.Router();

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  return uid ? new ObjectId(uid) : null;
}

/**
 * 校验并规范化 `schoolId`（可选）。
 * 只有我加入的学校才能挂 —— 否则等于把班级塞进别人的学校。
 */
async function resolveSchoolId(
  db: any,
  userId: ObjectId,
  raw: any,
): Promise<{ ok: boolean; value?: ObjectId | null; msg?: string }> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === "") return { ok: true, value: null };
  if (!ObjectId.isValid(String(raw))) return { ok: false, msg: "schoolId 非法" };
  const sid = new ObjectId(String(raw));
  const role = await getSchoolRole(db, sid, userId);
  if (!role) return { ok: false, msg: "你不在这所学校里" };
  return { ok: true, value: sid };
}

/** POST /v1/console/ci/class — 创建班级，可选关联已有资源与学校 */
router.post("/v1/console/ci/class", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const { identity, name, orgName, classplanId, timelayoutId, subjectsId, settingsId, policyId, schoolId } = req.body;
    if (!name) {
      return res.status(400).json({ code: 400, msg: "name 为必填项" });
    }

    const school = await resolveSchoolId(db, userId, schoolId);
    if (!school.ok) return res.status(403).json({ code: 403, msg: school.msg });

    const toRef = (id: string | undefined) => (id ? new ObjectId(id) : null);

    const doc: any = {
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
    // 关联学校是可选项：不传就跟以前一样留在个人模式
    if (school.value) doc.schoolId = school.value;

    await db.collection("ci_classes").insertOne(doc);
    log(
      `[ci] 用户 ${userId} 创建班级 ${identity}${school.value ? `（归属学校 ${school.value}）` : ""}`,
      "info",
      "auth",
    );
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

    const owned = await req.db.collection("ci_classes")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    // 别人委托给我的班：能看、能按授权动资源/设备，但不能改班级本身
    const grantedIds = await grantedClassIdsAny(req.db, userId);
    let granted: any[] = [];
    if (grantedIds.length) {
      granted = await req.db.collection("ci_classes")
        .find({ _id: { $in: grantedIds } })
        .sort({ createdAt: -1 })
        .toArray();
    }

    const data = [
      ...owned.map((c: any) => ({ ...c, viaGrant: false })),
      ...granted
        .filter((c: any) => String(c.userId) !== String(userId))
        .map((c: any) => ({
          ...c,
          viaGrant: true,
          ownerId: String(c.userId),
          userId: String(c.userId),
        })),
    ];
    res.json({ code: 0, msg: "ok", data });
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
  // 把 ObjectId 转成字符串，防止序列化成 {"$oid":"..."}
  populated._id = String(populated._id);
  populated.userId = String(populated.userId);
  await Promise.all(
    refFields.map(async (field) => {
      const refId = (cls as any)[field];
      if (!refId) { populated[field] = null; return; }
      const doc = await db.collection(collMap[field]).findOne({ _id: refId });
      populated[field] = doc
        ? { _id: String(doc._id), name: doc.name, version: doc.version }
        : String(refId);
    }),
  );
  return populated;
}

/** GET /v1/console/ci/class/:id */
router.get("/v1/console/ci/class/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const classOid = new ObjectId(req.params.id);
    const cls = await req.db.collection("ci_classes").findOne({ _id: classOid, userId });
    if (!cls) {
      // 受托的班级也能看详情（资源与设备都在授权范围内），但标记为只读
      const grantedIds = await grantedClassIdsAny(req.db, userId);
      const covered = grantedIds.some((g) => String(g) === String(classOid));
      const shared = covered ? await req.db.collection("ci_classes").findOne({ _id: classOid }) : null;
      if (!shared) return res.status(404).json({ code: 404, msg: "班级不存在" });
      const data = await populateResources(req.db, shared);
      data.viaGrant = true;
      data.ownerId = String(shared.userId);
      return res.json({ code: 0, msg: "ok", data });
    }

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
    const { name, orgName, classplanId, timelayoutId, subjectsId, settingsId, policyId, schoolId } = req.body;
    const toRef = (id: string | undefined) => (id === undefined ? undefined : id ? new ObjectId(id) : null);

    const school = await resolveSchoolId(db, userId, schoolId);
    if (!school.ok) return res.status(403).json({ code: 403, msg: school.msg });

    const set: any = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (orgName !== undefined) set.orgName = orgName;
    if (classplanId !== undefined) set.classplanId = toRef(classplanId);
    if (timelayoutId !== undefined) set.timelayoutId = toRef(timelayoutId);
    if (subjectsId !== undefined) set.subjectsId = toRef(subjectsId);
    if (settingsId !== undefined) set.settingsId = toRef(settingsId);
    if (policyId !== undefined) set.policyId = toRef(policyId);

    const unset: any = {};
    if (school.value === null) unset.schoolId = "";      // 传空 = 移出学校
    else if (school.value) set.schoolId = school.value;  // 传 id = 挂入/换学校

    const update: any = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;

    const result = await db.collection("ci_classes").updateOne(
      { _id: new ObjectId(req.params.id), userId },
      update,
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
