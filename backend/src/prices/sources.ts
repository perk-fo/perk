import { FetchFailedError, readBody, type FetchLike } from "../net/fetchPublic";

/**
 * Where a quote asset's US-dollar price comes from. Written as a short source string, in PRICE_SOURCES and in
 * GET /v1/prices:
 *
 *   okx:<instId>     OKX public spot ticker, `data[0].last` of
 *                    https://www.okx.com/api/v5/market/ticker?instId=<instId>. USDT (and USDC) count as US dollars.
 *   cnbc:<TICKER>    CNBC's public quote service, `FormattedQuoteResult.FormattedQuote[0].last` of
 *                    https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=<TICKER>&...,
 *                    in US dollars: the last regular-session price of a US-listed stock (cnbc:AAPL for Apple).
 *   nasdaq:<TICKER>  Nasdaq's public quote API, `data.primaryData.lastSalePrice` of
 *                    https://api.nasdaq.com/api/quote/<TICKER>/info?assetclass=stocks. An alternative to cnbc.
 *   stock:<TICKER>   cnbc, and nasdaq when cnbc does not answer. The default for tokenised stocks: each service
 *                    turns away some server addresses (CNBC answered 403 to the hosted API in September 2026).
 *   fixed:<number>   A constant, for stablecoins (fixed:1).
 *   none             No price: switches a default off.
 *
 * None of them needs a key. Hosts are fixed here; configuration only chooses the instrument, so no setting can point
 * the server elsewhere. (Stooq's CSV quotes and Yahoo's chart API were tried first: in September 2026 Stooq answered
 * 404 and Yahoo 429 to server requests.)
 */
export type PriceSource =
  | { kind: "okx"; instId: string }
  | { kind: "cnbc"; ticker: string }
  | { kind: "nasdaq"; ticker: string }
  | { kind: "stock"; ticker: string }
  | { kind: "fixed"; usd: number }
  | { kind: "none" };

/**
 * Built-in sources, which PRICE_SOURCES entries override key by key. Keys: `native` (the chain's native quote), a
 * quote address, or a quote symbol (case-insensitive).
 */
export const DEFAULT_PRICE_SOURCES: Readonly<Record<string, string>> = {
  native: "okx:OKB-USDT",
  tAAPL: "stock:AAPL",
};

/**
 * A tokenised US stock named "t" + its ticker (tAAPL, tTSLA, tNVDA): priced from the ticker's quote (stock:) unless
 * PRICE_SOURCES says otherwise, and only while General Admins have not given it a category other than "rwa".
 */
const TOKENISED_STOCK = /^t([A-Z]{1,5})$/;

const OKX_INST = /^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/;
/** A US ticker, share classes included (BRK.B, BF-B). */
const TICKER = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,2})?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A price below or above these is a broken answer, not a price. */
const MIN_USD = 1e-12;
const MAX_USD = 1e12;

const MAX_BODY_BYTES = 64 * 1024;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A source that answered, but not with a usable price. The message is short and safe to log. */
export class PriceSourceError extends Error {
  override name = "PriceSourceError";
}

/** Parse one source string. Throws with a message naming what is wrong. */
export function parsePriceSource(raw: string): PriceSource {
  const text = raw.trim();
  if (text === "none") return { kind: "none" };
  const colon = text.indexOf(":");
  const kind = colon < 0 ? text : text.slice(0, colon);
  const arg = colon < 0 ? "" : text.slice(colon + 1).trim();
  switch (kind) {
    case "okx": {
      const instId = arg.toUpperCase();
      if (!OKX_INST.test(instId)) throw new Error(`"${raw}": okx needs an instrument such as okx:OKB-USDT`);
      return { kind: "okx", instId };
    }
    case "cnbc":
    case "nasdaq":
    case "stock": {
      const ticker = arg.toUpperCase();
      if (!TICKER.test(ticker)) throw new Error(`"${raw}": ${kind} needs a US ticker such as ${kind}:AAPL`);
      return { kind, ticker };
    }
    case "fixed": {
      const usd = arg === "" ? Number.NaN : Number(arg);
      if (!Number.isFinite(usd) || usd < MIN_USD || usd > MAX_USD) {
        throw new Error(`"${raw}": fixed needs a positive number such as fixed:1`);
      }
      return { kind: "fixed", usd };
    }
    default:
      throw new Error(
        `"${raw}": unknown source (use okx:<instId>, stock:<ticker>, cnbc:<ticker>, nasdaq:<ticker>, fixed:<number> or none)`,
      );
  }
}

