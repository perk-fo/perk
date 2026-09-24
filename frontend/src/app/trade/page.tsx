"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLaunchList } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import { launchStatusPill } from "@/components/ui/Pill";
import { Segmented } from "@/components/ui/Segmented";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { MarketTable } from "@/components/market/MarketTable";
import { formatNumber } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { PageHeader } from "@/components/ui/SectionHeading";
import { PerkLoader } from "@/components/brand/PerkLoader";
import { EmptyState } from "@/components/ui/EmptyState";

const SORTS = ["volume", "newest", "progress", "trades"] as const;
type Sort = (typeof SORTS)[number];
const FILTERS = ["all", "1", "3", "2"] as const;
type Filter = (typeof FILTERS)[number];

/** Trade: the market. Search, filter by stage, sort; each row opens the token's trading page. */
export default function TradePage() {
  const { t, locale } = useT();
  const [sort, setSort] = useState<Sort>("volume");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const list = useLaunchList({ sort, status: filter === "all" ? undefined : filter, limit: 100 });
  const apiDown = isApiUnreachable(list.error);

  const items = useMemo(() => {
    const all = list.data?.launches ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (l) =>
        l.name.toLowerCase().includes(needle) ||
        l.symbol.toLowerCase().includes(needle) ||
        l.meme.toLowerCase() === needle,
    );
  }, [list.data, q]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t("home.door.tradeTag")}
        title={t("trade.title")}
        description={t("trade.sub")}
        right={
          <span className="num rounded-full bg-raised px-3 py-1 text-xs font-bold text-muted">
            {list.data ? t("trade.count", { n: formatNumber(list.data.total, locale) }) : "—"}
          </span>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("trade.search")}
          className="w-full rounded-xl border border-line-strong bg-surface px-4 py-2.5 text-sm outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint focus:border-honey focus:ring-4 focus:ring-yolk/30 sm:w-80"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={filter}
            options={FILTERS}
            onChange={setFilter}
            label={(f) => (f === "all" ? t("home.filter.all") : launchStatusPill(Number(f), t).label)}
          />
          <Segmented value={sort} options={SORTS} onChange={setSort} label={(s) => t(`home.sort.${s}`)} />
        </div>
      </div>

      {apiDown && (
        <Notice tone="rose" title={t("home.api.downTitle")}>
          {t("home.api.downBody", { url: API_URL })}
        </Notice>
      )}

      {list.isLoading ? (
        <PerkLoader size={60} minHeight={320} />
      ) : items.length === 0 && !apiDown ? (
        <EmptyState
          action={
            !q && (
              <Link href="/launch" className="btn-primary inline-block px-5 py-3 text-sm">
                {t("home.empty.cta")}
              </Link>
            )
          }
        >
          {q ? t("trade.noMatch") : t("home.empty.text")}
        </EmptyState>
      ) : (
        <MarketTable items={items} />
      )}
    </div>
  );
}
