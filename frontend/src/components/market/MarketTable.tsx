"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LaunchSummary } from "@/lib/api-types";
import { progressBpsOf } from "@/lib/api-adapters";
import { HashSeal } from "@/components/art/HashSeal";
import { Pill, launchStatusPill } from "@/components/ui/Pill";
import { formatAmount, formatNumber, formatPrice, signedPct } from "@/lib/format";
import { useT } from "@/i18n/provider";

/**
 * The market as a dense table (DEX-style): one row per launch, whole row clickable to its trading page.
 * Columns narrow away on small screens (price and 24h stay).
 */
export function MarketTable({ items, startRank = 1 }: { items: LaunchSummary[]; startRank?: number }) {
  const { t, locale } = useT();
  const router = useRouter();
  return (
    <div className="panel overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-[13px]">
          <thead>
            <tr className="label border-b border-bone/8 text-left">
              <th className="w-10 py-3 pl-5 pr-2 font-normal">#</th>
              <th className="px-2 py-3 font-normal">{t("trade.col.token")}</th>
              <th className="px-2 py-3 text-right font-normal">{t("trade.col.price")}</th>
              <th className="px-2 py-3 text-right font-normal">{t("trade.col.change")}</th>
              <th className="hidden px-2 py-3 text-right font-normal md:table-cell">{t("trade.col.volume")}</th>
              <th className="hidden px-2 py-3 text-right font-normal lg:table-cell">{t("trade.col.mcap")}</th>
              <th className="hidden px-2 py-3 text-right font-normal lg:table-cell">{t("trade.col.holders")}</th>
              <th className="hidden py-3 pl-2 pr-5 text-right font-normal sm:table-cell">{t("trade.col.stage")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const m = item.market;
              const change = signedPct(m.change24hBps, locale);
              const pill = launchStatusPill(item.status, t);
              const progress = Number(progressBpsOf(item)) / 100;
              const href = `/meme/${item.meme}`;
              return (
                <tr
                  key={item.meme}
                  onClick={() => router.push(href)}
                  className="cursor-pointer border-b border-bone/6 transition-colors duration-fast last:border-0 hover:bg-bone/[0.03]"
                >
                  <td className="num py-3 pl-5 pr-2 text-bone/40">{startRank + i}</td>
                  <td className="px-2 py-3">
                    <Link href={href} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                      <HashSeal hash={item.configHash} moduleBitmap={BigInt(item.moduleBitmap)} size={30} className="shrink-0" />
                      <span className="min-w-0">
                        <span className="block max-w-[180px] truncate text-[14px] text-bone">{item.name || "…"}</span>
                        <span className="num flex items-center gap-1.5 text-[11px] text-bone/45">
                          {item.symbol}
                          <span className="text-bone/25">/</span>
                          {item.quoteSymbol}
                          {item.lpGrantEnabled && <span className="rounded-full bg-amber/15 px-1.5 text-[10px] text-amber">LP Grant</span>}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="num px-2 py-3 text-right">
                    {m.lastPrice !== null && m.lastPrice > 0 ? formatPrice(m.lastPrice, locale) : <span className="text-bone/30">—</span>}
                  </td>
                  <td
                    className={`num px-2 py-3 text-right ${
                      change.tone === "flare" ? "text-flare" : change.tone === "rose" ? "text-rose" : "text-bone/40"
                    }`}
                  >
                    {m.tradeCount > 0 ? change.text : "—"}
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-bone/80 md:table-cell">
                    {formatAmount(BigInt(m.volume24hQuote), item.quoteDecimals, { locale, maxFrac: 4 })}
                    <span className="ml-1 text-[11px] text-bone/40">{item.quoteSymbol}</span>
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-bone/80 lg:table-cell">
                    {m.marketCapQuote ? (
                      <>
                        {formatAmount(BigInt(m.marketCapQuote), item.quoteDecimals, { locale, maxFrac: 2 })}
                        <span className="ml-1 text-[11px] text-bone/40">{item.quoteSymbol}</span>
                      </>
                    ) : (
                      <span className="text-bone/30">—</span>
                    )}
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-bone/70 lg:table-cell">
                    {formatNumber(m.holderCount, locale)}
                  </td>
                  <td className="hidden py-3 pl-2 pr-5 text-right sm:table-cell">
                    {item.status === 1 ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-bone/10">
                          <span className="block h-full rounded-full bg-flare/80" style={{ width: `${Math.min(100, progress)}%` }} />
                        </span>
                        <span className="num w-10 text-right text-[12px] text-bone/60">{progress.toFixed(0)}%</span>
                      </span>
                    ) : (
                      <Pill tone={pill.tone}>{pill.label}</Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
