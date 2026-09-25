/**
 * Text from outside (contract calls, event arguments, fetched JSON) on its way into Postgres.
 *
 * Postgres `text` rejects U+0000 and `jsonb` also rejects the `\u0000` escape and unpaired surrogates, so a single such
 * string makes the statement, and with it the whole transaction, fail. Anyone can put one in a token name, so every
 * chain-derived string passes through here before it is written: control characters are removed, unpaired surrogates
 * become U+FFFD, and the length is capped.
 */

/** C0 and C1 control characters, DEL included. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Same, plus the space: none of these belongs in a URI. */
const URI_FORBIDDEN = /[\u0000- \u007f-\u009f]/;

export const NAME_MAX_CHARS = 128;
export const SYMBOL_MAX_CHARS = 32;
export const URI_MAX_CHARS = 2048;
/** Strings inside jsonb documents built from events (template structs, asset info). */
export const JSON_STRING_MAX_CHARS = 1024;

/** Cut to at most `max` code points without splitting a surrogate pair. */
export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}

/**
 * A display string (name, symbol): control characters removed, well-formed, trimmed, at most `maxChars` code points.
 * null when nothing is left or the value is not a string.
 */
export function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.toWellFormed().replace(CONTROL, "").trim();
  if (s === "") return null;
  return truncateChars(s, maxChars);
}

/**
 * A URI as a contract returned it. Not repaired, because a repaired address points somewhere else: one with a control
 * character, a space, an unpaired surrogate or more than `maxChars` characters is treated as absent (null).
 */
export function cleanUri(value: unknown, maxChars = URI_MAX_CHARS): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s.length > maxChars || URI_FORBIDDEN.test(s) || !s.isWellFormed()) return null;
  return s;
}

/**
 * A value about to be stored as jsonb: bigints become decimal strings and every string (keys included) is cleaned
 * like `cleanText`, keeping empty strings as they are.
 */
export function cleanJson(value: unknown, maxChars = JSON_STRING_MAX_CHARS): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return truncateChars(value.toWellFormed().replace(CONTROL, ""), maxChars);
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, maxChars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[truncateChars(k.toWellFormed().replace(CONTROL, ""), 128)] = cleanJson(v, maxChars);
    }
    return out;
  }
  return value;
}

/** Whether a string holds a control character (tab, line feed and carriage return allowed when `allowLineBreaks`). */
export function hasControlChars(s: string, allowLineBreaks = false): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (allowLineBreaks && (c === 0x09 || c === 0x0a || c === 0x0d)) continue;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}
