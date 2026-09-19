import { Hono } from "hono";
import type { AppEnv } from "../server";
import type { Stats } from "../types";
import { addr, uint } from "../serialize";
import { selectStats } from "../queries";

/** GET /v1/stats → Stats for the home ledger (activeGrants = campaigns with status ROOT_PROPOSED or ACTIVE) — max-age 10. */
export function statsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const { db, config } = c.get("deps");
    const now = Math.floor(Date.now() / 1000);
    const s = await selectStats(db, config.chainId, now);
    c.header("Cache-Control", "public, max-age=10");
    return c.json<Stats>({
      launches: s.launches,
      curveActive: s.curveActive,
      graduated: s.graduated,
      activeGrants: s.activeGrants,
      quotes: s.quotes,
      trades24h: s.trades24h,
      volume24hByQuote: s.volume24hByQuote.map((v) => ({
        quote: addr(v.quote),
        symbol: v.symbol,
        volume: uint(v.volume),
      })),
    });
  });
  return r;
}

export type { Stats };
