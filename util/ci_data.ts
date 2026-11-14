/**
 * ClassIsland 数据的 Guid 规范化。
 *
 * 背景（真实事故）：
 *   `ClassInfo.SubjectId` 是非空 `Guid`，并且标了
 *   `[JsonConverter(typeof(GuidEmptyFallbackConverter))]`。而那个转换器的实现是：
 *
 *       var str = reader.GetString();
 *       return string.IsNullOrWhiteSpace(str) ? Guid.Empty : Guid.Parse(str);
 *
 *   —— 它只容忍 `""` / 空白，**遇到 `null` 会在 `GetString()` 直接抛异常**。
 *   于是 JSON 里出现 `"SubjectId": null` 时，客户端反序列化**整个档案**失败，
 *   表现为课表直接爆炸。`TimeLayoutId`、`AssociatedGroup` 同理（都是非空 Guid）。
 *
 *   线上实测：95 份课表资源里有 28 份含这个问题，共 939 处。
 *
 * 所以：凡是 Guid 类型的字段，**永远不要写 null**，空值一律写 `Guid.Empty`
 * 也就是 "00000000-0000-0000-0000-000000000000"。
 *
 * 这里既给「新建/保存」做兜底（老版本前端已经发出去的请求也能救），
 * 也给存量数据做修复。
 */

export const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

function isBlankGuid(v: any): boolean {
  return v === null || v === "" || (typeof v === "string" && v.trim() === "");
}

/** 空的 ClassInfo（当 Classes 数组里出现 null 元素时用来替换） */
function emptyClassInfo() {
  return {
    SubjectId: EMPTY_GUID,
    IsChangedClass: false,
    IsEnabled: false,
    AttachedObjects: {},
    IsActive: false,
  };
}

export interface NormalizeResult {
  /** 修掉的处数 */
  fixed: number;
  /** 修完后残留的问题（正常应为 0） */
  remaining: number;
}

/**
 * 规范化一份课表资源（`ci_classplans.data`）。
 * 就地修改传入对象，并返回修了多少处。
 */
export function normalizeClassPlanData(data: any): NormalizeResult {
  let fixed = 0;
  if (!data || typeof data !== "object") return { fixed, remaining: 0 };

  const plans = data.classPlans && typeof data.classPlans === "object" ? data.classPlans : {};
  for (const cp of Object.values<any>(plans)) {
    if (!cp || typeof cp !== "object") continue;

    // ClassPlan 上的非空 Guid
    for (const key of ["TimeLayoutId", "AssociatedGroup"] as const) {
      if (isBlankGuid(cp[key])) {
        // AssociatedGroup 的"默认组"就是 Guid.Empty；TimeLayoutId 空值也归零
        cp[key] = EMPTY_GUID;
        fixed++;
      }
    }

    if (!Array.isArray(cp.Classes)) continue;
    for (let i = 0; i < cp.Classes.length; i++) {
      const c = cp.Classes[i];
      if (c === null || c === undefined) {
        // 数组元素本身为 null 也会让客户端构建 ClassInfo 列表失败
        cp.Classes[i] = emptyClassInfo();
        fixed++;
        continue;
      }
      if (typeof c !== "object") {
        cp.Classes[i] = emptyClassInfo();
        fixed++;
        continue;
      }
      if (isBlankGuid(c.SubjectId)) {
        c.SubjectId = EMPTY_GUID;
        fixed++;
      }
      if (c.AttachedObjects === null || c.AttachedObjects === undefined) {
        c.AttachedObjects = {};
      }
    }
  }

  return { fixed, remaining: countNullGuids(data) };
}

/**
 * 规范化一份时间表资源（`ci_timelayouts.data`）。
 * `TimeLayoutItem.DefaultClassId` 也是非空 Guid。
 */
export function normalizeTimeLayoutData(data: any): NormalizeResult {
  let fixed = 0;
  if (!data || typeof data !== "object") return { fixed, remaining: 0 };

  for (const layout of Object.values<any>(data)) {
    if (!layout || typeof layout !== "object") continue;
    if (!Array.isArray(layout.Layouts)) continue;
    for (let i = 0; i < layout.Layouts.length; i++) {
      const l = layout.Layouts[i];
      if (l === null || l === undefined || typeof l !== "object") {
        layout.Layouts[i] = {
          StartSecond: "",
          EndSecond: "",
          StartTime: "",
          EndTime: "",
          TimeType: 1,
          IsHideDefault: false,
          DefaultClassId: EMPTY_GUID,
          BreakName: "",
          ActionSet: null,
          AttachedObjects: {},
          IsActive: false,
        };
        fixed++;
        continue;
      }
      if (isBlankGuid(l.DefaultClassId)) {
        l.DefaultClassId = EMPTY_GUID;
        fixed++;
      }
      if (l.AttachedObjects === null || l.AttachedObjects === undefined) {
        l.AttachedObjects = {};
      }
    }
  }

  return { fixed, remaining: countNullGuids(data) };
}

/** 只统计、不修改：数出会让客户端炸的 null/空 Guid 有几处 */
export function countNullGuids(data: any): number {
  let n = 0;
  if (!data || typeof data !== "object") return 0;

  const plans = data.classPlans && typeof data.classPlans === "object" ? data.classPlans : {};
  for (const cp of Object.values<any>(plans)) {
    if (!cp || typeof cp !== "object") continue;
    if (cp.TimeLayoutId === null) n++;
    if (cp.AssociatedGroup === null) n++;
    if (Array.isArray(cp.Classes)) {
      for (const c of cp.Classes) {
        if (c === null || c === undefined) n++;
        else if (c.SubjectId === null) n++;
      }
    }
  }

  // 时间表形态（也支持传进来直接是 {uuid: {Layouts}} ）
  for (const layout of Object.values<any>(data)) {
    if (!layout || typeof layout !== "object") continue;
    if (!Array.isArray(layout.Layouts)) continue;
    for (const l of layout.Layouts) {
      if (l === null || l === undefined) n++;
      else if (l.DefaultClassId === null) n++;
    }
  }

  return n;
}
