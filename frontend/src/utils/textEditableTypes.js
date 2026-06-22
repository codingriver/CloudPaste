import { api } from "@/api";
import { getExtension } from "@/utils/fileTypes.js";
import { createLogger } from "@/utils/logger.js";

export const DEFAULT_TEXT_EDITABLE_TYPES = "txt,md,json,yaml,yml,js,ts,css,html,htm,sh,bat,log,xml,ini,conf,properties,sql,vue,py,go,c,cpp,h,hpp,tsx,rs,gitignore";

const log = createLogger("TextEditableTypes");
let cachedEditableTypes = null;
let loadingPromise = null;

export function parseExtensionList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return Array.from(
    new Set(
      list
        .map((item) => String(item).trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
    ),
  );
}

export function isFilenameTextEditable(filename, editableTypes) {
  const name = String(filename || "").split(/[\\/]/).pop().toLowerCase();
  const ext = getExtension(filename || "");
  if (!name && !ext) return false;
  const allowed = parseExtensionList(editableTypes);
  return (ext && allowed.includes(ext)) || allowed.includes(name.replace(/^\./, ""));
}

export async function loadTextEditableTypes({ force = false } = {}) {
  if (!force && cachedEditableTypes) {
    return cachedEditableTypes;
  }

  if (!force && loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = api.system
    .getSettingsByGroup(2, false)
    .then((response) => {
      const settings = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
      const setting = settings.find((item) => item?.key === "preview_text_editable_exts");
      cachedEditableTypes = setting?.value || DEFAULT_TEXT_EDITABLE_TYPES;
      return cachedEditableTypes;
    })
    .catch((error) => {
      log.warn("加载文本可编辑后缀设置失败，使用默认值:", error);
      cachedEditableTypes = DEFAULT_TEXT_EDITABLE_TYPES;
      return cachedEditableTypes;
    })
    .finally(() => {
      loadingPromise = null;
    });

  return loadingPromise;
}

export function clearTextEditableTypesCache() {
  cachedEditableTypes = null;
}
