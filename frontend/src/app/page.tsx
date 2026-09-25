"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useDeployment } from "@/lib/hooks";
import { useFeatured, useLaunchList, useStats } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import { Blossom } from "@/components/art/Blossom";
import { LiquidityIcon, RocketIcon, SwapIcon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { LaunchCard, LaunchCardSkeleton } from "@/components/LaunchCard";
import { HeroScene } from "@/components/home/HeroScene";
import { CountUp } from "@/components/home/CountUp";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { useT } from "@/i18n/provider";

const PATHS = [
  { tag: "home.door.tradeTag", href: "/trade", title: "nav.trade", body: "home.door.trade", cta: "home.door.tradeCta", icon: SwapIcon, sun: false },
  { tag: "home.door.grantTag", href: "/grant", title: "nav.grant", body: "home.door.grant", cta: "home.door.grantCta", icon: LiquidityIcon, sun: false },
  { tag: "home.door.launchTag", href: "/launch", title: "nav.launch", body: "home.door.launch", cta: "home.door.launchCta", icon: RocketIcon, sun: true },
] as const;

export default function HomePage() {
  const { deployment } = useDeployment();
  const { t, locale } = useT();
  // trending: the six most traded in the last 24 h; the full market lives on /trade
  const list = useLaunchList({ sort: "volume", limit: 6 });
  const stats = useStats();
  const featured = useFeatured();
  const items = useMemo(() => list.data?.launches ?? [], [list.data]);
  const featuredItems = featured.data?.launches ?? [];
  const apiDown = isApiUnreachable(list.error) || isApiUnreachable(stats.error);

  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("home.network.body")}
      </Notice>
    );
  }

  const ledger = [
    { n: "01", label: t("home.stats.launches"), value: stats.data?.launches },
    { n: "02", label: t("home.stats.graduated"), value: stats.data?.graduated },
    { n: "03", label: t("home.stats.grants"), value: stats.data?.activeGrants },
    { n: "04", label: t("home.stats.quotes"), value: stats.data?.quotes },
  ];

  return (
    <div>
      {/* hero: copy on the left, the credential scene on the right */}
      <section className="grid grid-cols-1 items-center gap-6 pb-14 pt-8 lg:min-h-[600px] lg:grid-cols-[1.15fr_1fr] lg:gap-9 lg:pb-16 lg:pt-14 [&>*]:min-w-0">
        <div className="fade-up min-w-0">
          <p className="mb-6 flex items-center gap-2.5 text-[12px] font-bold tracking-wide text-muted">
            <Blossom size={18} tone="honey" spin />
            {t("home.hero.kicker")}
          </p>
          <h1 className="hero-title font-display text-[40px] leading-[1.12] sm:text-[52px] lg:text-[60px]">
            {t("home.hero.line1")}
            <br />
            <span className="font-display-italic">{t("home.hero.line2")}</span>
          </h1>
          <p className="mt-6 max-w-[470px] text-[15px] leading-[1.9] text-muted">{t("home.hero.sub")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/trade" className="btn-primary group inline-flex min-h-[50px] items-center gap-6 px-6 text-sm">
              {t("home.cta.trade")}
              <span aria-hidden className="nudge text-lg">
                ↗
              </span>
            </Link>
            <Link href="/launch" className="btn-ghost group inline-flex min-h-[50px] items-center gap-6 px-6 text-sm">
              {t("nav.launch")}
              <span aria-hidden className="text-lg transition-transform duration-300 ease-spring group-hover:rotate-90">
                +
              </span>
            </Link>
          </div>
          <p className="mt-7 text-[12px] tracking-wide text-subtle">
            <span aria-hidden className="mr-2">
              ↳
            </span>
            {t("home.hero.note")}
          </p>
        </div>
        <HeroScene />
      </section>

      {/* four live figures */}
      <section aria-label={t("home.stats.aria")} className="mb-16">
        <div className="grid grid-cols-2 border-y border-line md:grid-cols-4">
          {ledger.map((s, i) => (
            <div
              key={s.n}
              className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 px-5 py-6 md:px-7 ${i % 2 === 0 ? "border-r" : ""} ${
                i < 2 ? "border-b md:border-b-0" : ""
              } border-line md:border-r md:last:border-r-0 md:first:pl-0`}
            >
              <span className="num pt-0.5 font-mono text-[10px] text-subtle">{s.n}</span>
              <span className="text-[12px] font-medium text-subtle">{s.label}</span>
              <strong className="col-start-2 font-display text-[32px] font-extrabold leading-none tracking-tight">
                <CountUp value={s.value} locale={locale} />
              </strong>
            </div>
          ))}
        </div>
        {apiDown && (
          <Notice tone="rose" title={t("home.api.downTitle")} className="mt-4">
            {t("home.api.downBody", { url: API_URL })}
          </Notice>
        )}
      </section>

      {/* three ways in */}
      <section className="mb-20">
        <SectionHeading eyebrow={t("home.paths.eyebrow")} title={t("home.paths.title")} aside={t("home.paths.aside")} />
        <div className="fade-up-stagger grid gap-4 md:grid-cols-3 md:gap-5">
          {PATHS.map((p) => (
            <Link key={p.href} href={p.href} className={`panel group flex flex-col p-7 ${p.sun ? "panel-sun" : ""}`}>
              <div className="mb-7 flex items-center justify-between">
                <span className={`font-mono text-[10px] tracking-[0.12em] ${p.sun ? "text-[#73633e] dark:text-[#c6b98d]" : "text-subtle"}`}>
                  {t(p.tag)}
                </span>
                <span
                  aria-hidden
                  className={`wiggle grid h-10 w-10 place-items-center rounded-xl text-[22px] ${
                    p.sun ? "bg-yolk text-charcoal" : "bg-raised text-bone"
                  }`}
                >
                  <p.icon size={20} />
                </span>
              </div>
              <h3 className="font-display text-[26px] leading-tight">{t(p.title)}</h3>
              <p className={`mt-3 flex-1 text-[14px] leading-[1.85] ${p.sun ? "text-[#73633e] dark:text-[#c6b98d]" : "text-muted"}`}>
                {t(p.body)}
              </p>
              <span
                className={`mt-6 flex items-center justify-between border-t pt-5 text-[13px] font-bold ${
                  p.sun ? "border-[#e8dba8] dark:border-[#5d5129]" : "border-line"
                }`}
              >
                {t(p.cta)}
                <span aria-hidden className="nudge text-lg font-normal">
                  ↗
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {featuredItems.length > 0 && (
        <section className="mb-20">
          <SectionHeading eyebrow={t("home.featured.eyebrow")} title={t("home.featured")} />
          <div className="fade-up-stagger grid gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {featuredItems.map((item) => (
              <LaunchCard key={item.meme} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* the market */}
      <section className="mb-8">
        <SectionHeading
          eyebrow={t("home.markets.eyebrow")}
          title={t("home.trending")}
          right={
            <Link href="/trade" className="group inline-flex items-center gap-3 py-2 text-[13px] font-bold">
              {t("home.trending.all")}
              <span aria-hidden className="nudge text-lg font-normal">
                ↗
              </span>
            </Link>
          }
        />
        {list.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {Array.from({ length: 3 }, (_, i) => (
              <LaunchCardSkeleton key={i} />
            ))}
          </div>
        ) : items.length === 0 && !apiDown ? (
          <div className="well flex flex-col gap-5 p-7 sm:flex-row sm:items-center sm:gap-6 sm:p-9">
            <span aria-hidden className="hidden h-10 items-end gap-1.5 sm:flex">
              <span className="h-4 w-2 rounded-sm bg-shell" />
              <span className="h-6 w-2 rounded-sm bg-shell" />
              <span className="h-5 w-2 rounded-sm bg-shell" />
              <span className="h-8 w-2 rounded-sm bg-honey" />
            </span>
            <p className="flex-1 text-sm text-muted">{t("home.empty.text")}</p>
            <Link href="/launch" className="btn-primary group inline-flex items-center gap-4 px-5 py-3 text-sm">
              {t("home.empty.cta")}
              <span aria-hidden className="nudge">
                ↗
              </span>
            </Link>
          </div>
        ) : (
          <div className="fade-up-stagger grid gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {items.map((item) => (
              <LaunchCard key={item.meme} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
