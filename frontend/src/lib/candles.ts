/**
 * Candle building for PriceChart. Pure functions so they can be unit tested.
 *
 * Conventions (as on DEX charts):
 *   - the time axis is continuous: buckets with no trades become flat candles at the previous close (v = 0),
 *     so a quiet hour is visible as a quiet hour instead of vanishing;
 *   - each candle opens at the previous candle's close, so bodies connect;
 *   - the series runs up to the bucket containing `now`, so the chart ends at the present.
 */
export interface TradePoint {
  ts: number; // unix seconds
  price: number; // quote per meme (float, already decimal-adjusted)
  quoteVolume: number; // quote amount of the trade (float)
  side: "buy" | "sell";
  mine?: boolean; // made by the connected wallet: marked on the chart
}

export interface Candle {
  t: number; // bucket start, unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // quote volume
  buys: number; // quote volume of buys
  n: number; // trade count (0 for filler candles)
  myBuys: number; // connected wallet's buys / sells in this bucket
  mySells: number;
}

/** Readable intervals, smallest first. */
export const BUCKETS = [60, 300, 900, 1800, 3600, 4 * 3600, 86400] as const;

/** Smallest readable interval that shows `span` seconds in at most `maxCandles` candles. */
export function pickBucket(span: number, maxCandles = 96): number {
  for (const b of BUCKETS) if (span / b <= maxCandles) return b;
  return BUCKETS[BUCKETS.length - 1];
}

/**
 * Trades → continuous candles over [from, now]. `from` defaults to the first trade; trades before `from` only seed
 * the opening price. Returns [] when there is no trade at or before `now`.
 */
export function buildCandles(
  trades: TradePoint[],
  bucket: number,
  now: number,
  from?: number,
  maxCandles = 400,
): Candle[] {
  const sorted = [...trades].filter((t) => t.ts <= now).sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return [];
  const floor = (ts: number) => Math.floor(ts / bucket) * bucket;

  const start = floor(from !== undefined ? Math.max(from, sorted[0].ts) : sorted[0].ts);
  const end = Math.max(floor(now), start);
  const count = Math.min(maxCandles, (end - start) / bucket + 1);
  const first = end - (count - 1) * bucket;

  // price in force when the window opens: the last trade before it (or the first trade inside it)
  let i = 0;
  let prevClose = sorted[0].price;
  while (i < sorted.length && sorted[i].ts < first) prevClose = sorted[i++].price;

  const out: Candle[] = [];
  for (let t = first; t <= end; t += bucket) {
    const c: Candle = { t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0, buys: 0, n: 0, myBuys: 0, mySells: 0 };
    while (i < sorted.length && sorted[i].ts < t + bucket) {
      const p = sorted[i++];
      c.h = Math.max(c.h, p.price);
      c.l = Math.min(c.l, p.price);
      c.c = p.price;
      c.v += p.quoteVolume;
      if (p.side === "buy") c.buys += p.quoteVolume;
      c.n++;
      if (p.mine) p.side === "buy" ? c.myBuys++ : c.mySells++;
    }
    out.push(c);
    prevClose = c.c;
  }
  return out;
}

/** Percent change from the first candle's open to the last close. */
export function candleChange(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const o = candles[0].o;
  return o ? ((candles[candles.length - 1].c - o) / o) * 100 : 0;
}
