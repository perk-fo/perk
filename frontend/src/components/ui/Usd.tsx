"use client";

import type { ReactNode } from "react";
import { useT } from "@/i18n/provider";
import { formatUsd, formatUsdPrice } from "@/lib/usd";
import { Subscripted } from "./Subscripted";

/**
 * A money figure in US dollars, with the quote figure under it in smaller muted text. Without a USD value (no rate
 * for the quote, or a stale one) it renders `children` alone, which is the quote display the page had before USD
 * existed, so a missing rate never turns into a wrong or zero dollar figure.
 *
 * - `kind`: "price" per token (subscript zeros for tiny prices) or "amount" (cents; `compact` for dense lists).
 * - `approx`: prefix "≈", for today's value of something that happened earlier (a past trade, a deposit).
 * - `rate` and `symbol` explain the conversion in the tooltip.
 * - `inline`: the quote figure follows on the same line instead of under it.
 */
export function UsdFigure({
  usd,
  kind = "amount",
  compact,
  approx,
  rate,
  symbol,
  inline,
  children,
}: {
  usd: number | null;
  kind?: "price" | "amount";
  compact?: boolean;
  approx?: boolean;
  rate?: number | null;
  symbol?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useT();
  if (usd === null || !Number.isFinite(usd)) return <>{children}</>;
  const text = kind === "price" ? formatUsdPrice(usd, locale) : formatUsd(usd, locale, { compact });
  const title =
    rate && symbol
      ? t(approx ? "usd.titleNow" : "usd.title", { symbol, rate: formatUsdPrice(rate, locale) })
      : undefined;
  const primary = (
    <>
      {approx && <span className="font-normal text-subtle">≈ </span>}
      <Subscripted text={text} />
    </>
  );
  if (inline) {
    return (
      <span title={title}>
        {primary}
        <span className="ml-1.5 text-xs font-medium tracking-normal text-subtle">{children}</span>
      </span>
    );
  }
  return (
    <span title={title} className="inline-block max-w-full align-top">
      <span className="block">{primary}</span>
      <span className="mt-0.5 block text-xs font-medium leading-tight tracking-normal text-subtle">{children}</span>
    </span>
  );
}
