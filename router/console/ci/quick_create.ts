import express from "express";
import { ObjectId } from "mongodb";
import { log } from "../../../util/log.ts";
import { getOcrResult } from "../../../util/ocr_service.ts";
import { chat } from "../../../util/llm.ts";

const router = express.Router();

const TIMELAYOUT_PROMPT = `你是一个学校作息时间表解析器。请从以下 OCR 识别的文本中提取作息时间信息，严格按照下面的 JSON 格式输出（只输出 JSON，不要其他内容）：

{
  "type": "timelayout",
  "periods": [
    { "name": "早读", "start": "07:30:00", "end": "08:00:00" },
    { "name": "第一节", "start": "08:00:00", "end": "08:45:00" }
  ]
}

规则：
- name 为时段名称（如"早读""第一节""课间操"等）
- start/end 格式为 HH:mm:ss
- 按时间顺序排列
- 如果 OCR 结果只有开始时间没有结束时间，请根据常识推算（通常一节课40-45分钟）
- 以下类型的时段不属于正式课程，不要输出到 periods 中（直接丢弃）：
  * 早餐、午餐、晚餐、吃饭等（属于用餐时间）
  * 眼保健操、跑操、课间操等（属于课间活动，不是课程）
  * 午休、午睡等（属于休息时间）
  * 放学、离校等
- 如果识别不到具体时段信息，返回 { "type": "timelayout", "periods": [] }`;

const CLASSPLAN_PROMPT = `你是一个学校课程表解析器。请从以下 OCR 识别的文本中提取课程表信息，严格按照下面的 JSON 格式输出（只输出 JSON，不要其他内容）：

{
  "type": "classplan",
  "days": ["周一", "周二", "周三", "周四", "周五"],
  "schedule": {
    "周一": [
      { "periodIndex": 0, "subject": "语文" },
      { "periodIndex": 1, "subject": "数学" }
    ]
  },
  "subjects": ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "音乐", "体育", "美术", "信息技术"]
}

规则：
- days 列出识别到的上课日
- schedule 中每个 day 对应一个数组，periodIndex 从 0 开始递增
- subject 取标准科目名称（如"语文""数学""英语"等），不要用缩写
- subjects 列出所有出现的科目（去重）
- 如果识别不到具体课程信息，返回 { "type": "classplan", "days": [], "schedule": {}, "subjects": [] }`;

router.post("/v1/console/ci/quick-create", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ code: 401, msg: "请先登录" });
    const imageBase64: string = req.body?.imageBase64;
    const resourceType: string = req.body?.resourceType;
    if (!imageBase64) return res.status(400).json({ code: 400, msg: "缺少图片" });
    if (!["timelayout", "classplan"].includes(resourceType)) {
      return res.status(400).json({ code: 400, msg: "resourceType 必须为 timelayout 或 classplan" });
    }

    // Step 1: OCR
    log(`[quick-create] 用户 ${userId} 开始 OCR 识别`, "info", "auth");
    const ocrResult = await getOcrResult(imageBase64);
    const ocrText = ocrResult?.TextDetections?.map((d: any) => d.DetectedText).join("\n") || "";
    // 每个文字块的内容 + 四顶点坐标（用于前端在原图上绘制标注框）
    const ocrBlocks = (ocrResult?.TextDetections || []).map((d: any) => ({
      text: d.DetectedText,
      polygon: d.Polygon || [],
    }));

    if (!ocrText.trim()) {
      return res.status(422).json({ code: 422, msg: "图片中未识别到文字，请检查图片清晰度" });
    }

    // Step 2: LLM 结构化
    log(`[quick-create] OCR 完成，调用 LLM 解析 (type=${resourceType})`, "info", "auth");
    const prompt = resourceType === "timelayout" ? TIMELAYOUT_PROMPT : CLASSPLAN_PROMPT;
    const llmResponse = await chat([
      // @ts-expect-error
      { role: "system", content: prompt },
      // @ts-expect-error
      { role: "user", content: `OCR 识别结果：\n${ocrText}` },
    ]);

    // 提取 JSON
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ code: 422, msg: "AI 解析失败，请重试或手动创建", rawText: ocrText });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(422).json({ code: 422, msg: "AI 返回格式异常，请重试", rawText: ocrText, rawLLM: llmResponse });
    }

    // Step 3: 转换为 ClassIsland 格式
    const db = req.db;
    const uid = new ObjectId(userId);

    if (resourceType === "timelayout") {
      const tlUuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
      // 生成 Layouts（上课段 + 自动插入课间）
      const layouts: any[] = [];
      const sorted = (parsed.periods || []).sort((a: any, b: any) => (a.start || "").localeCompare(b.start || ""));
      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const prevEnd = i > 0 ? sorted[i - 1].end : "";
        if (prevEnd && p.start && prevEnd !== p.start) {
          layouts.push({ StartSecond: "", EndSecond: "", StartTime: prevEnd, EndTime: p.start, TimeType: 1, IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000", BreakName: "", ActionSet: null, AttachedObjects: {}, IsActive: false });
        }
        layouts.push({ StartSecond: "", EndSecond: "", StartTime: p.start || "00:00:00", EndTime: p.end || "00:00:00", TimeType: 0, TimePointName: p.name || "", IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000", BreakName: "", ActionSet: null, AttachedObjects: {}, IsActive: false });
      }
      parsed.data = { [tlUuid]: { Name: "", Layouts: layouts } };
    }

    if (resourceType === "classplan") {
      const classPlans: Record<string, any> = {};
      const days = parsed.days || [];
      const schedule = parsed.schedule || {};
      const tlUuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

      for (const day of days) {
        const slots = schedule[day] || [];
        const cpUuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
        classPlans[cpUuid] = {
          TimeLayoutId: tlUuid,
          TimeRule: {
            WeekDay: { "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 0 }[day] ?? 0,
            WeekCountDiv: 0,
            WeekCountDivTotal: 2,
            IsActive: false,
          },
          Classes: slots.map((s: any) => s?.subject
            ? { SubjectId: s.subject, IsChangedClass: false, IsEnabled: true, AttachedObjects: {}, IsActive: false }
            : { SubjectId: null, IsChangedClass: false, IsEnabled: false, AttachedObjects: {}, IsActive: false }
          ),
          Name: day,
          IsOverlay: false,
          OverlaySourceId: null,
          OverlaySetupTime: new Date().toISOString(),
          IsEnabled: true,
          AssociatedGroup: "00000000-0000-0000-0000-000000000000",
          AttachedObjects: {},
          IsActive: false,
        };
      }
      parsed.data = { classPlans };
    }

    res.json({ code: 0, data: { ...parsed, ocrText, ocrBlocks, resourceType } });
  } catch (e: any) {
    log(`[quick-create] ${e}`, "error");
    res.status(500).json({ code: 500, msg: "处理失败: " + (e.message || e) });
  }
});

export default router;
