"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useDeployment } from "@/lib/hooks";
import { useLaunchList, useStats } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import { Sparkle } from "@/components/art/Sparkle";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { Notice } from "@/components/ui/Notice";
import { LaunchCard } from "@/components/LaunchCard";
import { formatNumber } from "@/lib/format";
import { useT } from "@/i18n/provider";

const ENTRIES = [
  { n: "01", href: "/trade", title: "nav.trade", body: "home.door.trade", cta: "home.door.tradeCta", tone: "text-bone" },
  { n: "02", href: "/grant", title: "nav.grant", body: "home.door.grant", cta: "home.door.grantCta", tone: "text-amber" },
  { n: "03", href: "/launch", title: "nav.launch", body: "home.door.launch", cta: "home.door.launchCta", tone: "text-flare" },
] as const;

/** Stats show "—" until the first result, then the number with a 200ms fade. */
function FadeStat({ value }: { value: ReactNode }) {
  return (
    <span key={String(value)} className="fade-in inline-block">
      {value}
    </span>
  );
}

export default function HomePage() {
  const { deployment } = useDeployment();
  const { t, locale } = useT();
  // trending: the six most traded in the last 24 h; the full market lives on /trade
  const list = useLaunchList({ sort: "volume", limit: 6 });
  const stats = useStats();
  const items = useMemo(() => list.data?.launches ?? [], [list.data]);
  const apiDown = isApiUnreachable(list.error) || isApiUnreachable(stats.error);

  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("home.network.body")}
      </Notice>
    );
  }

  const ledger = [
    { n: "01", label: t("home.stats.launches"), value: stats.data?.launches, tone: "text-bone" },
    { n: "02", label: t("home.stats.graduated"), value: stats.data?.graduated, tone: "text-verdigris" },
    { n: "03", label: t("home.stats.grants"), value: stats.data?.activeGrants, tone: "text-amber" },
    { n: "04", label: t("home.stats.quotes"), value: stats.data?.quotes, tone: "text-flare" },
  ];

  return (
    <div>
      {/* hero: 7/5 editorial split, the second line of the slogan carries the brand lime */}
      <section className="grid gap-12 pb-16 pt-12 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-7">
          <p className="label-en mb-6 flex items-center gap-2">
            <Sparkle size={9} tone="flare" />
            {t("home.hero.kicker")}
          </p>
          <h1 className="hero-title font-display text-[44px] leading-[0.98] sm:text-[64px] lg:text-[76px]">
            {t("home.hero.line1")}
            <br />
            <span className="font-display-italic">{t("home.hero.line2")}</span>
          </h1>
          <p className="mt-7 max-w-lg text-[15px] leading-relaxed text-bone/70">{t("home.hero.sub")}</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/trade" className="btn-primary inline-flex items-center gap-2 px-6 py-3 text-sm">
              {t("home.cta.trade")}
            </Link>
            <Link href="/launch" className="btn-ghost inline-flex items-center gap-2 px-6 py-3 text-sm">
              {t("nav.launch")}
              <Sparkle size={9} tone="flare" />
            </Link>
          </div>
        </div>
        {/* ledger: four lines, numbered, hairline-separated, big tabular figures */}
        <div className="panel p-2 lg:col-span-5">
          {ledger.map((row) => (
            <div key={row.n} className="ledger-row flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-4">
                <span className="num text-[11px] text-bone/40">{row.n}</span>
                <span className="text-sm text-bone/70">{row.label}</span>
              </div>
              <span className={`font-display num text-3xl leading-none ${row.tone}`}>
                <FadeStat value={row.value === undefined ? "—" : formatNumber(row.value, locale)} />
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* three doors: what did you come here to do? */}
      <section className="grid gap-4 pb-14 md:grid-cols-3">
        {ENTRIES.map((e) => (
          <Link key={e.href} href={e.href} className="panel group flex flex-col p-6">
            <span className="num text-[11px] text-bone/40">{e.n}</span>
            <span className={`mt-3 font-display text-2xl leading-tight ${e.tone}`}>{t(e.title)}</span>
            <span className="mt-2 flex-1 text-sm leading-relaxed text-bone/60">{t(e.body)}</span>
            <span className="mt-5 text-sm text-bone/80 transition-colors duration-fast group-hover:text-flare">
              {t(e.cta)} →
            </span>
          </Link>
        ))}
      </section>

      {/* trending */}
      <section className="pt-2">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="label">{t("home.trending")}</h2>
          <Link href="/trade" className="text-sm text-bone/60 hover:text-bone">
            {t("home.trending.all")} →
          </Link>
        </div>
        {apiDown ? (
          <Notice tone="rose" title={t("home.api.downTitle")} className="mb-4">
            {t("home.api.downBody", { url: API_URL })}
          </Notice>
        ) : null}
        {list.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Panel key={i}>
                <Skeleton size={56} lines={3} />
              </Panel>
            ))}
          </div>
        ) : items.length === 0 && !apiDown ? (
          <Panel className="flex flex-col items-center py-14 text-center">
            <p className="text-sm text-bone/60">{t("home.empty.text")}</p>
            <Link href="/launch" className="btn-primary mt-6 inline-block px-5 py-2.5 text-sm">
              {t("home.empty.cta")}
            </Link>
          </Panel>
        ) : (
          <div className="fade-up-stagger grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <LaunchCard key={item.meme} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
