/**
 * ClassIsland 资源 → Class Widgets 2（CW2）课表 v1 转换。
 *
 * 目标结构来自 IsHPDuwu/Class-Widgets-2-Central-Control 的 contracts 与
 * `server/app/schemas.py` 里的 SchedulePayload：
 *
 *   { meta: { id, version: 1, maxWeekCycle, startDate },
 *     subjects: [{ id, name, simplifiedName?, teacher?, isLocalClassroom }],
 *     days: [{ id, dayOfWeek: number[1-7], weeks, entries: [{ id, type, startTime, endTime, subjectId?, title? }] }],
 *     overrides: [],
 *     timelineIds: string[],
 *     assignments: [{ id, timelineId, entryId, dayOfWeek, weeks, subjectId? }] }
 *
 * 几个容易踩的点（都来自参考实现的校验器，不是猜的）：
 *   · TimeText 只接受 `HH:MM`（没有秒），且 endTime 必须严格晚于 startTime
 *   · entry id 要在**所有 day 之间**全局唯一
 *   · 没有 title、没有 subjectId、又没被 override 指定科目的 entry 会被塞一个随机 title，
 *     所以课次条目我们统一给 title=null、由 assignments 决定科目
 *   · dayOfWeek 是 1=周一..7=周日，而 ClassIsland 的 WeekDay 是 0=周日..6=周六
 */

export interface Cw2Entry {
  id: string;
  type: "class" | "break" | "activity" | "free" | "preparation";
  startTime: string;
  endTime: string;
  subjectId: string | null;
  title: string | null;
}

export interface Cw2Subject {
  id: string;
  name: string;
  simplifiedName: string | null;
  teacher: string | null;
  isLocalClassroom: boolean;
}

export interface Cw2Day {
  id: string;
  dayOfWeek: number[];
  weeks: "all" | number | number[];
  entries: Cw2Entry[];
}

export interface Cw2Assignment {
  id: string;
  timelineId: string;
  entryId: string;
  dayOfWeek: number[];
  weeks: "all" | number | number[];
  subjectId: string;
}

export interface Cw2Schedule {
  meta: { id: string; version: 1; maxWeekCycle: number; startDate: string };
  subjects: Cw2Subject[];
  days: Cw2Day[];
  overrides: never[];
  timelineIds: string[];
  assignments: Cw2Assignment[];
}

/** CW2 的 TimeText 只收 `HH:MM`；ClassIsland 里常见 `H:MM` 与 `HH:MM:SS` */
export function toHhMm(value: any): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** ClassIsland: 0=周日..6=周六 → CW2: 1=周一..7=周日 */
export function toCw2DayOfWeek(ciWeekDay: any): number {
  const d = Number(ciWeekDay);
  if (!Number.isFinite(d)) return 1;
  return d === 0 ? 7 : d;
}

/**
 * ClassIsland 的 WeekCountDiv：0=每周，1=单周，2=双周。
 * CW2 的 weeks 支持 "all" | 周次数字 | 周次数组；单双周我们用显式周次数组，
 * 避免猜 `int` 在那边是"周期"还是"第几周"。
 */
export function toCw2Weeks(weekCountDiv: any, weekCountDivTotal: any): "all" | number[] {
  const div = Number(weekCountDiv);
  const total = Math.min(Math.max(Number(weekCountDivTotal) || 2, 1), 52);
  if (div === 1 || div === 2) {
    const out: number[] = [];
    for (let w = div; w <= total; w += 2) out.push(w);
    return out.length ? out : "all";
  }
  return "all";
}

/** ClassIsland 的 TimeType → CW2 的 EntryType */
function toCw2EntryType(timeType: any): Cw2Entry["type"] {
  switch (Number(timeType)) {
    case 1:
      return "break";
    case 2:
      return "activity";
    case 3:
      return "free";
    case 4:
      return "preparation";
    default:
      return "class";
  }
}

