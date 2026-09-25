import { describe, expect, test } from "bun:test";
import type { QuotePrice } from "@/lib/api-types";
import {
  formatUsd,
  formatUsdPrice,
  quoteAmountToUsd,
  quotePriceToUsd,
  usableUsdRates,
  usdRateOf,
  USD_RATES_MAX_AGE_MS,
} from "@/lib/usd";

const OKB = "0x0000000000000000000000000000000000000000";
const TAAPL = "0x7f9a46e6be91ad215e4000fdb697bf2b1c079f96";
const UNPRICED = "0x00000000000000000000000000000000000000dd";

const price = (quote: string, usd: number, stale = false): QuotePrice => ({
  quote: quote as `0x${string}`,
  symbol: "X",
  usd,
  source: "fixed:1",
  updatedAt: 1_790_000_000,
  stale,
});

describe("usableUsdRates", () => {
  const now = 1_790_000_000_000;
  test("keeps positive, fresh rates by lowercase address", () => {
    const rates = usableUsdRates([price(OKB, 119.73), price(TAAPL.toUpperCase().replace("0X", "0x"), 256.08)], now - 1000, now);
    expect(usdRateOf(rates, OKB)).toBe(119.73);
    expect(usdRateOf(rates, TAAPL)).toBe(256.08);
    expect(usdRateOf(rates, TAAPL.toUpperCase().replace("0X", "0x"))).toBe(256.08);
  });
  test("an unknown quote has no rate", () => {
    const rates = usableUsdRates([price(OKB, 119.73)], now, now);
    expect(usdRateOf(rates, UNPRICED)).toBeNull();
    expect(usdRateOf(rates, undefined)).toBeNull();
  });
  test("stale, zero, negative and non-finite rates are dropped", () => {
    const rates = usableUsdRates(
      [price(OKB, 119.73, true), price(TAAPL, 0), price(UNPRICED, -1), price("0x01", Number.NaN), price("0x02", Infinity)],
      now,
      now,
    );
    expect(rates.size).toBe(0);
  });
  test("a response this page could not refresh for 15 minutes is dropped, as is none at all", () => {
    expect(usableUsdRates([price(OKB, 119.73)], now - USD_RATES_MAX_AGE_MS - 1, now).size).toBe(0);
    expect(usableUsdRates([price(OKB, 119.73)], now - USD_RATES_MAX_AGE_MS + 1000, now).size).toBe(1);
    expect(usableUsdRates(undefined, now, now).size).toBe(0);
    expect(usableUsdRates([price(OKB, 119.73)], 0, now).size).toBe(0);
  });
});

describe("conversions", () => {
  test("raw quote amounts use the quote's own decimals", () => {
    // 8,587 base units of a 6-decimal tAAPL = 0.008587 tAAPL
    expect(quoteAmountToUsd(8587n, 6, 256)).toBeCloseTo(2.198272, 9);
    expect(quoteAmountToUsd("8587", 6, 256)).toBeCloseTo(2.198272, 9);
    expect(quoteAmountToUsd(2n * 10n ** 18n, 18, 119.73)).toBeCloseTo(239.46, 9);
    expect(quoteAmountToUsd(0n, 18, 119.73)).toBe(0);
  });
  test("no rate or no decimals gives no USD figure, never zero", () => {
    expect(quoteAmountToUsd(8587n, 6, null)).toBeNull();
    expect(quoteAmountToUsd(8587n, 6, 0)).toBeNull();
    expect(quoteAmountToUsd(8587n, null, 256)).toBeNull();
    expect(quoteAmountToUsd(undefined, 6, 256)).toBeNull();
    expect(quoteAmountToUsd("not a number", 6, 256)).toBeNull();
  });
  test("prices", () => {
    expect(quotePriceToUsd(1.4021161120552601e-11, 256)).toBeCloseTo(3.5894e-9, 12);
    expect(quotePriceToUsd(0.5, null)).toBeNull();
    expect(quotePriceToUsd(0, 256)).toBeNull();
    expect(quotePriceToUsd(null, 256)).toBeNull();
    expect(quotePriceToUsd(Number.NaN, 256)).toBeNull();
  });
});

describe("formatUsdPrice", () => {
  test("tiny prices keep the subscript-zero convention", () => {
    expect(formatUsdPrice(0.00000000002941, "en")).toBe("$0.0₁₀2941");
    expect(formatUsdPrice(3.5894e-9, "en")).toBe("$0.0₈3589");
  });
  test("below $1 four significant digits, from $1 currency style", () => {
    expect(formatUsdPrice(0.123456, "en")).toBe("$0.1235");
    expect(formatUsdPrice(1.23456, "en")).toBe("$1.2346");
    expect(formatUsdPrice(119.7312, "en")).toBe("$119.73");
    expect(formatUsdPrice(2, "en")).toBe("$2.00");
  });
});

describe("formatUsd", () => {
  test("cents from one cent up, grouped", () => {
    expect(formatUsd(2.198272, "en")).toBe("$2.20");
    expect(formatUsd(1234567.891, "en")).toBe("$1,234,567.89");
    expect(formatUsd(0.5, "en")).toBe("$0.50");
  });
  test("below a cent it is never rounded to $0.00", () => {
    expect(formatUsd(0.0042, "en")).toBe("$0.0042");
    expect(formatUsd(0.0000012345, "en")).toBe("$0.0₅1235");
  });
  test("compact for dense lists", () => {
    expect(formatUsd(1_234_567, "en", { compact: true })).toBe("$1.23M");
    expect(formatUsd(12_300, "en", { compact: true })).toBe("$12.3K");
    expect(formatUsd(999.5, "en", { compact: true })).toBe("$999.50");
  });
  test("zero, negatives and non-finite", () => {
    expect(formatUsd(0, "en")).toBe("$0");
    expect(formatUsd(-3.5, "en")).toBe("-$3.50");
    expect(formatUsd(Number.NaN, "en")).toBe("—");
  });
});
