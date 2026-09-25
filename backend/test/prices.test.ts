import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../src/db/client";
import type { FetchLike } from "../src/net/fetchPublic";
import type { Prices } from "../src/api/types";
import { createApp } from "../src/api/server";
import { loadConfig } from "../src/config";
import {
  DEFAULT_PRICE_SOURCES,
  fetchUsd,
  parseCnbcQuote,
  parseNasdaqQuote,
  parseOkxTicker,
  parsePriceSource,
  parsePriceSources,
  resolveSource,
  sourceText,
  type PriceSource,
} from "../src/prices/sources";
import { PriceService } from "../src/prices/service";
import { resetDb, testConfig, TEST_DEPLOYMENT } from "./helpers";

/**
 * USD prices of quote assets (src/prices). Every fetch is a mock: nothing here reaches the network or DNS. The answer
 * bodies are the shapes the real sources returned when this was written.
 */

const CHAIN = 1952;
const NATIVE = "0x0000000000000000000000000000000000000000";
const TAAPL = "0x7f9a46e6be91ad215e4000fdb697bf2b1c079f96";
const TTSLA = "0x00000000000000000000000000000000000007e5";
const FROG = "0x00000000000000000000000000000000000000f0";
const USDC = "0x00000000000000000000000000000000000000c0";