function todayInCst(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function normalizeClassPlans(data: any): Record<string, any> {
  if (!data) return {};
  // 有两种历史形态：{ classPlans: {...}, timelayoutId, subjectsId } 或直接 { uuid: ClassPlan }
  if (data.classPlans && typeof data.classPlans === "object") return data.classPlans;
  return data;
}

export interface BuildResult {
  schedule: Cw2Schedule;
  warnings: string[];
}

/**
 * 把「课表 + 时间表 + 科目」三份 ClassIsland 资源合成一份 CW2 课表 v1。
 * 三份资源都可以缺，缺的部分输出空列表，调用方负责判断是否可用。
 */
export function buildCw2Schedule(input: {
  classplanData: any;
  timelayoutData: any;
  subjectsData: any;
  metaId?: string;
  startDate?: string;
}): BuildResult {
  const warnings: string[] = [];
  const classPlans = normalizeClassPlans(input.classplanData);
  const timeLayouts = input.timelayoutData && typeof input.timelayoutData === "object" ? input.timelayoutData : {};
  const subjectsRaw = input.subjectsData && typeof input.subjectsData === "object" ? input.subjectsData : {};

  // ── 科目 ──
  const subjects: Cw2Subject[] = [];
  for (const [uuid, s] of Object.entries<any>(subjectsRaw)) {
    if (!s) continue;
    subjects.push({
      id: String(uuid),
      name: String(s.Name ?? s.name ?? "").trim() || String(uuid),
      simplifiedName: (s.Initial ?? s.simplifiedName ?? null) || null,
      teacher: (s.TeacherName ?? s.teacher ?? null) || null,
      isLocalClassroom: true,
    });
  }
  const knownSubjectIds = new Set(subjects.map((s) => s.id));

  // ── 逐个课表（每个 = 某星期 + 单双周）→ 一个 day + 若干 assignment ──
  const days: Cw2Day[] = [];
  const assignments: Cw2Assignment[] = [];
  const timelineIds = new Set<string>();
  let maxWeekCycle = 1;

  for (const [cpUuid, cpRaw] of Object.entries<any>(classPlans)) {
    const cp = cpRaw || {};
    const tlId = String(cp.TimeLayoutId ?? cp.timelayoutId ?? "");
    // 只有在课表**没有**引用时间表时才回退到唯一那份；引用了但找不到必须报错跳过，
    // 否则会拿另一份时间表的结构硬套，课表静默错位。
    const tl = tlId ? timeLayouts[tlId] : (Object.values<any>(timeLayouts)[0] as any);
    if (!tl) {
      warnings.push(`课表 ${cp.Name || cpUuid} 找不到对应时间表（TimeLayoutId=${tlId || "空"}），已跳过`);
      continue;
    }
    timelineIds.add(tlId);

    const layouts: any[] = Array.isArray(tl.Layouts) ? tl.Layouts : [];
    const classes: any[] = Array.isArray(cp.Classes) ? cp.Classes : [];

    const timeRule = cp.TimeRule || {};
    const dayOfWeek = [toCw2DayOfWeek(timeRule.WeekDay)];
    const weeks = toCw2Weeks(timeRule.WeekCountDiv, timeRule.WeekCountDivTotal);
    // WeekCountDivTotal 在老数据里可能是 undefined（早期 CSES 导入没写这一项），
    // 兜 2 而不是 1——兜成 1 会让单/双周退化成只有一周，学期往后就全被过滤掉。
    maxWeekCycle = Math.max(maxWeekCycle, Number(timeRule.WeekCountDivTotal) || 2);

    // entry 结构与科目是两条线：entries 只描述时间，科目交给 assignments。
    const entries: Cw2Entry[] = [];
    // 记录「第几个课时条目」对应到哪个 ClassPlan.Classes 下标
    const classSlotToClassesIndex: number[] = [];
    for (let i = 0; i < layouts.length; i++) {
      const l = layouts[i] || {};
      const type = toCw2EntryType(l.TimeType);
      const startTime = toHhMm(l.StartTime);
      const endTime = toHhMm(l.EndTime);
      if (!startTime || !endTime || endTime <= startTime) {
        warnings.push(`课表 ${cp.Name || cpUuid} 的第 ${i + 1} 段起止时间非法（${l.StartTime}~${l.EndTime}），已跳过该段`);
        continue;
      }
      const isClassSlot = type === "class";
      // 前 12 个课时的序号（时间表里 TimePointName 可能为空，兜底用）
      const slotOrdinal = classSlotToClassesIndex.length + 1;
      entries.push({
        id: `${cpUuid}-${i}`,
        type,
        startTime,
        endTime,
        subjectId: null,
        /*
         * 课次条目也带节次名：CW2 校验器只给「既无 title 又无科目」的条目塞随机标题，
         * 而看板要靠它显示「第N节」——否则没排到科目的时段只能显示成笼统的"上课"。
         * 时间表里 TimePointName 常为空，这时用序号兜底。
         */
        title:
          l.BreakName ||
          l.TimePointName ||
          (isClassSlot ? `第${slotOrdinal}节` : type === "break" ? "课间" : null),
      });
      if (isClassSlot) classSlotToClassesIndex.push(i);
    }

    /*
     * ClassPlan.Classes 的下标对齐有两种现实形态：
     *   a) 与 Layouts 一一对应（ClassIsland 原生语义，课间槽位 SubjectId 为 null）
     *   b) 只包含课时槽位（本项目 import_ces 生成的形态）
     * 两者靠长度区分，别硬按同一个下标去取，否则有午休/课间的课表会整条错位。
     */
    const directAlign = classes.length === layouts.length;
    const slotAlign = !directAlign && classes.length === classSlotToClassesIndex.length;
    if (!directAlign && !slotAlign && classes.length) {
      warnings.push(
        `课表 ${cp.Name || cpUuid} 的 Classes 数（${classes.length}）既不等于时间段数（${layouts.length}）也不等于课时数（${classSlotToClassesIndex.length}），按课时顺序尽量对齐`,
      );
    }

    for (let k = 0; k < classSlotToClassesIndex.length; k++) {
      const layoutIndex = classSlotToClassesIndex[k];
      let cls: any = undefined;
      if (directAlign) cls = classes[layoutIndex];
      else if (slotAlign) cls = classes[k];
      else cls = classes[k] ?? classes[layoutIndex];

      const subjectId = cls?.SubjectId ?? cls?.subjectId ?? null;
      if (!subjectId) continue;
      if (!knownSubjectIds.has(String(subjectId))) {
        warnings.push(`课表 ${cp.Name || cpUuid} 第 ${k + 1} 个课时引用了不存在的科目 ${subjectId}，已跳过`);
        continue;
      }
      assignments.push({
        id: `${cpUuid}-${k}`,
        timelineId: cpUuid,
        entryId: `${cpUuid}-${layoutIndex}`,
        dayOfWeek,
        weeks,
        subjectId: String(subjectId),
      });
    }

    days.push({ id: cpUuid, dayOfWeek, weeks, entries });
  }

  const schedule: Cw2Schedule = {
    meta: {
      id: input.metaId || "mornheisland",
      version: 1,
      maxWeekCycle: Math.min(Math.max(maxWeekCycle, 1), 52),
      startDate: input.startDate || todayInCst(),
    },
    subjects,
    days,
    overrides: [],
    timelineIds: [...timelineIds],
    assignments,
  };

  if (!days.length) warnings.push("转换结果为 0 天课表，可能是课表/时间表未关联或数据为空");
  return { schedule, warnings };
}

/**
 * 自查：在服务端本地按参考实现的校验规则过一遍，避免把不合法的 payload 推给设备
 * （设备端 pydantic 会直接 422）。返回错误列表，空数组表示通过。
 */
export function validateCw2Schedule(s: any): string[] {
  const errs: string[] = [];
  const timeRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  if (!s || typeof s !== "object") return ["schedule 不是对象"];
  const meta = s.meta;
  if (!meta || typeof meta !== "object") errs.push("缺少 meta");
  else {
    if (!meta.id) errs.push("meta.id 为空");
    if (meta.version !== 1) errs.push("meta.version 必须为 1");
    if (!Number.isInteger(meta.maxWeekCycle) || meta.maxWeekCycle < 1 || meta.maxWeekCycle > 52)
      errs.push("meta.maxWeekCycle 必须在 1..52");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.startDate))) errs.push("meta.startDate 必须是 YYYY-MM-DD");
  }

  const subjects: any[] = Array.isArray(s.subjects) ? s.subjects : [];
  const subjectIds = subjects.map((x) => x?.id);
  if (new Set(subjectIds).size !== subjectIds.length) errs.push("subject id 有重复");
  for (const sub of subjects) if (!sub?.id || !sub?.name) errs.push("subject 缺少 id 或 name");

  const knownSubjects = new Set(subjectIds);
  const days: any[] = Array.isArray(s.days) ? s.days : [];
  const allEntryIds: string[] = [];
  for (const d of days) {
    if (!d?.id) errs.push("day 缺少 id");
    for (const dow of d?.dayOfWeek ?? []) {
      if (!Number.isInteger(dow) || dow < 1 || dow > 7) errs.push(`day ${d?.id} 的 dayOfWeek 越界: ${dow}`);
    }
    for (const e of d?.entries ?? []) {
      allEntryIds.push(e?.id);
      if (!e?.id) errs.push(`day ${d?.id} 有 entry 缺少 id`);
      if (!timeRe.test(String(e?.startTime))) errs.push(`entry ${e?.id} startTime 非法: ${e?.startTime}`);
      if (!timeRe.test(String(e?.endTime))) errs.push(`entry ${e?.id} endTime 非法: ${e?.endTime}`);
      if (e?.startTime && e?.endTime && String(e.endTime) <= String(e.startTime))
        errs.push(`entry ${e?.id} endTime 不晚于 startTime`);
      if (!["class", "break", "activity", "free", "preparation"].includes(String(e?.type)))
        errs.push(`entry ${e?.id} type 非法: ${e?.type}`);
      if (e?.subjectId != null && !knownSubjects.has(e.subjectId))
        errs.push(`entry ${e?.id} 引用了不存在的 subjectId ${e?.subjectId}`);
    }
  }
  if (new Set(allEntryIds).size !== allEntryIds.length) errs.push("entry id 在所有 day 之间有重复");

  const knownEntries = new Set(allEntryIds);
  const overrides: any[] = Array.isArray(s.overrides) ? s.overrides : [];
  for (const o of overrides) {
    if (!knownEntries.has(o?.entryId)) errs.push(`override 引用了不存在的 entryId ${o?.entryId}`);
    if (o?.subjectId != null && !knownSubjects.has(o.subjectId)) errs.push(`override 引用了不存在的 subjectId`);
  }

  const tlIds: string[] = Array.isArray(s.timelineIds) ? s.timelineIds : [];
  if (new Set(tlIds).size !== tlIds.length) errs.push("timelineIds 有重复");

  const assignments: any[] = Array.isArray(s.assignments) ? s.assignments : [];
  for (const a of assignments) {
    if (!a?.id || !a?.timelineId || !a?.entryId) errs.push("assignment 缺少 id/timelineId/entryId");
    if (a?.subjectId != null && !knownSubjects.has(a.subjectId))
      errs.push(`assignment 引用了不存在的 subjectId ${a?.subjectId}`);
    for (const dow of a?.dayOfWeek ?? []) {
      if (!Number.isInteger(dow) || dow < 1 || dow > 7) errs.push(`assignment ${a?.id} 的 dayOfWeek 越界: ${dow}`);
    }
  }

  return errs;
}

/** CW2 策略 payload 的键名校验（对应参考实现里 PolicyPayload.validate_keys） */
export function validateCw2Policy(p: any): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["policy 不是对象"];
  const overrides = p.overrides ?? {};
  const locked = p.locked_keys ?? [];
  if (typeof overrides !== "object" || Array.isArray(overrides)) errs.push("overrides 必须是对象");
  if (!Array.isArray(locked)) errs.push("locked_keys 必须是数组");
  for (const key of [...Object.keys(overrides || {}), ...(Array.isArray(locked) ? locked : [])]) {
    const ok =
      typeof key === "string" &&
      key.length > 0 &&
      key.length <= 240 &&
      key.split(".").every((part: string) => part.length > 0 && /^[A-Za-z0-9_]+$/.test(part));
    if (!ok) errs.push(`非法策略键: ${key}`);
  }
  if (typeof p.schedule_readonly !== "boolean") errs.push("schedule_readonly 必须是布尔值");
  return errs;
}
