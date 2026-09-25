import type { Db } from "../db/client";
import type { Address, QuotePrice } from "../api/types";
import type { FetchLike } from "../net/fetchPublic";
import { errorText, log as defaultLog, publicErrorText } from "../log";
import { fetchUsd, resolveSource, sourceText, type PriceSource, type PriceSourceConfig, type PricedQuote } from "./sources";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface PriceServiceOptions {
  db: Db;
  chainId: number;
  sources: PriceSourceConfig;
  fetch?: FetchLike;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Milliseconds since the epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default 60 s. */
  refreshMs?: number;
  /** A price without a successful refresh for this long is marked stale. Default 15 minutes. */
  staleMs?: number;
  /** Per source request, body included. Default 5 s. */
  timeoutMs?: number;
}

interface Entry {
  quote: Address;
  symbol: string;
  source: string;
  usd: number;
  /** ms */
  updatedAt: number;
}

interface Failure {
  message: string;
  loggedAt: number;
}

/** A failing source is logged when it starts failing, when its error changes, and otherwise at most this often. */
const RELOG_MS = 15 * 60_000;

/**
 * US-dollar prices of the quote assets, kept in memory and refreshed in the background.
 *
 * Every `refreshMs` it reads the quote assets the indexer knows (quote_assets, with General Admins' categories),
 * works out each one's source (sources.ts), asks every distinct source once, in parallel, and keeps the answer. A
 * source that fails keeps its last good price, which GET /v1/prices marks stale once it is `staleMs` old; a quote
 * whose source never answered has no price at all. Nothing here runs on a request: the route only reads `list()`.
 */
export class PriceService {
  private readonly entries = new Map<string, Entry>();
  private quotes: Array<PricedQuote & { source: PriceSource | null }> = [];
  private readonly failures = new Map<string, Failure>();
  private stopped = false;
  private readonly now: () => number;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  readonly refreshMs: number;
  readonly staleMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PriceServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? defaultLog;
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.staleMs = opts.staleMs ?? 15 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** Prices known now, in quote order (native first). Stale ones are included and marked. */
  list(): QuotePrice[] {
    const now = this.now();
    const out: QuotePrice[] = [];
    for (const q of this.quotes) {
      const e = this.entries.get(q.address);
      if (!e) continue;
      out.push({
        quote: e.quote,
        symbol: e.symbol,
        usd: e.usd,
        source: e.source,
        updatedAt: Math.floor(e.updatedAt / 1000),
        stale: now - e.updatedAt > this.staleMs,
      });
    }
    return out;
  }

  /** One refresh pass. Never throws: a database or source failure is logged and the last good values stay. */
  async refresh(): Promise<void> {
    try {
      await this.loadQuotes();
    } catch (err) {
      // the quote list rarely changes; keep pricing the last one
      this.log("prices: quote assets unavailable", { error: errorText(err) });
    }
    const bySource = new Map<string, { source: PriceSource; quotes: PricedQuote[] }>();
    for (const q of this.quotes) {
      const current = this.entries.get(q.address);
      if (!q.source) {
        this.entries.delete(q.address);
        continue;
      }
      const key = sourceText(q.source);
      // a value from a source this quote no longer uses is not its price
      if (current && current.source !== key) this.entries.delete(q.address);
      const group = bySource.get(key) ?? { source: q.source, quotes: [] };
      group.quotes.push(q);
      bySource.set(key, group);
    }
    const known = new Set(this.quotes.map((q) => q.address));
    for (const address of this.entries.keys()) if (!known.has(address)) this.entries.delete(address);

    await Promise.all(
      [...bySource].map(async ([key, group]) => {
        try {
          const usd = await fetchUsd(group.source, { fetch: this.opts.fetch, timeoutMs: this.timeoutMs });
          const at = this.now();
          for (const q of group.quotes) {
            this.entries.set(q.address, { quote: q.address as Address, symbol: q.symbol, source: key, usd, updatedAt: at });
          }
          if (this.failures.delete(key)) this.log("prices: source recovered", { source: key });
        } catch (err) {
          this.noteFailure(key, err);
        }
      }),
    );
  }

  /** Refresh now and then every `refreshMs` until stop(). Never throws. */
  async run(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    while (!this.stopped) {
      await this.refresh();
      if (this.stopped) break;
      await sleep(this.refreshMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async loadQuotes(): Promise<void> {
    const rows = await this.opts.db<{ quote: string; symbol: string | null; category: string | null }[]>`
      select qa.quote, qa.symbol, d.category
      from quote_assets qa
      left join quote_asset_display d on d.chain_id = qa.chain_id and d.quote = qa.quote
      where qa.chain_id = ${this.opts.chainId}
      order by (qa.quote = ${ZERO}) desc, qa.symbol asc`;
    this.quotes = rows.map((r) => {
      const q: PricedQuote = {
        address: r.quote.toLowerCase(),
        symbol: r.symbol ?? "",
        isNative: r.quote.toLowerCase() === ZERO,
        category: r.category,
      };
      return { ...q, source: resolveSource(this.opts.sources, q) };
    });
  }

  private noteFailure(source: string, err: unknown): void {
    const message = publicErrorText(err, 200);
    const now = this.now();
    const prev = this.failures.get(source);
    if (prev && prev.message === message && now - prev.loggedAt < RELOG_MS) return;
    this.failures.set(source, { message, loggedAt: now });
    this.log("prices: source failed", { source, error: message });
  }
}
