import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { InviteBar } from "@/components/InviteBar";
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
      <body>
        <Providers locale={locale}>
          <Header />
          <InviteBar />
          <TxToasts />
          <main className="mx-auto w-full max-w-page px-4 pb-24 pt-8 sm:px-6">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
