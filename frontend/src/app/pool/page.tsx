"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useLaunchList, useLpPositions } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { HashSeal } from "@/components/art/HashSeal";
import { formatAmount, formatNumber, formatPrice } from "@/lib/format";
import { useT } from "@/i18n/provider";

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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl leading-none">{t("pool.title")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-bone/55">{t("pool.sub")}</p>
        </div>
        <span className="num text-xs text-bone/45">
          {list.data ? t("pool.count", { n: formatNumber(pools.length, locale) }) : ""}
        </span>
      </header>

      {apiDown && (
        <Notice tone="rose" title={t("home.api.downTitle")}>
          {t("home.api.downBody", { url: API_URL })}
        </Notice>
      )}

      {/* my positions */}
      <Panel
        title={t("pool.mine.title")}
        right={<span className="num text-xs text-bone/45">{address ? mine.length : ""}</span>}
      >
        {!address ? (
          <p className="text-sm text-bone/50">{t("pool.lp.connect")}</p>
        ) : positions.isLoading ? (
          <Skeleton size={28} lines={2} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-bone/50">{t("pool.mine.empty")}</p>
        ) : (
          <div className="divide-y divide-bone/6">
            {mine.map((p) => {
              const meta = nameOf.get(p.meme!.toLowerCase());
              return (
                <Link
                  key={p.tokenId}
                  href={`/pool/${p.meme}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm transition-colors duration-fast hover:text-flare"
                >
                  <span className="flex items-center gap-3">
                    <span className="num text-bone/45">#{p.tokenId}</span>
                    <span>
                      {meta ? `${meta.symbol} / ${meta.quoteSymbol}` : p.meme}
                    </span>
                  </span>
                  <span className="text-xs text-bone/50">{t("pool.mine.manage")} →</span>
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
          className="w-full rounded-full border border-bone/10 bg-transparent px-4 py-2 text-sm outline-none transition-colors duration-fast placeholder:text-bone/35 focus:border-bone/30 sm:w-72"
        />
      </div>

      {list.isLoading ? (
        <Panel>
          <Skeleton size={40} lines={5} />
        </Panel>
      ) : pools.length === 0 && !apiDown ? (
        <Panel className="py-14 text-center text-sm text-bone/60">{q ? t("trade.noMatch") : t("pool.all.empty")}</Panel>
      ) : (
        <div className="panel overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead>
                <tr className="label border-b border-bone/8 text-left">
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
                  return (
                    <tr
                      key={item.meme}
                      onClick={() => router.push(href)}
                      className="cursor-pointer border-b border-bone/6 transition-colors duration-fast last:border-0 hover:bg-bone/[0.03]"
                    >
                      <td className="py-3 pl-5 pr-2">
                        <span className="flex items-center gap-3">
                          <HashSeal hash={item.configHash} moduleBitmap={BigInt(item.moduleBitmap)} size={30} className="shrink-0" />
                          <span className="min-w-0">
                            <span className="block text-[14px] text-bone">
                              {item.symbol} <span className="text-bone/30">/</span> {item.quoteSymbol}
                            </span>
                            <span className="block max-w-[200px] truncate text-[11px] text-bone/45">{item.name}</span>
                          </span>
                        </span>
                      </td>
                      <td className="num px-2 py-3 text-right">
                        {m.lastPrice !== null && m.lastPrice > 0 ? formatPrice(m.lastPrice, locale) : <span className="text-bone/30">—</span>}
                      </td>
                      <td className="num hidden px-2 py-3 text-right text-bone/80 md:table-cell">
                        {formatAmount(BigInt(m.volume24hQuote), item.quoteDecimals, { locale, maxFrac: 4 })}
                        <span className="ml-1 text-[11px] text-bone/40">{item.quoteSymbol}</span>
                      </td>
                      <td className="num hidden px-2 py-3 text-right text-bone/70 lg:table-cell">
                        {item.curve ? `${(item.curve.totalFeeBps / 100).toFixed(2)}%` : "—"}
                      </td>
                      <td className="py-3 pl-2 pr-5 text-right">
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded-full border border-flare/40 px-3 py-1.5 text-[12px] text-flare transition-colors duration-fast hover:bg-flare/10"
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
