import { formatUnits } from "viem";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import type { TFn } from "@/i18n/provider";

/** Locale-aware number formatting (Intl.NumberFormat). */
export function formatNumber(
  value: number | bigint,
  locale: string = DEFAULT_LOCALE,
  opts?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, opts).format(value);
}

/** Unix seconds -> locale date+time (medium date, short time); 0/undefined renders as a dash. */
export function formatDate(
  ts: bigint | number | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  if (ts === undefined) return "—";
  const n = Number(ts);
  if (!n) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(n * 1000);
}

/**
 * Format a bigint token amount for display: locale-grouped integer part, up to `maxFrac`
 * fraction digits with trailing zeros trimmed.
 */
export function formatAmount(
  value: bigint | undefined,
  decimals = 18,
  { maxFrac = 6, locale = DEFAULT_LOCALE }: { maxFrac?: number; locale?: string } = {},
): string {
  if (value === undefined) return "—";
  const s = formatUnits(value, decimals);
  const [int, frac] = s.split(".");
  const intGrouped = formatNumber(BigInt(int), locale, { maximumFractionDigits: 0 });
  if (!frac) return intGrouped;
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${intGrouped}.${trimmed}` : intGrouped;
}

/** Compact magnitude for raw integers that are not token amounts: 1.5K / 2.3M / 4.1B / 5T. */
export function formatCompact(value: bigint | number, digits = 3): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const units = ["", "K", "M", "B", "T"];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  if (v >= 1000) return `${sign}${Math.abs(n).toExponential(2)}`; // beyond trillions: exponent, never "1220000000T"
  const num = Number(v.toPrecision(digits)); // trims trailing zeros
  return `${sign}${num}${units[u]}`;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Unix seconds -> locale datetime string; 0 renders as a dash. Alias of formatDate. */
export function fmtTime(seconds: bigint | number | undefined, locale: string = DEFAULT_LOCALE): string {
  return formatDate(seconds, locale);
}

/** Remaining seconds -> localised "d/h/m/s" countdown via the grant.countdown.* messages. */
export function fmtCountdown(secondsLeft: number, t: TFn): string {
  if (secondsLeft <= 0) return t("grant.countdown.expired");
  const d = Math.floor(secondsLeft / 86400);
  const h = Math.floor((secondsLeft % 86400) / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  if (d > 0) return t("grant.countdown.dhm", { d, h, m });
  if (h > 0) return t("grant.countdown.hms", { h, m, s });
  return t("grant.countdown.ms", { m, s });
}

/** basis points -> locale percentage string, e.g. 1500 -> "15%" */
export function fmtBps(bps: bigint | number | undefined, locale: string = DEFAULT_LOCALE): string {
  if (bps === undefined) return "—";
  return `${formatNumber(Number(bps) / 100, locale, { maximumFractionDigits: 2 })}%`;
}

/** Unix seconds → relative label ("2 minutes ago"); tooltip should still show the absolute time. */
export function formatRelativeTime(ts: number, now: number, t: TFn): string {
  if (!ts) return "—";
  const d = Math.max(0, now - ts);
  if (d < 60) return t("time.justNow");
  if (d < 3600) return t("time.minutesAgo", { n: Math.floor(d / 60) });
  if (d < 86400) return t("time.hoursAgo", { n: Math.floor(d / 3600) });
  return t("time.daysAgo", { n: Math.floor(d / 86400) });
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
function subscriptDigits(n: number): string {
  return String(n).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
}

/**
 * Quote-per-meme price at the display boundary. Very small prices use the exchange convention 0.0₍n₎xyz
 * where n is the total number of zeros after the decimal point (DexScreener style), never scientific notation.
 */
export function formatPrice(value: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs < 1e-4) {
    const zeros = Math.floor(-Math.log10(abs)); // zeros between "." and the first significant digit
    const digits = Math.round(abs * 10 ** (zeros + 4)).toString().replace(/0+$/, "") || "0";
    return `${sign}0.0${subscriptDigits(zeros)}${digits.slice(0, 4)}`;
  }
  if (abs < 1) return sign + Number(abs.toPrecision(4)).toString();
  return formatNumber(value, locale, { maximumFractionDigits: 6 });
}

/** Signed bps → "+1.23%" / "−0.40%" / "0%". Zeros are uncoloured. */
export function signedPct(
  bps: bigint | number,
  locale: string = DEFAULT_LOCALE,
): { text: string; tone: "verdigris" | "rose" | null } {
  const n = Number(bps);
  if (!Number.isFinite(n) || n === 0) return { text: "0%", tone: null };
  const pct = n / 100;
  const sign = pct > 0 ? "+" : "";
  return {
    text: `${sign}${formatNumber(pct, locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}%`,
    tone: pct > 0 ? "verdigris" : "rose",
  };
}
