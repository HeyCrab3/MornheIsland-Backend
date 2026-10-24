/**
 * 看板（0.2.2）用的紧凑课表。
 *
 * 本来是给壁纸引擎里的看板页取「当前科目」用的，所以刻意做得很小：
 * 不返回 ClassIsland 那套完整档案，只返回「第几天、第几周、每节课的名称/时间/科目」，
 * 上课中/下节课的判定交给客户端，避免服务端时区问题（看板显示的是本机时间）。
 *
 * 复用 util/cw2_schedule 的转换（已被自测覆盖），再拍平成简单结构。
 */

import express from "express";
import { log } from "../../util/log";
import { findClass } from "../../util/ci_public";
import { loadClassBundle } from "../../util/cw2_central";
import { buildCw2Schedule } from "../../util/cw2_schedule";

const router = express.Router();

/** CW2 的 1=周一..7=周日 → JS 的 0=周日..6=周六 */
function toJsDayOfWeek(d: number): number {
  return d === 7 ? 0 : d;
}

router.get("/v1/ci/:classIdentity/board.json", async (req, res) => {
  try {
    const db = req.db;
    const cls = await findClass(db, req.params.classIdentity);
    if (!cls) return res.status(404).json({ code: 404, msg: "班级不存在" });

    const bundle = await loadClassBundle(db, cls);
    if (!bundle.classplan || !bundle.timelayout) {
      return res.status(409).json({ code: 409, msg: "该班级还没有关联课表或时间表" });
    }

    const { schedule, warnings } = buildCw2Schedule({
      classplanData: bundle.classplan.data,
      timelayoutData: bundle.timelayout.data,
      subjectsData: bundle.subjects?.data || {},
      metaId: String(bundle.classplan._id),
      startDate: cls.cw2StartDate || undefined,
    });

    const subjectById = new Map<string, any>(schedule.subjects.map((s) => [s.id, s]));
    const subjectByEntry = new Map<string, string>();
    for (const a of schedule.assignments) {
      if (a.subjectId) subjectByEntry.set(a.entryId, a.subjectId);
    }

    /*
     * 单双周用 weekDiv（0=每周，1=单周，2=双周）直接下发，而不是只给 weeks 数组。
     * weeks 是 [1]/[2] 这种**有限周次数组**，一旦学期往后走超出这个范围，
     * 客户端会把整天都过滤掉，表现就是"双周上课时看板说今天没有课"。
     * weekDiv 是无限期的奇偶规则，客户端拿真实周次算奇偶即可。
     */
    const plansRaw = bundle.classplan.data?.classPlans || bundle.classplan.data || {};
    const weekDivByCp = new Map<string, number>();
    for (const [cpId, cp] of Object.entries<any>(plansRaw)) {
      weekDivByCp.set(cpId, Number(cp?.TimeRule?.WeekCountDiv) || 0);
    }

    const days = schedule.days.map((day) => ({
      weekDays: (day.dayOfWeek || []).map(toJsDayOfWeek),
      weeks: day.weeks,
      weekDiv: weekDivByCp.get(day.id) ?? 0,
      entries: day.entries.map((e) => {
        const subjectId = subjectByEntry.get(e.id) || e.subjectId || null;
        const subject = subjectId ? subjectById.get(subjectId) : null;
        return {
          name: e.title || null,
          type: e.type,
          start: e.startTime,
          end: e.endTime,
          subject: subject?.name ?? null,
          teacher: subject?.teacher ?? null,
        };
      }),
    }));

    res.json({
      identity: cls.identity || "",
      className: cls.name || "",
      orgName: cls.orgName || "",
      weekCountDivTotal: schedule.meta?.maxWeekCycle ?? 2,
      days,
      warnings,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    log(`[ci/board] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "内部服务器错误" });
  }
});

export default router;