/** The canonical source string, as GET /v1/prices reports it. */
export function sourceText(s: PriceSource): string {
  switch (s.kind) {
    case "okx":
      return `okx:${s.instId}`;
    case "cnbc":
    case "nasdaq":
    case "stock":
      return `${s.kind}:${s.ticker}`;
    case "fixed":
      return `fixed:${s.usd}`;
    case "none":
      return "none";
  }
}

/** Sources by key, split by kind of key. Keys are lowercased. */
interface SourceTable {
  native: PriceSource | undefined;
  byAddress: Map<string, PriceSource>;
  bySymbol: Map<string, PriceSource>;
}

/** The configured sources: PRICE_SOURCES entries first, then the defaults, then the tokenised-stock rule. */
export interface PriceSourceConfig {
  configured: SourceTable;
  defaults: SourceTable;
}

function table(entries: Record<string, string>, label: string): SourceTable {
  const out: SourceTable = { native: undefined, byAddress: new Map(), bySymbol: new Map() };
  for (const [rawKey, rawSource] of Object.entries(entries)) {
    const key = rawKey.trim();
    if (key === "") throw new Error(`${label}: empty key`);
    if (typeof rawSource !== "string") throw new Error(`${label}: the source for "${key}" must be a string`);
    let source: PriceSource;
    try {
      source = parsePriceSource(rawSource);
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (key.toLowerCase() === "native") out.native = source;
    else if (ADDRESS.test(key)) out.byAddress.set(key.toLowerCase(), source);
    else out.bySymbol.set(key.toLowerCase(), source);
  }
  return out;
}

/**
 * PRICE_SOURCES: a JSON object from a quote (`native`, an address or a symbol) to a source string, merged over
 * DEFAULT_PRICE_SOURCES. Unset or empty means the defaults alone. Throws on anything malformed, so a typo stops the
 * process at boot instead of silently leaving a quote without a price.
 */
export function parsePriceSources(json: string | undefined): PriceSourceConfig {
  const defaults = table({ ...DEFAULT_PRICE_SOURCES }, "DEFAULT_PRICE_SOURCES");
  const raw = json?.trim() ?? "";
  if (raw === "") return { configured: table({}, "PRICE_SOURCES"), defaults };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PRICE_SOURCES must be a JSON object such as {"USDC":"fixed:1"}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('PRICE_SOURCES must be a JSON object such as {"USDC":"fixed:1"}');
  }
  return { configured: table(parsed as Record<string, string>, "PRICE_SOURCES"), defaults };
}

/** What the price service knows about a quote asset. */
export interface PricedQuote {
  address: string;
  symbol: string;
  isNative: boolean;
  /** General Admins' category (quote_asset_display), null when unset. */
  category: string | null;
}

function lookup(t: SourceTable, q: PricedQuote): PriceSource | undefined {
  return (
    t.byAddress.get(q.address.toLowerCase()) ??
    (q.isNative ? t.native : undefined) ??
    t.bySymbol.get(q.symbol.toLowerCase())
  );
}

/** The source for a quote, or null when it has none (no USD price is shown for it). */
export function resolveSource(cfg: PriceSourceConfig, q: PricedQuote): PriceSource | null {
  const found = lookup(cfg.configured, q) ?? lookup(cfg.defaults, q);
  if (found) return found.kind === "none" ? null : found;
  const stock = TOKENISED_STOCK.exec(q.symbol);
  if (stock && !q.isNative && (q.category === null || q.category === "rwa")) {
    return { kind: "stock", ticker: stock[1] };
  }
  return null;
}

function checkedUsd(value: number, what: string): number {
  if (!Number.isFinite(value) || value < MIN_USD || value > MAX_USD) {
    throw new PriceSourceError(`${what} is not a usable price`);
  }
  return value;
}

/** `data[0].last` of an OKX v5 ticker answer. */
export function parseOkxTicker(body: unknown): number {
  const b = body as { code?: unknown; msg?: unknown; data?: unknown } | null;
  if (!b || typeof b !== "object") throw new PriceSourceError("okx: not a JSON object");
  if (b.code !== "0") {
    const msg = typeof b.msg === "string" ? b.msg.slice(0, 120) : "";
    throw new PriceSourceError(`okx: code ${String(b.code)}${msg ? ` ${msg}` : ""}`);
  }
  const first = Array.isArray(b.data) ? (b.data[0] as { last?: unknown } | undefined) : undefined;
  if (!first || typeof first.last !== "string" || first.last.trim() === "") {
    throw new PriceSourceError("okx: no last price in the answer");
  }
  return checkedUsd(Number(first.last), "okx: last");
}

