import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log";
// import { v4 as uuidv4 } from "uuid";

const router = express.Router();

interface CesSubject { name: string; simplified_name: string; teacher?: string; room?: string }
interface CesClass { subject: string; start_time: string; end_time: string }
interface CesSchedule { name: string; classes: CesClass[]; enable_day: number; weeks: string }

function weeksToDiv(weeks: string): number {
  if (weeks === "odd" || weeks === "单") return 1;
  if (weeks === "even" || weeks === "双") return 2;
  return 0; // all
}

function enableDayToWeekDay(d: number): number {
  return d === 7 ? 0 : d; // CES: 7=周日 → ClassIsland: 0=周日
}

/** 将 subject name 映射到已生成的 subjectsUUID map */
function resolveSubjectUuid(name: string, subjectMap: Map<string, string>, dbSubjects: Record<string, any>): string | null {
  // 先精确匹配
  if (subjectMap.has(name)) return subjectMap.get(name)!;
  // 模糊匹配（删除空格等）
  const trimmed = name.trim();
  if (subjectMap.has(trimmed)) return subjectMap.get(trimmed)!;
  // 查数据库现有
  for (const [uuid, sub] of Object.entries(dbSubjects)) {
    if ((sub as any).Name === name || (sub as any).Name === trimmed) return uuid;
  }
  return null;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

router.post("/v1/console/ci/import/ces", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });

    const db = req.db;
    const uid = new ObjectId(userId);
    const { yaml, name } = req.body;
    if (!yaml) return res.status(400).json({ code: 400, msg: "缺少 YAML 内容" });

    // 解析 YAML（简单行解析，避免引入 js-yaml 依赖）
    const ces = parseCesYaml(yaml);
    if (!ces || !ces.subjects || !ces.schedules) {
      return res.status(400).json({ code: 400, msg: "无法解析 CES YAML 格式" });
    }

    // ── 过滤临时层 ──
    const schedules = ces.schedules.filter((s: CesSchedule) => !s.name.includes("临时"));

    // 两周轮换周期固定为 2（对应 ClassIsland 的 WeekCountDivTotal；
    // 纯「每周(all)」的课表同样为 2，WeekCountDiv=0 表示每周生效）
    const totalWeeks = 2;

    // ── 1. 生成科目（ClassIsland UUID 格式） ──
    const subjectsData: Record<string, any> = {};
    const subjectUuidMap = new Map<string, string>();
    for (const sub of ces.subjects) {
      const uuid = generateUUID();
      subjectUuidMap.set(sub.name, uuid);
      subjectsData[uuid] = {
        Name: sub.name,
        Initial: sub.simplified_name || sub.name.charAt(0),
        TeacherName: sub.teacher || "",
        IsOutDoor: sub.name === "体育",
      };
    }

    // ── 2. 从 schedules 提取唯一的时间点生成时间表 ──
    const timePointSet = new Map<string, { Start: string; End: string }>();
    for (const sched of schedules) {
      for (const cls of sched.classes) {
        const key = `${cls.start_time}-${cls.end_time}`;
        if (!timePointSet.has(key)) {
          timePointSet.set(key, { Start: cls.start_time, End: cls.end_time });
        }
      }
    }
    // 排序
    const timePoints = Array.from(timePointSet.values()).sort((a, b) =>
      a.Start.localeCompare(b.Start),
    );
    const timePointIndexMap = new Map<string, number>();
    timePoints.forEach((tp, i) => {
      tp.TimePointName = `第${i + 1}节`;
      timePointIndexMap.set(`${tp.Start}-${tp.End}`, i);
    });

    const tlUuid = generateUUID();

    // 生成 ClassIsland 格式的 Layouts（上课段 + 自动插入课间），而非 TimePoints
    const layouts: any[] = [];
    for (let i = 0; i < timePoints.length; i++) {
      const tp = timePoints[i];
      const prevEnd = i > 0 ? timePoints[i - 1].End : "";
      if (prevEnd && tp.Start && prevEnd !== tp.Start) {
        layouts.push({ StartSecond: "", EndSecond: "", StartTime: prevEnd, EndTime: tp.Start, TimeType: 1, IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000", BreakName: "", ActionSet: null, AttachedObjects: {}, IsActive: false });
      }
      layouts.push({ StartSecond: "", EndSecond: "", StartTime: tp.Start, EndTime: tp.End, TimeType: 0, TimePointName: tp.TimePointName, IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000", BreakName: "", ActionSet: null, AttachedObjects: {}, IsActive: false });
    }

    const timelayoutData: Record<string, any> = {
      [tlUuid]: {
        Name: `${name || "导入课表"} 时间表`,
        Layouts: layouts,
      },
    };

    // ── 3. 生成课表 ──
    const classPlans: Record<string, any> = {};
    for (const sched of schedules) {
      const wd = enableDayToWeekDay(sched.enable_day);
      const wcd = weeksToDiv(sched.weeks);
      const cpUuid = generateUUID();
      const classes: any[] = [];
      const totalSlots = timePoints.length;

      for (let i = 0; i < totalSlots; i++) {
        // 找到对应时间点的课程
        const tp = timePoints[i];
        const match = sched.classes.find(
          (c) => c.start_time === tp.Start && c.end_time === tp.End,
        );
        if (match) {
          const subUuid = resolveSubjectUuid(match.subject, subjectUuidMap, subjectsData);
          classes.push(subUuid
            ? { SubjectId: subUuid, IsChangedClass: false, IsEnabled: true, AttachedObjects: {}, IsActive: false }
            : { SubjectId: null, IsChangedClass: false, IsEnabled: false, AttachedObjects: {}, IsActive: false }
          );
        } else {
          classes.push({ SubjectId: null, IsChangedClass: false, IsEnabled: false, AttachedObjects: {}, IsActive: false });
        }
      }

      classPlans[cpUuid] = {
        TimeLayoutId: tlUuid,
        TimeRule: { WeekDay: wd, WeekCountDiv: wcd, WeekCountDivTotal: totalWeeks, IsActive: false },
        Classes: classes,
        Name: sched.name,
        IsOverlay: false,
        OverlaySourceId: null,
        OverlaySetupTime: new Date().toISOString(),
        IsEnabled: true,
        AssociatedGroup: "00000000-0000-0000-0000-000000000000",
        AttachedObjects: {},
        IsActive: false,
      };
    }

    // ── 4. 写入数据库 ──
    const subjectsDoc = {
      _id: new ObjectId(),
      userId: uid,
      name: `${name || "导入"} 课程表`,
      data: subjectsData,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tlDoc = {
      _id: new ObjectId(),
      userId: uid,
      name: `${name || "导入"} 时间表`,
      data: timelayoutData,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const cpDoc = {
      _id: new ObjectId(),
      userId: uid,
      name: `${name || "导入"} 课表`,
      data: {
        classPlans,
        timelayoutId: tlDoc._id,
        subjectsId: subjectsDoc._id,
      },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection("ci_subjects").insertOne(subjectsDoc);
    await db.collection("ci_timelayouts").insertOne(tlDoc);
    await db.collection("ci_classplans").insertOne(cpDoc);

    log(`[ci/import] 用户 ${userId} 导入 CES 课程表`, "info", "auth");
    res.json({
      code: 0,
      msg: "ok",
      data: {
        subjectsId: subjectsDoc._id,
        timelayoutId: tlDoc._id,
        classplanId: cpDoc._id,
      },
    });
  } catch (e) {
    log(`[ci/import/ces] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "导入失败: " + e });
  }
});

/** 极简 YAML 解析器（状态机，容忍不同缩进风格） */
function parseCesYaml(text: string): any {
  const lines = text.split("\n");
  const result: any = { subjects: [], schedules: [] };
  let section: "subjects" | "schedules" | null = null;
  let sectionBase = 0; // 当前段的基准缩进
  let currentSchedule: any = null;
  let currentSubject: any = null;
  let currentClass: any = null;

  for (const line of lines) {
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // 段声明（indent 0）
    if (indent === 0 && !trimmed.startsWith("-")) {
      if (trimmed.startsWith("version:")) continue;
      if (trimmed === "subjects:") { section = "subjects"; sectionBase = 0; continue; }
      if (trimmed === "schedules:") { section = "schedules"; sectionBase = 0; continue; }
      continue;
    }

    const rel = indent - sectionBase; // 相对缩进

    if (section === "subjects") {
      // - name: xxx  (rel 0 或 2，兼容不同格式化)
      if (trimmed.startsWith("- name:") && (rel === 0 || rel === 2)) {
        currentSubject = { name: trimmed.slice(7).trim().replace(/^['"]|['"]$/g, "") };
        result.subjects.push(currentSubject);
        continue;
      }
      // 子属性 (rel 2 或 4)
      if (currentSubject && (rel === 2 || rel === 4)) {
        const [k, ...v] = trimmed.split(":");
        const val = v.join(":").trim().replace(/^['"]|['"]$/g, "");
        if (k === "simplified_name") currentSubject.simplified_name = val;
        if (k === "teacher") currentSubject.teacher = val;
        if (k === "room") currentSubject.room = val;
      }
    }

    if (section === "schedules") {
      // - name: xxx  (rel 0 或 2)
      if (trimmed.startsWith("- name:") && (rel === 0 || rel === 2)) {
        currentSchedule = { name: trimmed.slice(7).trim().replace(/^['"]|['"]$/g, ""), classes: [] };
        result.schedules.push(currentSchedule);
        currentClass = null;
        continue;
      }
      // classes:  (rel 2 或 4)
      if (trimmed === "classes:" && (rel === 2 || rel === 4)) { continue; }
      // - subject: xxx  (rel 2 或 4 或 6)
      if (trimmed.startsWith("- subject:") && (rel === 2 || rel === 4 || rel === 6)) {
        if (!currentSchedule) continue;
        currentClass = { subject: trimmed.slice(10).trim().replace(/^['"]|['"]$/g, "") };
        currentSchedule.classes.push(currentClass);
        continue;
      }
      // start_time / end_time  (rel 4 或 6 或 8)
      if (currentClass && (rel === 4 || rel === 6 || rel === 8)) {
        const [k, ...v] = trimmed.split(":");
        const val = v.join(":").trim().replace(/^['"]|['"]$/g, "");
        if (k === "start_time") currentClass.start_time = val;
        if (k === "end_time") currentClass.end_time = val;
        continue;
      }
      // enable_day / weeks  (rel 2 或 4)
      if (currentSchedule && (rel === 2 || rel === 4)) {
        const [k, ...v] = trimmed.split(":");
        const val = v.join(":").trim().replace(/^['"]|['"]$/g, "");
        if (k === "enable_day") currentSchedule.enable_day = parseInt(val) || 0;
        if (k === "weeks") currentSchedule.weeks = val;
      }
    }
  }

  return result;
}

export default router;
