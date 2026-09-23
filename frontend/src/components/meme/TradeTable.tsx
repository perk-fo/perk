"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import type { Trade } from "@/lib/trades";
import { tradePriceNumber } from "@/lib/trades";
import { explorerTxUrl } from "@/lib/chains";
import {
  formatAmount,
  formatDate,
  formatNumber,
  formatPrice,
  formatRelativeTime,
  shortAddress,
} from "@/lib/format";
import { Pill } from "@/components/ui/Pill";
import { useNow } from "@/lib/hooks";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";

const PAGE = 20;
/** Trades and holders share this fixed height (side by side, always equal); rows scroll inside. */
export const LIST_PANEL_H = "h-[520px]";

export function TradeTable({
  trades,
  isLoading,
  quoteSymbol,
  quoteDecimals,
  memeSymbol,
  memeDecimals,
  account,
  chainId,
  onVisibleCount,
}: {
  trades: Trade[];
  isLoading: boolean;
  quoteSymbol: string;
  quoteDecimals: number;
  memeSymbol: string;
  memeDecimals: number;
  account?: Address;
  chainId: number;
  onVisibleCount?: (n: number) => void;
}) {
  const { t, locale } = useT();
  const now = useNow(15_000);
  const [limit, setLimit] = useState(PAGE);
  const primed = useRef(false);
  const seen = useRef(new Set<string>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!primed.current) {
      if (!isLoading) {
        trades.forEach((tr) => seen.current.add(tr.id));
        primed.current = true;
      }
      return;
    }
    const next = new Set<string>();
    for (const tr of trades) {
      if (!seen.current.has(tr.id)) next.add(tr.id);
    }
    if (next.size > 0) {
      setFresh(next);
      next.forEach((id) => seen.current.add(id));
    }
  }, [trades, isLoading]);

  const rows = useMemo(() => trades.slice(0, limit), [trades, limit]);
  useEffect(() => {
    onVisibleCount?.(limit);
  }, [limit, onVisibleCount]);
  const mine = account?.toLowerCase();

  if (isLoading && trades.length === 0) {
    return (
      <section className={`panel flex flex-col p-6 ${LIST_PANEL_H}`}>
        <header className="mb-4">
          <h2 className="label">{t("meme.trades.title")}</h2>
        </header>
        <div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-line py-3">
              <div className="h-2 w-16 rounded-full border border-line" />
              <div className="h-2 w-10 rounded-full border border-line" />
              <div className="ml-auto h-2 w-24 rounded-full border border-line" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={`panel flex flex-col p-6 ${LIST_PANEL_H}`}>
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="label">{t("meme.trades.title")}</h2>
        <span className="num text-xs text-subtle">{formatNumber(trades.length, locale)}</span>
      </header>
      {rows.length === 0 ? (
        <p className="text-sm text-subtle">
          {t("meme.trades.empty")} {t("meme.trades.emptyHint")}
        </p>
      ) : (
        <div
          className="-mx-1 min-h-0 flex-1 overflow-auto overscroll-contain px-1"
          onScroll={(e) => {
            // near the bottom: reveal the next page (replaces a "load more" button inside a fixed-height card)
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 120 && trades.length > limit) setLimit((n) => n + PAGE);
          }}
        >
          <table className="w-full min-w-[480px] whitespace-nowrap text-[13px]">
            <thead className="sticky top-0 z-[1] bg-[rgb(var(--c-surface))]">
              <tr className="label text-left">
                <th className="pb-2 pr-3 font-normal">{t("meme.trades.time")}</th>
                <th className="px-2 pb-2 font-normal">{t("meme.trades.side")}</th>
                <th className="px-2 pb-2 text-right font-normal">{quoteSymbol}</th>
                <th className="px-2 pb-2 text-right font-normal">{memeSymbol}</th>
                <th className="px-2 pb-2 text-right font-normal">{t("meme.trades.price")}</th>
                <th className="pb-2 pl-2 text-right font-normal">{t("meme.trades.wallet")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tr) => {
                const isMine = mine !== undefined && tr.wallet.toLowerCase() === mine;
                const price = tradePriceNumber(tr, quoteDecimals, memeDecimals);
                return (
                  <tr
                    key={tr.id}
                    className={`border-t border-line hover:bg-raised ${fresh.has(tr.id) ? "fade-in" : ""}`}
                  >
                    <td className="py-3 pr-3 align-middle">
                      <a
                        href={explorerTxUrl(chainId, tr.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        title={`${formatDate(tr.timestamp, locale)} · ${t("meme.trades.tx")} ${shortAddress(tr.txHash)}`}
                        className="num text-muted underline decoration-dotted decoration-line-strong underline-offset-4 hover:text-flare hover:decoration-flare"
                      >
                        {formatRelativeTime(tr.timestamp, now, t)}
                      </a>
                    </td>
                    <td className="px-2 py-3 align-middle">
                      <Pill tone={tr.side === "buy" ? "verdigris" : "rose"}>
                        {tr.side === "buy" ? t("meme.trade.buy") : t("meme.trade.sell")}
                      </Pill>
                    </td>
                    <td className="num px-2 py-3 text-right align-middle">
                      {formatAmount(tr.quoteAmount, quoteDecimals, { locale, maxFrac: 4 })}
                    </td>
                    <td className="num px-2 py-3 text-right align-middle">
                      {formatAmount(tr.memeAmount, memeDecimals, { locale, maxFrac: 2 })}
                    </td>
                    <td className="num px-2 py-3 text-right align-middle">
                      <Subscripted text={formatPrice(price, locale)} />
                    </td>
                    <td className={`mono py-3 pl-2 text-right align-middle text-[12.5px] ${isMine ? "text-flare" : "text-muted"}`}>
                      {tr.walletIsRouter
                        ? t("meme.trades.router")
                        : shortAddress(tr.wallet)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
