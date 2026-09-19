import type { Address } from "./types";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Decimal string for a uint256-sized value. Numeric columns already arrive as strings; bigint
 * columns may arrive as bigint when the driver type is registered. Null becomes "0".
 */
export function uint(v: string | bigint | null): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "bigint") return v.toString();
  const s = String(v).trim();
  if (s === "" || s === "null") return "0";
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  if (whole === "" || whole === "-" || whole === "+") return "0";
  return whole;
}

/** Like uint but preserves JSON null for optional fields. */
export function uintNull(v: string | bigint | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return uint(v);
}

/** Coerce a PG scalar to a JS number (unix timestamps, counts, floats). Null → 0. */
export function num(v: string | number | bigint | boolean | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Null-preserving number. */
export function numNull(v: string | number | bigint | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}

/** Lowercase 0x-prefixed address. Null / empty → zero address. */
export function addr(v: string | null | undefined): Address {
  if (!v) return ZERO;
  return v.toLowerCase() as Address;
}

/** Lowercase hex (address, tx hash, bytes32). Null stays null. */
export function hexNull(v: string | null | undefined): `0x${string}` | null {
  if (v === null || v === undefined || v === "") return null;
  return v.toLowerCase() as `0x${string}`;
}

/** Parse a PG numeric/bigint/int into bigint for arithmetic. */
export function asBigInt(v: string | number | bigint | null | undefined, fallback = 0n): bigint {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = String(v).trim();
  if (s === "") return fallback;
  const dot = s.indexOf(".");
  const whole = (dot === -1 ? s : s.slice(0, dot)).replace(/^\+/, "");
  if (whole === "" || whole === "-") return fallback;
  try {
    return BigInt(whole);
  } catch {
    return fallback;
  }
}

/** ISO-8601 from a timestamptz column. */
export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
