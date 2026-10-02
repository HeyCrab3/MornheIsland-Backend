/**
 * .cipx 解析工具。
 *
 * .cipx 本质是内含 manifest.yml 的 zip。客户端上报的插件身份是 manifest 里的 `id`
 * （如 mornheisland.ciplugin），而不是文件名或显示名，
 * 所以对账（期望状态 vs 实际已装）必须用解析出来的 id 来比对。
 */
import AdmZip from "adm-zip";

export interface CipxManifest {
  id: string;
  name: string;
  version: string;
}

const EMPTY: CipxManifest = { id: "", name: "", version: "" };

/** 从 manifest.yml 文本里取顶层字段（顶层键不缩进，避免匹配到嵌套键） */
function pick(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}:[ \\t]*["']?([^"'\\r\\n#]+)["']?[ \\t]*$`, "im"));
  return m ? m[1].trim() : "";
}

/** 解析 .cipx 的 manifest；失败时返回空字段而不是抛错，不阻塞上传 */
export function readCipxManifest(buf: Buffer): CipxManifest {
  try {
    const zip = new AdmZip(buf);
    const entry =
      zip.getEntry("manifest.yml") ||
      zip.getEntry("manifest.yaml") ||
      zip.getEntries().find((e) => /(^|\/)manifest\.ya?ml$/i.test(e.entryName));
    if (!entry) return { ...EMPTY };

    const text = zip.readAsText(entry);
    return { id: pick(text, "id"), name: pick(text, "name"), version: pick(text, "version") };
  } catch {
    return { ...EMPTY };
  }
}
