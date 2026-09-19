import zhCN from "./messages/zh-CN";
import en from "./messages/en";
import ja from "./messages/ja";

export const LOCALES = ["zh-CN", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** Human-readable labels for the language menu. */
export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
  ja: "日本語",
};

/** Cookie that stores the user's explicit choice (written by the provider). */
export const LOCALE_COOKIE = "perk_locale";

export const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  en,
  ja,
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve the request locale: explicit cookie first, then the best Accept-Language
 * match (zh* → zh-CN, ja* → ja, en* → en), then the default.
 */
export function detectLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  if (acceptLanguage) {
    const tags = acceptLanguage
      .split(",")
      .map((part) => {
        const [tag, q] = part.trim().split(";");
        return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split("=")[1]) || 0 : 1 };
      })
      .sort((a, b) => b.q - a.q);
    for (const { tag } of tags) {
      if (tag.startsWith("zh")) return "zh-CN";
      if (tag.startsWith("ja")) return "ja";
      if (tag.startsWith("en")) return "en";
    }
  }
  return DEFAULT_LOCALE;
}
