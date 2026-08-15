import { isEnglish } from "./i18n.js?v=seo-i18n-1";

const STORAGE_KEY = "codex-reset-forecaster.locale";
const currentLocale = isEnglish ? "en" : "zh";

function storedLocale() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return ["en", "zh"].includes(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberLocale(locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Language switching still works when storage is unavailable.
  }
}

function browserLocale() {
  const language = navigator.languages?.[0] ?? navigator.language ?? "en";
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

for (const link of document.querySelectorAll("[data-locale-choice]")) {
  link.addEventListener("click", () => {
    rememberLocale(link.dataset.localeChoice);
  });
}

const suggestion = document.querySelector("#language-suggestion");
if (suggestion && !storedLocale() && browserLocale() !== currentLocale) {
  suggestion.hidden = false;
}

suggestion?.querySelector("[data-locale-dismiss]")?.addEventListener("click", () => {
  rememberLocale(currentLocale);
  suggestion.hidden = true;
});
