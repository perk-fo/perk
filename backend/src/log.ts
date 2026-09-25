import { BaseError, HttpRequestError } from "viem";

/**
 * Logging, and error text that leaves the process.
 *
 * Secrets are registered once (loadConfig does it for the RPC URL, the database URL and the Pinata JWT) and removed
 * from every line written to stdout and from every error text that is stored or served. The RPC URL matters most: a
 * hosted provider carries its API key in the path, and viem puts the full URL in its error messages.
 *
 * Two levels:
 *   - `redact(text)`: removes registered secrets, URL credentials, key-like query parameters and bearer tokens. For
 *     logs, which operators read.
 *   - `publicErrorText(err)`: the error's class and a short message on one line, with every URL removed as well. For
 *     anything the public can read (GET /health, WebSocket health pushes, stored error columns).
 */

const secrets = new Set<string>();
/** Registered secrets, longest first, so a URL is replaced before the key inside it. */
let ordered: string[] = [];

const MIN_SECRET_CHARS = 6;

function addSecret(value: string): void {
  if (value.length < MIN_SECRET_CHARS || secrets.has(value)) return;
  secrets.add(value);
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Remember a secret so that `redact` removes it. A URL also registers the parts of it that are secret on their own:
 * the password, long path segments (provider API keys such as Alchemy's `/v2/<key>`) and query parameter values.
 */
export function registerSecret(value: string | null | undefined): void {
  if (!value) return;
  addSecret(value);
  addSecret(value.replace(/\/+$/, ""));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!url.protocol || !url.host) return;
  addSecret(url.href);
  addSecret(url.href.replace(/\/+$/, ""));
  if (url.password) {
    addSecret(url.password);
    addSecret(decodeURIComponent(url.password));
  }
  for (const segment of url.pathname.split("/")) {
    if (segment.length >= 16) addSecret(segment);
  }
  for (const [, v] of url.searchParams) {
    if (v.length >= 8) addSecret(v);
  }
}

const REDACTED = "[redacted]";
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi;
const SECRET_PARAMS = /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|password|jwt)=)[^&\s"'#]+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Remove registered secrets and anything that looks like a credential. */
export function redact(text: string): string {
  let out = text;
  for (const s of ordered) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(SECRET_PARAMS, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`);
}

/** One line of storable text: whitespace runs become one space, other control characters go. */
function oneLine(text: string): string {
  return text
    .toWellFormed()
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/** A short description without the URL-bearing parts of viem's multi-line messages. */
function errorSummary(err: unknown): string {
  if (err instanceof BaseError) {
    const parts = [err.shortMessage];
    const http = err.walk((e) => e instanceof HttpRequestError) as HttpRequestError | null;
    if (http?.status !== undefined) parts.push(`(HTTP ${http.status})`);
    if (err.details && err.details !== err.shortMessage) parts.push(err.details);
    return parts.join(" ");
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && code !== "" ? `${code} ${err.message}` : err.message;
  }
  return String(err);
}

/** Error text safe to publish: class and short message, one line, no URLs, no secrets, at most `max` characters. */
export function publicErrorText(err: unknown, max = 300): string {
  const text = oneLine(`${errorName(err)}: ${errorSummary(err)}`).replace(ANY_URL, "[url]");
  return redact(text).slice(0, max);
}

/** An error text that was stored before it was sanitised (or by an older release): make it publishable. */
export function publicText(text: string | null, max = 300): string | null {
  if (text === null) return null;
  return redact(oneLine(text).replace(ANY_URL, "[url]")).slice(0, max);
}

/** Error text for operators: the full message, the stack of an unexpected error and its causes, redacted. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    if (e instanceof BaseError) {
      parts.push(e.message); // viem's message already lists its causes
      break;
    }
    if (e instanceof Error) {
      parts.push(depth === 0 ? (e.stack ?? `${e.name}: ${e.message}`) : `${e.name}: ${e.message}`);
      e = (e as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(e));
    break;
  }
  return redact(parts.join("\ncaused by: "));
}

/** Single-line JSON to stdout. Every line goes through `redact`. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), msg, ...fields }, (_, v) =>
    typeof v === "bigint" ? v.toString() : v instanceof Error ? errorText(v) : v,
  );
  console.log(redact(line));
}

/** Log an unexpected error with its redacted text. */
export function logError(msg: string, err: unknown, fields: Record<string, unknown> = {}): void {
  log(msg, { ...fields, error: errorText(err) });
}
