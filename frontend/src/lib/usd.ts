import { formatUnits } from "viem";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import type { QuotePrice } from "./api-types";
import { formatCompact, formatNumber, formatPrice } from "./format";

/**
 * US-dollar figures. Launches trade against a quote asset (OKB, tAAPL, ...); the API publishes each quote's USD price
 * (GET /v1/prices) and the pages show USD first, with the quote figure kept beside it. A quote without a usable rate
 * gets no USD figure at all: the page shows its quote figure exactly as before, never a guessed or zero dollar amount.
 */

/**
 * How long a fetched set of rates is trusted without a successful refetch, measured on this device's clock from the
 * moment it arrived (the API marks a rate `stale` itself once its source has failed for 15 minutes).
 */
export const USD_RATES_MAX_AGE_MS = 15 * 60_000;

/** Rates usable now, by lowercase quote address: US dollars per whole unit of the quote. */
export type UsdRates = ReadonlyMap<string, number>;

export const NO_USD_RATES: UsdRates = new Map();

/**
 * The rates worth showing: positive and finite, not marked stale by the API, from a response at most
 * `USD_RATES_MAX_AGE_MS` old (`fetchedAt` and `now` in ms on the same clock). Anything else is left out.
 */
export function usableUsdRates(
  prices: readonly QuotePrice[] | undefined,
  fetchedAt: number,
  now: number,
  maxAgeMs = USD_RATES_MAX_AGE_MS,
): UsdRates {
  if (!prices || prices.length === 0 || !(fetchedAt > 0) || now - fetchedAt > maxAgeMs) return NO_USD_RATES;
  const out = new Map<string, number>();
  for (const p of prices) {
    if (p.stale || typeof p.usd !== "number" || !Number.isFinite(p.usd) || p.usd <= 0) continue;
    out.set(p.quote.toLowerCase(), p.usd);
  }
  return out;
}

/** The rate for one quote, or null. */
export function usdRateOf(rates: UsdRates, quote: string | null | undefined): number | null {
  if (!quote) return null;
  return rates.get(quote.toLowerCase()) ?? null;
}

/** A raw quote amount (base units) in US dollars, or null without a rate or decimals. Zero stays zero. */
export function quoteAmountToUsd(
  amount: bigint | string | null | undefined,
  decimals: number | null | undefined,
  rate: number | null | undefined,
): number | null {
  if (amount === null || amount === undefined || decimals === null || decimals === undefined || !rate) return null;
  let raw: bigint;
  try {
    raw = typeof amount === "bigint" ? amount : BigInt(amount);
  } catch {
    return null;
  }
  const usd = Number(formatUnits(raw, decimals)) * rate;
  return Number.isFinite(usd) ? usd : null;
}

/** A price in quote per meme as US dollars per meme, or null without a rate or a positive price. */
export function quotePriceToUsd(price: number | null | undefined, rate: number | null | undefined): number | null {
  if (price === null || price === undefined || !rate || !Number.isFinite(price) || price <= 0) return null;
  const usd = price * rate;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

function signed(value: number, body: (abs: number) => string): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  return `${value < 0 ? "-" : ""}$${body(Math.abs(value))}`;
}

/**
 * A USD amount (volume, market cap, a balance's value): cents from one cent up ("$1,234.56"), and below a cent the
 * price convention, so a small testnet figure is never rounded to $0.00 ("$0.0042", "$0.0₆1234"). `compact` shortens
 * thousands and up for dense lists ("$12.3K", "$1.23M").
 */
export function formatUsd(value: number, locale: string = DEFAULT_LOCALE, { compact = false }: { compact?: boolean } = {}): string {
  return signed(value, (abs) => {
    if (abs < 0.01) return formatPrice(abs, locale);
    if (compact && abs >= 1000) return formatCompact(abs);
    return formatNumber(abs, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}

/**
 * A USD price per token: below $1 four significant digits, with the zero count as a subscript for tiny prices
 * ("$0.0₁₀2941", render through ui/Subscripted); from $1 up currency style ("$1.2345", "$119.73").
 */
export function formatUsdPrice(value: number, locale: string = DEFAULT_LOCALE): string {
  return signed(value, (abs) => {
    if (abs < 1) return formatPrice(abs, locale);
    return formatNumber(abs, locale, { minimumFractionDigits: 2, maximumFractionDigits: abs < 10 ? 4 : 2 });
  });
}
