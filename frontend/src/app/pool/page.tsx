"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useLaunchList, useLpPositions, useUsdRates } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { formatAmount, formatNumber, formatPrice } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";
import { UsdFigure } from "@/components/ui/Usd";
import { quoteAmountToUsd, quotePriceToUsd, usdRateOf } from "@/lib/usd";
import { PageHeader } from "@/components/ui/SectionHeading";

/**
 * Pool: every graduated launch has a public v4 pool, and anyone can add two-sided liquidity to it. This page lists
 * the pools and the connected wallet's positions; each pool has its own page for adding and managing liquidity.
 */
export default function PoolPage() {
  const { t, locale } = useT();
  const router = useRouter();
  const { address } = useAccount();
  const [q, setQ] = useState("");
  const list = useLaunchList({ status: "3", sort: "volume", limit: 100 });
  const positions = useLpPositions(address);
  const rates = useUsdRates();
  const apiDown = isApiUnreachable(list.error);

  const pools = useMemo(() => {
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

  const nameOf = useMemo(() => {
    const m = new Map<string, { name: string; symbol: string; quoteSymbol: string }>();
    for (const l of list.data?.launches ?? []) {
      m.set(l.meme.toLowerCase(), { name: l.name, symbol: l.symbol, quoteSymbol: l.quoteSymbol });
    }
    return m;
  }, [list.data]);

  const mine = (positions.data?.positions ?? []).filter((p) => p.meme);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t("page.pool.eyebrow")}
        title={t("pool.title")}
        description={t("pool.sub")}
        right={
          <span className="num rounded-full bg-raised px-3 py-1 text-xs font-bold text-muted">
            {list.data ? t("pool.count", { n: formatNumber(pools.length, locale) }) : "—"}
          </span>
        }
      />

      {apiDown && (
        <Notice tone="rose" title={t("home.api.downTitle")}>
          {t("home.api.downBody", { url: API_URL })}
        </Notice>
      )}

      {/* my positions */}
      <Panel
        title={t("pool.mine.title")}
        right={<span className="num text-xs text-subtle">{address ? mine.length : ""}</span>}
      >
        {!address ? (
          <p className="text-sm text-subtle">{t("pool.lp.connect")}</p>
        ) : positions.isLoading ? (
          <Skeleton size={28} lines={2} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-subtle">{t("pool.mine.empty")}</p>
        ) : (
          <div className="divide-y divide-line">
            {mine.map((p) => {
              const meta = nameOf.get(p.meme!.toLowerCase());
              return (
                <Link
                  key={p.tokenId}
                  href={`/pool/${p.meme}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm transition-colors duration-fast hover:text-flare"
                >
                  <span className="flex items-center gap-3">
                    <span className="num text-subtle">#{p.tokenId}</span>
                    <span>
                      {meta ? `${meta.symbol} / ${meta.quoteSymbol}` : p.meme}
                    </span>
                  </span>
                  <span className="text-xs text-subtle">{t("pool.mine.manage")} →</span>
                </Link>
              );
            })}
          </div>
        )}
      </Panel>

      {/* all pools */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <h2 className="label">{t("pool.all.title")}</h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("trade.search")}
          className="w-full rounded-full border border-line bg-transparent px-4 py-2 text-sm outline-none transition-colors duration-fast placeholder:text-faint focus:border-line-strong sm:w-72"
        />
      </div>

      {list.isLoading ? (
        <Panel>
          <Skeleton size={40} lines={5} />
        </Panel>
      ) : pools.length === 0 && !apiDown ? (
        <Panel className="py-14 text-center text-sm text-muted">{q ? t("trade.noMatch") : t("pool.all.empty")}</Panel>
      ) : (
        <div className="panel overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead>
                <tr className="label border-b border-line text-left">
                  <th className="py-3 pl-5 pr-2 font-normal">{t("pool.col.pool")}</th>
                  <th className="px-2 py-3 text-right font-normal">{t("trade.col.price")}</th>
                  <th className="hidden px-2 py-3 text-right font-normal md:table-cell">{t("trade.col.volume")}</th>
                  <th className="hidden px-2 py-3 text-right font-normal lg:table-cell">{t("pool.col.fee")}</th>
                  <th className="py-3 pl-2 pr-5 text-right font-normal" />
                </tr>
              </thead>
              <tbody>
                {pools.map((item) => {
                  const href = `/pool/${item.meme}`;
                  const m = item.market;
                  const rate = usdRateOf(rates, item.quote);
                  const usd = { rate, symbol: item.quoteSymbol };
                  return (
                    <tr
                      key={item.meme}
                      onClick={() => router.push(href)}
                      className="group cursor-pointer border-b border-line transition-colors duration-fast last:border-0 hover:bg-raised"
                    >
                      <td className="py-3 pl-5 pr-2">
                        <span className="flex items-center gap-3">
                          <LaunchAvatar hash={item.configHash} image={item.metadata?.image} status={item.status} size={34} title={item.name} />
                          <span className="min-w-0">
                            <span className="block text-[14px] text-bone">
                              {item.symbol} <span className="text-faint">/</span> {item.quoteSymbol}
                            </span>
                            <span className="block max-w-[200px] truncate text-xs text-subtle">{item.name}</span>
                          </span>
                        </span>
                      </td>
                      <td className="num px-2 py-3 text-right">
                        {m.lastPrice !== null && m.lastPrice > 0 ? (
                          <UsdFigure kind="price" usd={quotePriceToUsd(m.lastPrice, rate)} {...usd}>
                            <Subscripted text={formatPrice(m.lastPrice, locale)} />
                          </UsdFigure>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="num hidden px-2 py-3 text-right text-bone md:table-cell">
                        <UsdFigure compact usd={quoteAmountToUsd(m.volume24hQuote, item.quoteDecimals, rate)} {...usd}>
                          {formatAmount(BigInt(m.volume24hQuote), item.quoteDecimals, { locale, maxFrac: 4 })}
                          <span className="ml-1 text-xs text-subtle">{item.quoteSymbol}</span>
                        </UsdFigure>
                      </td>
                      <td className="num hidden px-2 py-3 text-right text-muted lg:table-cell">
                        {item.curve ? `${(item.curve.totalFeeBps / 100).toFixed(2)}%` : "—"}
                      </td>
                      <td className="py-3 pl-2 pr-5 text-right">
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded-full bg-raised px-3.5 py-1.5 text-[13px] font-medium text-bone transition-colors duration-fast hover:bg-yolk/40"
                        >
                          {t("pool.lp.add")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
