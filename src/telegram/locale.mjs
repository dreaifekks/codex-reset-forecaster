export const DEFAULT_TELEGRAM_LOCALE = "zh-CN";
export const TELEGRAM_LOCALES = Object.freeze(["zh-CN", "en"]);

export function normalizeTelegramLocale(
  value = DEFAULT_TELEGRAM_LOCALE,
  name = "TELEGRAM_BOT_LOCALE",
) {
  const raw = String(value ?? DEFAULT_TELEGRAM_LOCALE).trim() ||
    DEFAULT_TELEGRAM_LOCALE;
  const locale = raw.replaceAll("_", "-").toLowerCase();
  if (["zh", "zh-cn", "zh-hans"].includes(locale)) return "zh-CN";
  if (locale === "en" || locale.startsWith("en-")) return "en";
  if (!TELEGRAM_LOCALES.includes(raw)) {
    throw new TypeError(`${name} must be one of: ${TELEGRAM_LOCALES.join(", ")}`);
  }
  return raw;
}

export function isEnglishTelegramLocale(locale) {
  return normalizeTelegramLocale(locale) === "en";
}

export function telegramText(locale, chinese, english) {
  return isEnglishTelegramLocale(locale) ? english : chinese;
}

export function telegramNumberLocale(locale) {
  return isEnglishTelegramLocale(locale) ? "en-US" : "zh-CN";
}

function menu(locale, chinese, english) {
  return telegramText(locale, chinese, english);
}

export function telegramCommandMenus(locale = DEFAULT_TELEGRAM_LOCALE) {
  const normalized = normalizeTelegramLocale(locale);
  const common = [
    {
      command: "start",
      description: menu(normalized, "开始并查看帮助", "Start and show help"),
    },
    {
      command: "forecast",
      description: menu(normalized, "查看未来 4 小时与 24 小时预测", "Show the next 4h and 24h forecast"),
    },
    {
      command: "report",
      description: menu(normalized, "查看详细预测报告", "Show the detailed forecast report"),
    },
    {
      command: "history",
      description: menu(normalized, "查看最近确认重置", "Show recent confirmed resets"),
    },
    {
      command: "lastreset",
      description: menu(normalized, "查看最近一次确认重置", "Show the latest confirmed reset"),
    },
  ];
  const closing = [
    {
      command: "about",
      description: menu(normalized, "关于 Bot 与数据边界", "About the bot and its data boundaries"),
    },
    {
      command: "help",
      description: menu(normalized, "查看全部命令", "Show all commands"),
    },
  ];
  return [
    {
      scope: { type: "all_private_chats" },
      commands: [
        ...common,
        {
          command: "subscribe",
          description: menu(normalized, "订阅稳定通知或设置概率提醒", "Subscribe to stable or probability alerts"),
        },
        {
          command: "subscription",
          description: menu(normalized, "查看当前订阅设置", "Show current subscription settings"),
        },
        {
          command: "unsubscribe",
          description: menu(normalized, "取消动态订阅", "Cancel the dynamic subscription"),
        },
        ...closing,
      ],
    },
    {
      scope: { type: "all_group_chats" },
      commands: [...common, ...closing],
    },
  ];
}

export function telegramPublicUrl(
  baseUrl,
  locale = DEFAULT_TELEGRAM_LOCALE,
  page = "home",
) {
  const base = new URL(baseUrl);
  const english = isEnglishTelegramLocale(locale);
  const pathname = page === "accuracy"
    ? english ? "/en/accuracy" : "/accuracy"
    : english ? "/en/" : "/";
  return new URL(pathname, base.origin).toString();
}
