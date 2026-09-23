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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl leading-none">{t("trade.title")}</h1>
          <p className="mt-2 text-sm text-subtle">{t("trade.sub")}</p>
        </div>
        <span className="num text-xs text-subtle">
          {list.data ? t("trade.count", { n: formatNumber(list.data.total, locale) }) : ""}
        </span>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("trade.search")}
          className="w-full rounded-full border border-line bg-transparent px-4 py-2 text-sm outline-none transition-colors duration-fast placeholder:text-faint focus:border-line-strong sm:w-72"
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
        <Panel>
          <Skeleton size={40} lines={6} />
        </Panel>
      ) : items.length === 0 && !apiDown ? (
        <Panel className="flex flex-col items-center py-14 text-center">
          <p className="text-sm text-muted">{q ? t("trade.noMatch") : t("home.empty.text")}</p>
          {!q && (
            <Link href="/launch" className="btn-primary mt-6 inline-block px-5 py-2.5 text-sm">
              {t("home.empty.cta")}
            </Link>
          )}
        </Panel>
      ) : (
        <MarketTable items={items} />
      )}
    </div>
  );
}
