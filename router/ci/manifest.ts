import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";

const router = express.Router();

async function loadRef(db: any, refId: any, collection: string) {
  if (!refId) return null;
  return db.collection(collection).findOne({ _id: new ObjectId(refId) });
}

router.get("/v1/ci/:classIdentity/manifest.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const [classplan, timelayout, subjects, settings, policy] = await Promise.all([
      loadRef(db, cls.classplanId, "ci_classplans"),
      loadRef(db, cls.timelayoutId, "ci_timelayouts"),
      loadRef(db, cls.subjectsId, "ci_subjects"),
      loadRef(db, cls.settingsId, "ci_settings"),
      loadRef(db, cls.policyId, "ci_policies"),
    ]);

    const baseUrl = `${req.protocol}://${req.get("host")}/v1/ci/${String(cls._id)}`;

    res.json({
      ServerKind: 0,
      OrganizationName:  cls.orgName || cls.name || "",
      CoreVersion: "2.0.0.0",
      ClassPlanSource: {
        Value: classplan ? `${baseUrl}/classplan.json` : null,
        Version: classplan?.version ?? 0,
      },
      TimeLayoutSource: {
        Value: timelayout ? `${baseUrl}/timelayout.json` : null,
        Version: timelayout?.version ?? 0,
      },
      SubjectsSource: {
        Value: subjects ? `${baseUrl}/subjects.json` : null,
        Version: subjects?.version ?? 0,
      },
      DefaultSettingsSource: {
        Value: settings ? `${baseUrl}/settings.json` : null,
        Version: settings?.version ?? 0,
      },
      PolicySource: {
        Value: policy ? `${baseUrl}/policy.json` : null,
        Version: policy?.version ?? 0,
      },
    });
  } catch (e) {
    log(`[ci/manifest] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
