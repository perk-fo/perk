import { Hono } from "hono";
import { addressParam, HttpError, intParam, type AppEnv } from "../server";
import type { Candle, CandleInterval, HoldersPage, LaunchDetail, LaunchSummary, TradesPage } from "../types";
import { mapCandle, mapFeeTotals, mapGrantCampaign, mapHolder, mapLaunchDetail, mapLaunchSummary, mapTrade } from "../mappers";
import {
  launchExists,
  parseStatusList,
  parseTradeCursor,
  selectCandles,
  selectFeeTotals,
  selectGrantCampaign,
  selectHolders,
  selectLaunch,
  selectLaunchList,
  selectTrades,
} from "../queries";
import { uint } from "../serialize";

export const CANDLE_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

const INTERVALS = new Set<string>(Object.keys(CANDLE_SECONDS));

/**
 * GET /v1/launches?status=1,2,3,4&quote=0x..&creator=0x..&sort=newest|volume|progress|trades&limit=50&offset=0
 *   → { launches: LaunchSummary[], total } — max-age 5.
 * GET /v1/launches/:meme → LaunchDetail (404 if unknown) — max-age 3.
 * GET /v1/launches/:meme/trades?limit=50&before=<block>:<logIndex> → TradesPage (newest first) — max-age 3.
 * GET /v1/launches/:meme/candles?interval=1m|5m|15m|1h|4h|1d&from=<ts>&to=<ts>&limit=500 → { candles: Candle[] }
 *   buckets computed in SQL: floor(ts / seconds) * seconds; o = first price by (block_number, log_index),
 *   c = last, h = max, l = min, v = sum(quote_amount), n = count. Empty buckets are NOT filled (client does). — max-age 5.
 * GET /v1/launches/:meme/holders?limit=10 → HoldersPage: exclude holder_exclusions (excluded = true) and the
 *   zero address; circulating = total_supply − Σ excluded balances; shareBps = balance*10000/circulating. — max-age 10.
 */
export function launchRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const { db, config } = c.get("deps");
    const limit = intParam(c.req.query("limit"), 50, 1, 200, "limit");
    const offset = intParam(c.req.query("offset"), 0, 0, 100_000, "offset");
    const statuses = parseStatusList(c.req.query("status"), 0, 4);
    const quoteRaw = c.req.query("quote");
    const creatorRaw = c.req.query("creator");
    const quote = quoteRaw ? addressParam(quoteRaw, "quote") : undefined;
    const creator = creatorRaw ? addressParam(creatorRaw, "creator") : undefined;
    const sort = c.req.query("sort") ?? "newest";
    const now = Math.floor(Date.now() / 1000);
    const { rows, total } = await selectLaunchList(db, config.chainId, {
      statuses,
      quote,
      creator,
      sort,
      limit,
      offset,
      now,
    });
    c.header("Cache-Control", "public, max-age=5");
    return c.json({ launches: rows.map(mapLaunchSummary) as LaunchSummary[], total });
  });

  r.get("/:meme", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const now = Math.floor(Date.now() / 1000);
    const row = await selectLaunch(db, config.chainId, meme, now);
    if (!row) throw new HttpError(404, "not_found", "launch not found");
    const [fees, campaign] = await Promise.all([
      selectFeeTotals(db, config.chainId, meme),
      selectGrantCampaign(db, config.chainId, meme),
    ]);
    c.header("Cache-Control", "public, max-age=3");
    return c.json<LaunchDetail>(
      mapLaunchDetail(row, campaign ? mapGrantCampaign(campaign) : null, mapFeeTotals(fees)),
    );
  });

  r.get("/:meme/trades", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const limit = intParam(c.req.query("limit"), 50, 1, 200, "limit");
    if (!(await launchExists(db, config.chainId, meme))) throw new HttpError(404, "not_found", "launch not found");
    const cursor = parseTradeCursor(c.req.query("before"));
    const rows = await selectTrades(db, config.chainId, meme, limit, cursor);
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last ? `${Number(last.block_number)}:${Number(last.log_index)}` : null;
    c.header("Cache-Control", "public, max-age=3");
    return c.json<TradesPage>({ trades: rows.map(mapTrade), nextCursor });
  });

  r.get("/:meme/candles", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const intervalRaw = c.req.query("interval") ?? "5m";
    if (!INTERVALS.has(intervalRaw)) throw new HttpError(400, "bad_interval", "interval must be 1m|5m|15m|1h|4h|1d");
    const interval = intervalRaw as CandleInterval;
    const sec = CANDLE_SECONDS[interval];
    const now = Math.floor(Date.now() / 1000);
    const to = intParam(c.req.query("to"), now, 0, 10_000_000_000, "to");
    const from = intParam(c.req.query("from"), Math.max(0, to - 500 * sec), 0, 10_000_000_000, "from");
    const limit = intParam(c.req.query("limit"), 500, 1, 1000, "limit");
    if (!(await launchExists(db, config.chainId, meme))) throw new HttpError(404, "not_found", "launch not found");
    const rows = await selectCandles(db, config.chainId, meme, sec, from, to, limit);
    c.header("Cache-Control", "public, max-age=5");
    return c.json<{ candles: Candle[] }>({ candles: rows.map(mapCandle) });
  });

  r.get("/:meme/holders", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const limit = intParam(c.req.query("limit"), 10, 1, 100, "limit");
    if (!(await launchExists(db, config.chainId, meme))) throw new HttpError(404, "not_found", "launch not found");
    const page = await selectHolders(db, config.chainId, meme, limit);
    const count = page.cachedCount === page.liveCount ? page.cachedCount : page.liveCount;
    c.header("Cache-Control", "public, max-age=10");
    return c.json<HoldersPage>({
      count,
      circulating: uint(page.circulating),
      holders: page.holders.map((h) => mapHolder(h, page.circulating)),
    });
  });

  return r;
}

export type { Candle, HoldersPage, LaunchDetail, LaunchSummary, TradesPage };
