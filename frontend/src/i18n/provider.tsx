"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, MESSAGES, isLocale, type Locale } from "./locales";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  t: TFn;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** ICU-lite: replace {name} placeholders with vars, leaving unknown placeholders untouched. */
function interpolate(message: string, vars?: Record<string, string | number>): string {
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : raw,
  );
}

/**
 * Client locale state. The server passes the cookie/header-resolved locale so the first
 * paint is already correct; setLocale persists the choice to the perk_locale cookie,
 * updates <html lang> and re-renders without a server round-trip.
 */
export function I18nProvider({ locale: initial, children }: { locale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(isLocale(initial) ? initial : DEFAULT_LOCALE);

  const setLocale = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; max-age=31536000; path=/`;
    document.documentElement.lang = next;
    setLocaleState(next);
  }, []);

  const t = useCallback<TFn>(
    (key, vars) => {
      const message = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
      return interpolate(message, vars);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Current locale, translator and setter. Must be used under I18nProvider. */
export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used inside I18nProvider");
  return ctx;
}
