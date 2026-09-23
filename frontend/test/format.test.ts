import { describe, expect, test } from "bun:test";
import { formatAmount, formatCompact, formatPrice, fmtBps, shortAddress, shortHash, signedPct } from "@/lib/format";

describe("formatPrice", () => {
  test("very small prices use the subscript-zero convention", () => {
    expect(formatPrice(0.000000000548)).toBe("0.0₉548");
    expect(formatPrice(0.0000123)).toBe("0.0₄123");
  });
  test("prices below 1 keep 4 significant digits", () => {
    expect(formatPrice(0.123456)).toBe("0.1235");
    expect(formatPrice(0.5)).toBe("0.5");
  });
  test("zero and non-finite render as 0", () => {
    expect(formatPrice(0)).toBe("0");
    expect(formatPrice(Number.NaN)).toBe("0");
  });
  test("prices ≥ 1 are locale formatted", () => {
    expect(formatPrice(1234.5678, "en")).toBe("1,234.5678");
  });
});

describe("formatAmount", () => {
  test("trims trailing zeros and caps fraction digits", () => {
    expect(formatAmount(1_500_000_000_000_000_000n, 18, { locale: "en" })).toBe("1.5");
    expect(formatAmount(1_234_567n, 6, { locale: "en", maxFrac: 2 })).toBe("1.23");
    expect(formatAmount(undefined)).toBe("—");
  });
  test("groups the integer part", () => {
    expect(formatAmount(1_000_000n * 10n ** 18n, 18, { locale: "en" })).toBe("1,000,000");
  });
});

describe("formatCompact", () => {
  test("uses K/M/B/T and falls back to an exponent beyond trillions", () => {
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(2_340_000)).toBe("2.34M");
    expect(formatCompact(-4_100_000_000)).toBe("-4.1B");
    expect(formatCompact(1.22e21)).toBe("1.22e+21");
  });
});

describe("misc", () => {
  test("bps and signed percentages", () => {
    expect(fmtBps(1500n, "en")).toBe("15%");
    expect(signedPct(123, "en")).toEqual({ text: "+1.23%", tone: "verdigris" });
    expect(signedPct(-40, "en")).toEqual({ text: "-0.4%", tone: "rose" });
    expect(signedPct(0)).toEqual({ text: "0%", tone: null });
  });
  test("short address / hash", () => {
    expect(shortAddress("0x586FFb7fB876F9447Dfbf5e5733a98Ae91cf0712")).toBe("0x586F…0712");
    expect(shortHash("0x" + "ab".repeat(32))).toBe("0xabababab…ababab");
  });
});
