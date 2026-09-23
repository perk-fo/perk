import { Hono } from "hono";
import type { AppEnv } from "../server";
import type { QuoteAsset } from "../types";
import { selectQuoteAssets } from "../../admin/queries";

/**
 * GET /v1/quote-assets → { assets: QuoteAsset[] } in picker order — max-age 15.
 *   Every quote the asset registry has listed, whether it can be used now (enabled, rewardCompatible, active bound
 *   templates, all on-chain) and how the site shows it (display, set by General Admins). A newly listed asset appears
 *   here as soon as the indexer sees its registry events, without a rebuild of the site.
 */
export function quoteAssetRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const { db, config } = c.get("deps");
    c.header("Cache-Control", "public, max-age=15");
    return c.json<{ assets: QuoteAsset[] }>({ assets: await selectQuoteAssets(db, config) });
  });
  return r;
}