/** A price as these services write it: "335.92", "1,234.50", "$335.92". */
function priceText(v: unknown): number {
  if (typeof v !== "string" || !/^\$?\d[\d,]*(\.\d+)?$/.test(v.trim())) return Number.NaN;
  return Number(v.trim().replace(/[$,]/g, ""));
}

/** `FormattedQuoteResult.FormattedQuote[0].last` of a CNBC restQuote answer, in US dollars. */
export function parseCnbcQuote(body: unknown, ticker: string): number {
  const q = (body as { FormattedQuoteResult?: { FormattedQuote?: unknown } } | null)?.FormattedQuoteResult?.FormattedQuote;
  const first = Array.isArray(q) ? (q[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) throw new PriceSourceError("cnbc: no quote in the answer");
  if (typeof first.symbol === "string" && first.symbol.toUpperCase() !== ticker) {
    throw new PriceSourceError(`cnbc: answered for another symbol`);
  }
  if (first.code !== undefined && first.code !== 0 && first.code !== "0") throw new PriceSourceError("cnbc: unknown symbol");
  if (first.currencyCode !== undefined && first.currencyCode !== "USD") throw new PriceSourceError("cnbc: not quoted in USD");
  return checkedUsd(priceText(first.last), "cnbc: last");
}

/** `data.primaryData.lastSalePrice` of a Nasdaq quote/info answer ("$335.92"). */
export function parseNasdaqQuote(body: unknown): number {
  const b = body as { data?: { primaryData?: { lastSalePrice?: unknown; currency?: unknown } | null } | null } | null;
  const primary = b?.data?.primaryData;
  if (!primary) throw new PriceSourceError("nasdaq: no quote in the answer");
  if (typeof primary.currency === "string" && primary.currency !== "USD") {
    throw new PriceSourceError("nasdaq: not quoted in USD");
  }
  return checkedUsd(priceText(primary.lastSalePrice), "nasdaq: lastSalePrice");
}

export function sourceUrl(s: PriceSource): string | null {
  switch (s.kind) {
    case "okx":
      return `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(s.instId)}`;
    case "cnbc":
      return (
        "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol" +
        `?symbols=${encodeURIComponent(s.ticker)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
      );
    case "nasdaq":
      return `https://api.nasdaq.com/api/quote/${encodeURIComponent(s.ticker)}/info?assetclass=stocks`;
    default:
      return null;
  }
}

/**
 * The current US-dollar price from one source. One deadline (`timeoutMs`) covers the request and the body, which is
 * capped at 64 KiB. Throws PriceSourceError, FetchFailedError or the runtime's fetch error.
 */
export async function fetchUsd(
  source: PriceSource,
  opts: { fetch?: FetchLike; timeoutMs: number },
): Promise<number> {
  if (source.kind === "fixed") return source.usd;
  if (source.kind === "stock") {
    try {
      return await fetchUsd({ kind: "cnbc", ticker: source.ticker }, opts);
    } catch (first) {
      try {
        return await fetchUsd({ kind: "nasdaq", ticker: source.ticker }, opts);
      } catch (second) {
        const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
        throw new PriceSourceError(`stock: cnbc ${msg(first)}; nasdaq ${msg(second)}`);
      }
    }
  }
  const url = sourceUrl(source);
  if (url === null) throw new PriceSourceError("no source");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const deadline = Date.now() + opts.timeoutMs;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(opts.timeoutMs),
    // the stock quote services turn away clients that do not look like a browser
    headers: source.kind === "okx" ? { accept: "application/json" } : { accept: "application/json", "user-agent": BROWSER_UA },
  });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new FetchFailedError(`HTTP ${res.status}`);
  }
  const text = new TextDecoder().decode(await readBody(res, MAX_BODY_BYTES, deadline));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PriceSourceError(`${source.kind}: the answer is not JSON`);
  }
  if (source.kind === "okx") return parseOkxTicker(body);
  if (source.kind === "cnbc") return parseCnbcQuote(body, source.ticker);
  return parseNasdaqQuote(body);
}
