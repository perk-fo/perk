import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { Figtree, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { InviteBar } from "@/components/InviteBar";
import { PauseBanner } from "@/components/PauseBanner";
import { TxToasts } from "@/components/TxToasts";
import { SiteFooter } from "@/components/SiteFooter";
import { LOCALE_COOKIE, MESSAGES, detectLocale, type Locale } from "@/i18n/locales";
import "./globals.css";

// One friendly geometric family for headings and text (heavy weights for headings), monospace for identifiers.
const sans = Figtree({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

/**
 * Runs before first paint, so the page never flashes the other theme: a stored "light" or "dark" wins, "system"
 * follows the OS, and a first visit gets the light theme the brand was designed in. `data-theme-source` tells the
 * theme menu whether to keep following the system.
 */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem("perk-theme");var r=document.documentElement;var t=s==="dark"||s==="light"?s:s==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):"light";r.dataset.theme=t;r.dataset.themeSource=s==="system"?"system":"user";}catch(e){document.documentElement.dataset.theme="light";}})();`;

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
    <html lang={locale} data-theme="light" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers locale={locale}>
          <Header />
          <PauseBanner />
          <InviteBar />
          <TxToasts />
          <main className="mx-auto w-full max-w-page px-4 pb-24 pt-6 sm:px-8">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