const OKX_URL = "https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT";
const cnbcUrl = (t: string) =>
  `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${t}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
const AAPL_URL = cnbcUrl("AAPL");
const TSLA_URL = cnbcUrl("TSLA");
const NASDAQ_AAPL_URL = "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks";

const okxBody = (last: string) =>
  JSON.stringify({
    code: "0",
    data: [{ instType: "SPOT", instId: "OKB-USDT", last, lastSz: "0.017563", askPx: "119.74", ts: "1790296559073" }],
    msg: "",
  });
const cnbcBody = (last: string, symbol = "AAPL") =>
  JSON.stringify({
    FormattedQuoteResult: {
      FormattedQuote: [
        { symbol, symbolType: "symbol", code: 0, name: "Apple Inc.", last, last_time: "2026-09-24T16:00:00.000-0400", currencyCode: "USD", exchange: "NASDAQ" },
      ],
    },
  });
const nasdaqBody = (lastSalePrice: string) =>
  JSON.stringify({
    data: { symbol: "AAPL", primaryData: { lastSalePrice, netChange: "-1.10", isRealTime: false, currency: null }, marketStatus: "Closed" },
    message: null,
    status: { rCode: 200 },
  });
/** What Stooq's CSV quote URL answered in September 2026: an HTML page, not a price. */
const STOOQ_NOT_FOUND =
  "<meta charset=utf-8><title>Stooq</title><center style=font-family:arial;margin-top:50px><p>The page you requested does not exist<br>or has been moved";

type Handler = (url: string) => Response | Promise<Response>;

/** A fetch that answers from `routes` and records every URL; an unknown URL is a test failure. */
function mockFetch(routes: Record<string, Handler>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    const h = routes[url];
    if (!h) throw new Error(`unexpected fetch ${url}`);
    return h(url);
  };
  return { fetch, calls };
}

const text = (body: string, status = 200) => () => new Response(body, { status });

describe("price sources", () => {
  test("test_parsePriceSource_forms", () => {
    expect(parsePriceSource("okx:okb-usdt")).toEqual({ kind: "okx", instId: "OKB-USDT" });
    expect(parsePriceSource(" cnbc:aapl ")).toEqual({ kind: "cnbc", ticker: "AAPL" });
    expect(parsePriceSource("nasdaq:BRK.B")).toEqual({ kind: "nasdaq", ticker: "BRK.B" });
    expect(sourceText(parsePriceSource("cnbc:aapl"))).toBe("cnbc:AAPL");
    expect(parsePriceSource("fixed:1")).toEqual({ kind: "fixed", usd: 1 });
    expect(parsePriceSource("fixed:0.9995")).toEqual({ kind: "fixed", usd: 0.9995 });
    expect(parsePriceSource("none")).toEqual({ kind: "none" });
    expect(sourceText(parsePriceSource("okx:okb-usdt"))).toBe("okx:OKB-USDT");
    expect(sourceText(parsePriceSource("fixed:1"))).toBe("fixed:1");
  });

  test("test_parsePriceSource_reverts_malformed", () => {
    for (const bad of [
      "",
      "okx",
      "okx:",
      "okx:OKB/USDT",
      "okx:OKB-USDT&x=1",
      "cnbc:",
      "cnbc:AAPL&symbols=X",
      "cnbc:../x",
      "nasdaq:AAPL/info",
      "nasdaq:1ABC",
      "stooq:aapl.us",
      "yahoo:AAPL",
      "fixed:",
      "fixed:0",
      "fixed:-1",
      "fixed:abc",
      "fixed:Infinity",
      "https://evil.example/price",
      "coingecko:okb",
    ]) {
      expect(() => parsePriceSource(bad)).toThrow();
    }
  });

  test("test_parsePriceSources_defaultsAndOverrides", () => {
    const defaults = parsePriceSources(undefined);
    const native = { address: NATIVE, symbol: "OKB", isNative: true, category: null };
    const aapl = { address: TAAPL, symbol: "tAAPL", isNative: false, category: null };
    expect(resolveSource(defaults, native)).toEqual({ kind: "okx", instId: "OKB-USDT" });
    expect(resolveSource(defaults, aapl)).toEqual({ kind: "stock", ticker: "AAPL" });
    expect(Object.keys(DEFAULT_PRICE_SOURCES)).toEqual(["native", "tAAPL"]);
    expect(parsePriceSources("  ")).toEqual(defaults);

    // an entry overrides the default for the same quote, by any kind of key; the other defaults stay
    const cfg = parsePriceSources(JSON.stringify({ OKB: "fixed:100", [USDC.toUpperCase().replace("0X", "0x")]: "fixed:1" }));
    expect(resolveSource(cfg, native)).toEqual({ kind: "fixed", usd: 100 });
    expect(resolveSource(cfg, aapl)).toEqual({ kind: "stock", ticker: "AAPL" });
    expect(resolveSource(cfg, { address: USDC, symbol: "USDC", isNative: false, category: "stablecoin" })).toEqual({
      kind: "fixed",
      usd: 1,
    });
    // an address key beats a symbol key
    const both = parsePriceSources(JSON.stringify({ tAAPL: "fixed:2", [TAAPL]: "fixed:3" }));
    expect(resolveSource(both, aapl)).toEqual({ kind: "fixed", usd: 3 });
    // "none" switches a default off
    const off = parsePriceSources(JSON.stringify({ native: "none", tAAPL: "none" }));
    expect(resolveSource(off, native)).toBeNull();
    expect(resolveSource(off, aapl)).toBeNull();
    // an ERC-20 called OKB is not the native quote
    expect(resolveSource(defaults, { address: USDC, symbol: "OKB", isNative: false, category: null })).toBeNull();
  });

  test("test_resolveSource_tokenisedStocks", () => {
    const cfg = parsePriceSources(undefined);
    const stock = (symbol: string, category: string | null = null) =>
      resolveSource(cfg, { address: TTSLA, symbol, isNative: false, category });
    expect(stock("tTSLA")).toEqual({ kind: "stock", ticker: "TSLA" });
    expect(stock("tNVDA", "rwa")).toEqual({ kind: "stock", ticker: "NVDA" });
    // only "t" + an upper-case ticker, and only while admins have not called it something else
    expect(stock("tTSLA", "stablecoin")).toBeNull();
    expect(stock("TSLA")).toBeNull();
    expect(stock("ttsla")).toBeNull();
    expect(stock("tTOOLONG")).toBeNull();
    expect(stock("FROG")).toBeNull();
    expect(resolveSource(cfg, { address: NATIVE, symbol: "tOKB", isNative: true, category: null })).toEqual({
      kind: "okx",
      instId: "OKB-USDT",
    });
  });

  test("test_parsePriceSources_reverts_malformed", () => {
    expect(() => parsePriceSources("{")).toThrow(/PRICE_SOURCES/);
    expect(() => parsePriceSources("[]")).toThrow(/PRICE_SOURCES/);
    expect(() => parsePriceSources('"okx:OKB-USDT"')).toThrow(/PRICE_SOURCES/);
    expect(() => parsePriceSources('{"USDC":"fixed:0"}')).toThrow(/PRICE_SOURCES.*fixed/);
    expect(() => parsePriceSources('{"USDC":1}')).toThrow(/PRICE_SOURCES.*string/);
    expect(() => parsePriceSources('{" ":"fixed:1"}')).toThrow(/PRICE_SOURCES.*empty key/);
  });

  test("test_loadConfig_reverts_badPriceSources", () => {
    const saved = process.env.PRICE_SOURCES;
    const base = {
      chainId: CHAIN,
      deployment: TEST_DEPLOYMENT,
      rpcUrl: "http://mock",
      databaseUrl: "postgres://localhost:5432/perk_test",
      publicApiUrl: "http://localhost:8787",
      mediaDriver: "local" as const,
      pinataJwt: undefined,
    };
    try {
      process.env.PRICE_SOURCES = '{"USDC":"coingecko:usdc"}';
      expect(() => loadConfig(base)).toThrow(/PRICE_SOURCES/);
      process.env.PRICE_SOURCES = '{"USDC":"fixed:1"}';
      const cfg = loadConfig(base);
      expect(resolveSource(cfg.priceSources, { address: USDC, symbol: "USDC", isNative: false, category: null })).toEqual({
        kind: "fixed",
        usd: 1,
      });
    } finally {
      if (saved === undefined) delete process.env.PRICE_SOURCES;
      else process.env.PRICE_SOURCES = saved;
    }
  });

  test("test_parseOkxTicker", () => {
    expect(parseOkxTicker(JSON.parse(okxBody("119.73")))).toBe(119.73);
    expect(() => parseOkxTicker({ code: "51001", msg: "Instrument ID does not exist", data: [] })).toThrow(/51001/);
    expect(() => parseOkxTicker({ code: "0", data: [] })).toThrow(/no last price/);
    expect(() => parseOkxTicker({ code: "0", data: [{ last: "" }] })).toThrow(/no last price/);
    expect(() => parseOkxTicker(JSON.parse(okxBody("0")))).toThrow(/usable/);
    expect(() => parseOkxTicker(JSON.parse(okxBody("-3")))).toThrow(/usable/);
    expect(() => parseOkxTicker(JSON.parse(okxBody("NaN")))).toThrow(/usable/);
    expect(() => parseOkxTicker(null)).toThrow();
  });

  test("test_parseCnbcQuote", () => {
    expect(parseCnbcQuote(JSON.parse(cnbcBody("335.92")), "AAPL")).toBe(335.92);
    expect(parseCnbcQuote(JSON.parse(cnbcBody("1,234.50")), "AAPL")).toBe(1234.5);
    expect(() => parseCnbcQuote(JSON.parse(cnbcBody("335.92", "MSFT")), "AAPL")).toThrow(/another symbol/);
    expect(() => parseCnbcQuote({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "AAPLX", code: 1 }] } }, "AAPLX")).toThrow(
      /unknown symbol/,
    );
    const eur = JSON.parse(cnbcBody("335.92"));
    eur.FormattedQuoteResult.FormattedQuote[0].currencyCode = "EUR";
    expect(() => parseCnbcQuote(eur, "AAPL")).toThrow(/USD/);
    expect(() => parseCnbcQuote(JSON.parse(cnbcBody("0")), "AAPL")).toThrow(/usable/);
    expect(() => parseCnbcQuote(JSON.parse(cnbcBody("UNCH")), "AAPL")).toThrow(/usable/);
    expect(() => parseCnbcQuote({ FormattedQuoteResult: { FormattedQuote: [] } }, "AAPL")).toThrow(/no quote/);
    expect(() => parseCnbcQuote(null, "AAPL")).toThrow(/no quote/);
  });

  test("test_parseNasdaqQuote", () => {
    expect(parseNasdaqQuote(JSON.parse(nasdaqBody("$335.92")))).toBe(335.92);
    expect(parseNasdaqQuote(JSON.parse(nasdaqBody("$1,234.5")))).toBe(1234.5);
    expect(() => parseNasdaqQuote({ data: null, status: { rCode: 400 } })).toThrow(/no quote/);
    expect(() => parseNasdaqQuote(JSON.parse(nasdaqBody("N/A")))).toThrow(/usable/);
    expect(() => parseNasdaqQuote(JSON.parse(nasdaqBody("$0.00")))).toThrow(/usable/);
  });

  test("test_fetchUsd_stockFallsBackToNasdaq", async () => {
    // CNBC turned the hosted API away with 403 in September 2026; the stock source then asks Nasdaq
    const { fetch, calls } = mockFetch({ [AAPL_URL]: text("denied", 403), [NASDAQ_AAPL_URL]: text(nasdaqBody("$231.40")) });
    expect(await fetchUsd(parsePriceSource("stock:aapl"), { fetch, timeoutMs: 1000 })).toBe(231.4);
    expect(calls).toEqual([AAPL_URL, NASDAQ_AAPL_URL]);
    // CNBC answering is enough
    const ok = mockFetch({ [AAPL_URL]: text(cnbcBody("230.10")) });
    expect(await fetchUsd(parsePriceSource("stock:AAPL"), { fetch: ok.fetch, timeoutMs: 1000 })).toBe(230.1);
    expect(ok.calls).toEqual([AAPL_URL]);
    // both failing names both
    const bad = mockFetch({ [AAPL_URL]: text("denied", 403), [NASDAQ_AAPL_URL]: text("denied", 403) });
    await expect(fetchUsd(parsePriceSource("stock:AAPL"), { fetch: bad.fetch, timeoutMs: 1000 })).rejects.toThrow(
      /stock: cnbc .*403.*nasdaq .*403/,
    );
    expect(sourceText(parsePriceSource("stock:aapl"))).toBe("stock:AAPL");
  });

  test("test_fetchUsd_requestsTheFixedHosts", async () => {
    const { fetch, calls } = mockFetch({
      [OKX_URL]: text(okxBody("119.73")),
      [AAPL_URL]: text(cnbcBody("335.92")),
      [NASDAQ_AAPL_URL]: text(nasdaqBody("$335.90")),
    });
    const agents: Array<string | null> = [];
    const recording: FetchLike = (input, init) => {
      agents.push(new Headers(init?.headers).get("user-agent"));
      return fetch(input, init);
    };
    expect(await fetchUsd(parsePriceSource("okx:OKB-USDT"), { fetch: recording, timeoutMs: 1000 })).toBe(119.73);
    expect(await fetchUsd(parsePriceSource("cnbc:AAPL"), { fetch: recording, timeoutMs: 1000 })).toBe(335.92);
    expect(await fetchUsd(parsePriceSource("nasdaq:AAPL"), { fetch: recording, timeoutMs: 1000 })).toBe(335.9);
    expect(await fetchUsd(parsePriceSource("fixed:1"), { fetch: recording, timeoutMs: 1000 })).toBe(1);
    expect(calls).toEqual([OKX_URL, AAPL_URL, NASDAQ_AAPL_URL]);
    // the stock quote services turn away clients that do not look like a browser
    expect(agents[0]).toBeNull();
    expect(agents[1]).toMatch(/^Mozilla\/5\.0/);
    expect(agents[2]).toMatch(/^Mozilla\/5\.0/);
  });

  test("test_fetchUsd_reverts_badAnswers", async () => {
    const okx = parsePriceSource("okx:OKB-USDT");
    const aapl = parsePriceSource("cnbc:AAPL");
    const run = (h: Handler, s: PriceSource = okx, timeoutMs = 1000) =>
      fetchUsd(s, { fetch: mockFetch({ [OKX_URL]: h, [AAPL_URL]: h }).fetch, timeoutMs });
    await expect(run(text("busy", 503))).rejects.toThrow(/HTTP 503/);
    await expect(run(text("<html>"))).rejects.toThrow(/not JSON/);
    await expect(run(text(STOOQ_NOT_FOUND), aapl)).rejects.toThrow(/cnbc: the answer is not JSON/);
    await expect(run(text("x".repeat(70 * 1024)), aapl)).rejects.toThrow(/exceeds/);
    // a source that never answers is given up on at the deadline
    const hanging: FetchLike = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const started = Date.now();
    await expect(fetchUsd(okx, { fetch: hanging, timeoutMs: 50 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("PriceService", () => {
  let db: Db;
  let now: number;
  let logs: Array<{ msg: string; fields?: Record<string, unknown> }>;
  const log = (msg: string, fields?: Record<string, unknown>) => void logs.push({ msg, fields });

  beforeAll(async () => {
    db = await resetDb();
    await db`
      insert into quote_assets (chain_id, quote, symbol, name, decimals, kind, allowed) values
        (${CHAIN}, ${NATIVE}, 'OKB', 'OKB', 18, 0, true),
        (${CHAIN}, ${TAAPL}, 'tAAPL', 'Mock tAAPL', 6, 1, true),
        (${CHAIN}, ${TTSLA}, 'tTSLA', 'Mock tTSLA', 6, 1, true),
        (${CHAIN}, ${FROG}, 'FROG', 'Mock FROG', 18, 1, true),
        (${CHAIN}, ${USDC}, 'USDC', 'USD Coin', 6, 1, true),
        (${CHAIN + 1}, ${NATIVE}, 'OKB', 'OKB', 18, 0, true)`;
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  beforeEach(() => {
    now = Date.UTC(2026, 8, 25, 12, 0, 0);
    logs = [];
  });

  afterEach(async () => {
    await db`delete from quote_asset_display`;
  });

  function service(fetch: FetchLike, sources = parsePriceSources('{"USDC":"fixed:1"}')) {
    return new PriceService({ db, chainId: CHAIN, sources, fetch, log, now: () => now, timeoutMs: 200 });
  }

  const healthy = () =>
    mockFetch({
      [OKX_URL]: text(okxBody("119.73")),
      [AAPL_URL]: text(cnbcBody("335.92")),
      [TSLA_URL]: text(cnbcBody("431.5", "TSLA")),
    });

  test("test_refresh_pricesEveryQuoteWithASource", async () => {
    const { fetch, calls } = healthy();
    const prices = service(fetch);
    expect(prices.list()).toEqual([]);
    await prices.refresh();
    const at = Math.floor(now / 1000);
    expect(prices.list()).toEqual([
      { quote: NATIVE, symbol: "OKB", usd: 119.73, source: "okx:OKB-USDT", updatedAt: at, stale: false },
      { quote: USDC, symbol: "USDC", usd: 1, source: "fixed:1", updatedAt: at, stale: false },
      { quote: TAAPL, symbol: "tAAPL", usd: 335.92, source: "stock:AAPL", updatedAt: at, stale: false },
      { quote: TTSLA, symbol: "tTSLA", usd: 431.5, source: "stock:TSLA", updatedAt: at, stale: false },
    ]);
    // FROG has no source and is simply absent; the other chain's quotes are not read
    expect(prices.list().some((p) => p.quote === FROG)).toBe(false);
    expect([...calls].sort()).toEqual([AAPL_URL, OKX_URL, TSLA_URL].sort());
    expect(logs).toEqual([]);
  });

  test("test_refresh_asksEachSourceOnce", async () => {
    const { fetch, calls } = healthy();
    // two quotes on one source: one request
    const prices = service(fetch, parsePriceSources(JSON.stringify({ tTSLA: "stock:AAPL", USDC: "fixed:1" })));
    await prices.refresh();
    expect(calls.filter((u) => u === AAPL_URL)).toHaveLength(1);
    expect(calls).not.toContain(TSLA_URL);
    const tsla = prices.list().find((p) => p.quote === TTSLA)!;
    expect(tsla.usd).toBe(335.92);
    expect(tsla.source).toBe("stock:AAPL");
  });

  test("test_refresh_keepsLastGoodValue_thenMarksItStale", async () => {
    let okxUp = true;
    const { fetch } = mockFetch({
      [OKX_URL]: () => (okxUp ? new Response(okxBody("119.73")) : new Response("gateway", { status: 502 })),
      [AAPL_URL]: text(cnbcBody("335.92")),
      [TSLA_URL]: text(STOOQ_NOT_FOUND),
      "https://api.nasdaq.com/api/quote/TSLA/info?assetclass=stocks": text("denied", 403),
    });
    const prices = service(fetch);
    await prices.refresh();
    const firstAt = Math.floor(now / 1000);
    // an HTML error page is not a price: tTSLA has none, and the failure is logged once
    expect(prices.list().some((p) => p.quote === TTSLA)).toBe(false);
    expect(logs).toEqual([{ msg: "prices: source failed", fields: { source: "stock:TSLA", error: expect.stringContaining("not JSON") } }]);

    okxUp = false;
    now += 5 * 60_000;
    await prices.refresh();
    let okb = prices.list().find((p) => p.quote === NATIVE)!;
    expect(okb).toEqual({ quote: NATIVE, symbol: "OKB", usd: 119.73, source: "okx:OKB-USDT", updatedAt: firstAt, stale: false });
    expect(prices.list().find((p) => p.quote === TAAPL)!.updatedAt).toBe(Math.floor(now / 1000));

    // still failing, 16 minutes after the last good answer: the value stays, marked stale
    now += 11 * 60_000;
    await prices.refresh();
    okb = prices.list().find((p) => p.quote === NATIVE)!;
    expect(okb.usd).toBe(119.73);
    expect(okb.stale).toBe(true);
    expect(prices.list().find((p) => p.quote === TAAPL)!.stale).toBe(false);
    // the same error is not logged every minute
    expect(logs.filter((l) => l.fields?.source === "okx:OKB-USDT").map((l) => l.msg)).toEqual(["prices: source failed"]);
    expect(logs.filter((l) => l.fields?.source === "stock:TSLA")).toHaveLength(2); // again after 15 minutes

    okxUp = true;
    now += 60_000;
    await prices.refresh();
    okb = prices.list().find((p) => p.quote === NATIVE)!;
    expect(okb.stale).toBe(false);
    expect(okb.updatedAt).toBe(Math.floor(now / 1000));
    expect(logs.at(-1)).toEqual({ msg: "prices: source recovered", fields: { source: "okx:OKB-USDT" } });
  });

  test("test_refresh_neverKeepsAZeroOrBrokenPrice", async () => {
    let body = okxBody("119.73");
    const { fetch } = mockFetch({
      [OKX_URL]: () => new Response(body),
      [AAPL_URL]: text(cnbcBody("335.92")),
      [TSLA_URL]: text(cnbcBody("431.5", "TSLA")),
    });
    const prices = service(fetch);
    for (const bad of [okxBody("0"), okxBody("-1"), okxBody("abc"), "{}"]) {
      body = bad;
      await prices.refresh();
      expect(prices.list().some((p) => p.quote === NATIVE)).toBe(false);
    }
    body = okxBody("119.73");
    await prices.refresh();
    body = okxBody("0");
    await prices.refresh();
    expect(prices.list().find((p) => p.quote === NATIVE)!.usd).toBe(119.73);
  });

  test("test_refresh_dropsAPriceWhoseSourceNoLongerApplies", async () => {
    const { fetch } = healthy();
    const prices = service(fetch);
    await prices.refresh();
    expect(prices.list().some((p) => p.quote === TTSLA)).toBe(true);
    // General Admins file tTSLA under another category: the stock rule no longer applies, so neither does its price
    await db`insert into quote_asset_display (chain_id, quote, category, notice, sort_order, listed, updated_by, updated_at)
      values (${CHAIN}, ${TTSLA}, 'other', ${db.json({})}, 0, true, ${NATIVE}, now())`;
    await prices.refresh();
    expect(prices.list().some((p) => p.quote === TTSLA)).toBe(false);
  });

  test("test_refresh_survivesADatabaseFailure", async () => {
    const { fetch } = healthy();
    const prices = service(fetch);
    await prices.refresh();
    const broken = new PriceService({
      db: (() => Promise.reject(new Error("db down"))) as unknown as Db,
      chainId: CHAIN,
      sources: parsePriceSources(undefined),
      fetch,
      log,
      now: () => now,
    });
    await broken.refresh(); // does not throw
    expect(broken.list()).toEqual([]);
    expect(logs.at(-1)?.msg).toBe("prices: quote assets unavailable");
  });

  test("test_run_refreshesUntilStopped", async () => {
    const { fetch, calls } = healthy();
    const prices = service(fetch);
    let sleeps = 0;
    const running = new PriceService({
      db,
      chainId: CHAIN,
      sources: parsePriceSources(undefined),
      fetch,
      log,
      now: () => now,
      sleep: async (ms) => {
        expect(ms).toBe(60_000);
        if (++sleeps === 2) running.stop();
      },
    });
    await running.run();
    expect(calls.filter((u) => u === OKX_URL)).toHaveLength(2);
    expect(prices.refreshMs).toBe(60_000);
    expect(prices.staleMs).toBe(15 * 60_000);
  });

  test("test_getPrices_route", async () => {
    const { fetch } = healthy();
    const prices = service(fetch);
    await prices.refresh();
    const app = createApp({ db, config: testConfig(), prices });
    const res = await app.request("/v1/prices");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const body = (await res.json()) as Prices;
    expect(body.prices.map((p) => [p.symbol, p.usd, p.stale])).toEqual([
      ["OKB", 119.73, false],
      ["USDC", 1, false],
      ["tAAPL", 335.92, false],
      ["tTSLA", 431.5, false],
    ]);
    // without a price service the route answers, with no prices
    const bare = createApp({ db, config: testConfig() });
    expect(await (await bare.request("/v1/prices")).json()).toEqual({ prices: [] });
  });

  test("test_getPrices_route_neverWaitsOnASource", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let slow = false;
    const { fetch } = mockFetch({
      [OKX_URL]: async () => {
        if (slow) await gate;
        return new Response(okxBody(slow ? "120" : "119.73"));
      },
      [AAPL_URL]: text(cnbcBody("335.92")),
      [TSLA_URL]: text(cnbcBody("431.5", "TSLA")),
    });
    const prices = new PriceService({
      db,
      chainId: CHAIN,
      sources: parsePriceSources(undefined),
      fetch,
      log,
      now: () => now,
      timeoutMs: 10_000,
    });
    await prices.refresh();
    slow = true;
    const pending = prices.refresh(); // OKX now hangs
    const app = createApp({ db, config: testConfig(), prices });
    const started = Date.now();
    const body = (await (await app.request("/v1/prices")).json()) as Prices;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(body.prices.find((p) => p.symbol === "OKB")!.usd).toBe(119.73);
    release();
    await pending;
    expect(prices.list().find((p) => p.symbol === "OKB")!.usd).toBe(120);
  });
});
