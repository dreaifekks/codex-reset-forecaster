const documentLanguage = typeof document === "undefined"
  ? "zh-CN"
  : document.documentElement.lang;

export const isEnglish = documentLanguage.toLowerCase().startsWith("en");
export const uiLocale = isEnglish ? "en-US" : "zh-CN";

export function tr(chinese, english) {
  return isEnglish ? english : chinese;
}
