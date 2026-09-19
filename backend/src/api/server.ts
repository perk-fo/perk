import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Db } from "../db/client";
import type { AppConfig } from "../config";
import type { ApiError } from "./types";
import { healthRoutes } from "./routes/health";
import { launchRoutes } from "./routes/launches";
import { grantRoutes } from "./routes/grants";
import { walletRoutes } from "./routes/wallets";
import { statsRoutes } from "./routes/stats";
import { mediaRoutes } from "./routes/media";
import { createMediaStore, type FetchLike, type MediaStore } from "../media/store";
import { TokenBucketLimiter } from "../media/rateLimit";

export interface ApiDeps {
  db: Db;
  config: AppConfig;
  media?: MediaStore;
  fetch?: FetchLike;
  limiter?: TokenBucketLimiter;
}

export interface ResolvedApiDeps {
  db: Db;
  config: AppConfig;
  media: MediaStore;
  limiter: TokenBucketLimiter;
}

/** `ip` is the socket peer address, passed in by main.ts; routes prefer it over client-supplied headers. */
export type AppEnv = { Variables: { deps: ResolvedApiDeps }; Bindings: { ip?: string } };

const MEDIA_POST = new Set(["/v1/media/image", "/v1/media/metadata"]);

/**
 * Read-only JSON API (POST is open only for /v1/media/image and /v1/media/metadata). Every route lives
 * under /v1 except /health. Errors are { error, message } with 400 for bad input, 404 for unknown
 * launches/positions, 413/429 for media abuse, 500 otherwise (message never leaks SQL).
 * Responses carry `Cache-Control: public, max-age=N` where N is the route's freshness budget (see routes).
 */
export function createApp(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const resolved: ResolvedApiDeps = {
    db: deps.db,
    config: deps.config,
    media: deps.media ?? createMediaStore(deps.config, deps.fetch),
    limiter: deps.limiter ?? new TokenBucketLimiter(deps.config.mediaRateLimit, deps.config.mediaRateWindowMs),
  };
  app.use(
    "*",
    cors({
      origin: deps.config.corsOrigins,
      allowMethods: (_origin, c) => (MEDIA_POST.has(c.req.path) ? ["GET", "POST", "OPTIONS"] : ["GET", "OPTIONS"]),
      maxAge: 600,
    }),
  );
  app.use("*", async (c, next) => {
    c.set("deps", resolved);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json<ApiError>({ error: err.code, message: err.message }, err.status as 400);
    }
    console.error("[api]", err);
    return c.json<ApiError>({ error: "internal", message: "internal error" }, 500);
  });
  app.notFound((c) => c.json<ApiError>({ error: "not_found", message: "route not found" }, 404));

  app.route("/health", healthRoutes());
  app.route("/v1/launches", launchRoutes());
  app.route("/v1/grants", grantRoutes());
  app.route("/v1/wallets", walletRoutes());
  app.route("/v1/stats", statsRoutes());
  app.route("/v1/media", mediaRoutes());
  return app;
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validate + lowercase an address path param or throw 400. */
export function addressParam(value: string | undefined, name = "address"): `0x${string}` {
  if (!value || !ADDRESS_RE.test(value)) throw new HttpError(400, "bad_address", `${name} must be a 0x address`);
  return value.toLowerCase() as `0x${string}`;
}

/** Parse an integer query param within [min, max], with a default. */
export function intParam(value: string | undefined, fallback: number, min: number, max: number, name = "param"): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "bad_param", `${name} must be an integer in [${min}, ${max}]`);
  return n;
}
