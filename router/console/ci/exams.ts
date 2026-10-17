/**
 * 考试安排（控制台管理侧）。
 *
 * 按**账号**存：一个账号一份考试安排，该账号下所有班级共用。
 * 这样在一个地方配好，之后新增/部署到别的班级不用重复录入。
 *
 * 覆盖规则（在看板里生效）：考试时段与标准课时**时间重合时以考试为准**，
 * 重合的标准课时整段被替换，不重合的照常。
 *
 * 存储：ci_exams，一个 userId 一条文档。
 */

import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";

const router = express.Router();

const COL = "ci_exams";
const MAX_ENTRIES = 500;
const MAX_SUBJECT_LEN = 40;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function getUserId(req: any): ObjectId | null {
  const uid = req.auth?.userId;
  if (!uid) return null;
  try {
    return new ObjectId(uid);
  } catch {
    return null;
  }
}

export interface ExamEntry {
  date: string;
  subject: string;
  start: string;
  end: string;
}

/** 校验并规范化条目；返回清洗后的数组与错误列表 */
export function normalizeExamEntries(input: any): { entries: ExamEntry[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { entries: [], errors: ["entries 必须是数组"] };
  if (input.length > MAX_ENTRIES) errors.push(`最多只能保存 ${MAX_ENTRIES} 条`);

  const out: ExamEntry[] = [];
  input.slice(0, MAX_ENTRIES).forEach((raw: any, i: number) => {
    const at = `第 ${i + 1} 条`;
    const date = String(raw?.date ?? "").trim();
    const subject = String(raw?.subject ?? "").trim();
    const start = String(raw?.start ?? "").trim();
    const end = String(raw?.end ?? "").trim();

    if (!DATE_RE.test(date)) return errors.push(`${at}：日期格式应为 YYYY-MM-DD`);
    if (!subject) return errors.push(`${at}：科目不能为空`);
    if (subject.length > MAX_SUBJECT_LEN) return errors.push(`${at}：科目不超过 ${MAX_SUBJECT_LEN} 字`);
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return errors.push(`${at}：时间格式应为 HH:MM`);
    if (end <= start) return errors.push(`${at}：结束时间要晚于开始时间`);

    out.push({ date, subject, start, end });
  });

  out.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  return { entries: out, errors };
}

/** GET /v1/console/ci/exams — 取当前账号的考试安排 */
router.get("/v1/console/ci/exams", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const doc = await req.db.collection(COL).findOne({ userId });
    res.json({
      code: 0,
      msg: "ok",
      data: {
        entries: doc?.entries || [],
        updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      },
    });
  } catch (e) {
    log(`[ci/exams/get] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

/** PUT /v1/console/ci/exams — 整体覆盖保存 */
router.put("/v1/console/ci/exams", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const { entries, errors } = normalizeExamEntries(req.body?.entries);
    if (errors.length) {
      return res.status(400).json({ code: 400, msg: errors.slice(0, 5).join("；") });
    }

    const now = new Date();
    await req.db.collection(COL).updateOne(
      { userId },
      {
        $set: { userId, entries, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true },
    );
    log(`[ci] 用户 ${userId} 更新考试安排（${entries.length} 条）`, "info", "auth");
    res.json({ code: 0, msg: "ok", data: { count: entries.length, updatedAt: now.toISOString() } });
  } catch (e) {
    log(`[ci/exams/put] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
