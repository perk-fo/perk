import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { InviteBar } from "@/components/InviteBar";
import { PauseBanner } from "@/components/PauseBanner";
import { TxToasts } from "@/components/TxToasts";
import { SiteFooter } from "@/components/SiteFooter";
import { LOCALE_COOKIE, MESSAGES, detectLocale, type Locale } from "@/i18n/locales";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--font-display",
  display: "swap",
});
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

/**
 * Runs before first paint: a stored choice wins, otherwise the system preference. Without it the page painted in the
 * system theme and switched after hydration - a full-screen flash on every load for anyone who had picked the other
 * one. `data-theme-source` tells the theme menu whether to keep following the system.
 */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem("perk-theme");var u=s==="light"||s==="dark";var t=u?s:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");var r=document.documentElement;r.dataset.theme=t;r.dataset.themeSource=u?"user":"system";var p=localStorage.getItem("perk-palette");if(p==="moss"||p==="stone")r.dataset.palette=p;}catch(e){}})();`;

/** Cookie first, then Accept-Language best match, then zh-CN. */
async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return detectLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: "Perk",
    description: MESSAGES[locale]["meta.description"],
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale} className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers locale={locale}>
          <Header />
          <PauseBanner />
          <InviteBar />
          <TxToasts />
          <main className="mx-auto w-full max-w-page px-4 pb-24 pt-8 sm:px-6">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
