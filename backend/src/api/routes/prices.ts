import { Hono } from "hono";
import type { AppEnv } from "../server";
import type { Prices } from "../types";

/**
 * GET /v1/prices → { prices: QuotePrice[] } — max-age 30.
 *   The US-dollar price of every quote asset that has one, from the background price service (src/prices). The
 *   route never waits on a price source: it serves what the last refresh kept, marked stale once no refresh has
 *   succeeded for 15 minutes. A quote without a configured source, or whose source has never answered, is absent.
 */
export function priceRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", (c) => {
    const { prices } = c.get("deps");
    c.header("Cache-Control", "public, max-age=30");
    return c.json<Prices>({ prices: prices ? prices.list() : [] });
  });
  return r;
}
