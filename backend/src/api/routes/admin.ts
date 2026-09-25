import { Hono, type Context } from "hono";
import { isHex, type Hex } from "viem";
import { addressParam, HttpError, intParam, type AppEnv } from "../server";
import type {
  AdminLaunch,
  AdminMe,
  AdminNonce,
  AdminRole,
  AdminSession,
  ModerationUpdate,
  QuoteCategory,
  QuoteDisplayUpdate,
  QuoteNotice,
} from "../types";
import { clientKey } from "../clientIp";
import { AuthError, createSession, endSession, endSessionsOf, issueNonce, sessionFor, verifyLogin } from "../../admin/auth";
import { authoritativeRoleHolders, selectAdminRoles, type RoleHolders } from "../../admin/roles";
import { logError } from "../../log";
import { hasControlChars } from "../../db/text";
import {
  audit,
  deleteOperator,
  existingLaunches,
  insertOperator,
  quoteAssetExists,
  replaceFeatured,
  searchLaunches,
  selectAdminLaunch,
  selectAudit,
  selectFeatured,
  selectModerated,
  selectOperators,
  selectQuoteAssets,
  upsertModeration,
  upsertQuoteDisplay,
} from "../../admin/queries";

/** Who may call what. The Core Admin can do everything a General Admin can. */
const ANY: AdminRole[] = ["core", "grant", "operator"];
const CURATORS: AdminRole[] = ["core", "operator"];
const CORE: AdminRole[] = ["core"];

export const MAX_FEATURED = 12;

/**
 * /v1/admin. Sign-in, then every other route takes `Authorization: Bearer <token>`; roles are checked on each call.
 * The on-chain roles (Core Admin, Grant Admin) are read from the contracts, never from the index, which lags the chain
 * and replays former owners while it is rebuilt; when the chain cannot be read the routes answer 503. General Admins,
 * sessions and the audit log belong to the API's chain.
 *   POST /auth/nonce {address}               → AdminNonce: a sign-in message to sign (needs an allowed Origin)
 *   POST /auth/login {message, signature}    → AdminSession (403 unless the wallet holds an admin role)
 *   POST /auth/logout
 *   GET  /me                                 → AdminMe                                   any admin
 *   GET  /operators, POST /operators {address}, DELETE /operators/:address           Core Admin
 *   GET  /audit?limit=                       → { entries }                               Core Admin
 *   GET  /launches?q=                        → { launches: AdminLaunch[] }               Core Admin, General Admin
 *   GET  /moderation, PUT /moderation/:meme ModerationUpdate                             Core Admin, General Admin
 *   GET  /featured, PUT /featured {memes}                                                Core Admin, General Admin
 *   PUT  /quote-assets/:quote QuoteDisplayUpdate                                          Core Admin, General Admin
 * Responses are never cached.
 */
export function adminRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  r.post("/auth/nonce", async (c) => {
    const { db, config } = c.get("deps");
    limit(c);
    const origin = siteOrigin(c);
    const body = await jsonBody(c);
    const address = addressParam(typeof body.address === "string" ? body.address : undefined);
    const { message, expiresAt } = await issueNonce(db, { address, chainId: config.chainId, origin });
    return c.json<AdminNonce>({ message, expiresAt: unix(expiresAt) });
  });

  r.post("/auth/login", async (c) => {
    const { db, config, client } = c.get("deps");
    limit(c);
    const origin = siteOrigin(c);
    const body = await jsonBody(c);
    const message = body.message;
    const signature = body.signature;
    if (typeof message !== "string" || message.length === 0 || message.length > 2_000 || message.includes("\u0000")) {
      throw new HttpError(400, "bad_message", "message must be the sign-in message");
    }
    if (typeof signature !== "string" || !isHex(signature) || signature.length > 20_000) {
      throw new HttpError(400, "bad_signature", "signature must be hex");
    }
    let address: string;
    try {
      ({ address } = await verifyLogin(db, client, { message, signature: signature as Hex, chainId: config.chainId, origin }));
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.code, err.message);
      throw err;
    }
    const roles = await selectAdminRoles(db, config.chainId, address, await chainRoleHolders(c));
    if (roles.length === 0) throw new HttpError(403, "not_admin", "this wallet holds no admin role");
    const session = await createSession(db, config.chainId, address);
    await audit(db, config.chainId, address, "sign_in", null, { roles });
    return c.json<AdminSession>({
      token: session.token,
      address: address.toLowerCase() as `0x${string}`,
      roles,
      expiresAt: unix(session.expiresAt),
    });
  });

  r.post("/auth/logout", async (c) => {
    const { db, config } = c.get("deps");
    await endSession(db, config.chainId, c.req.header("authorization"));
    return c.json({ ok: true });
  });

  r.get("/me", async (c) => {
    const me = await requireRole(c, ANY);
    return c.json<AdminMe>({ address: me.address, roles: me.roles, expiresAt: unix(me.expiresAt) });
  });

  // ---- General Admins (Core Admin)

  r.get("/operators", async (c) => {
    await requireRole(c, CORE);
    const { db, config } = c.get("deps");
    return c.json({ operators: await selectOperators(db, config.chainId) });
  });

  r.post("/operators", async (c) => {
    const me = await requireRole(c, CORE);
    const { db, config } = c.get("deps");
    const body = await jsonBody(c);
    const address = addressParam(typeof body.address === "string" ? body.address : undefined);
    if (await insertOperator(db, config.chainId, address, me.address)) {
      await audit(db, config.chainId, me.address, "operator_add", address);
    }
    return c.json({ operators: await selectOperators(db, config.chainId) });
  });

  r.delete("/operators/:address", async (c) => {
    const me = await requireRole(c, CORE);
    const { db, config } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    if (await deleteOperator(db, config.chainId, address)) {
      await endSessionsOf(db, config.chainId, address);
      await audit(db, config.chainId, me.address, "operator_remove", address);
    }
    return c.json({ operators: await selectOperators(db, config.chainId) });
  });

  r.get("/audit", async (c) => {
    await requireRole(c, CORE);
    const { db, config } = c.get("deps");
    const n = intParam(c.req.query("limit"), 50, 1, 200, "limit");
    return c.json({ entries: await selectAudit(db, config.chainId, n) });
  });

  // ---- moderation (Core Admin, General Admin)

  r.get("/launches", async (c) => {
    await requireRole(c, CURATORS);
    const { db, config } = c.get("deps");
    const q = (c.req.query("q") ?? "").replace(/[\u0000-\u001f]/g, "").toWellFormed().slice(0, 80);
    const launches = await searchLaunches(db, config.chainId, q, now());
    return c.json<{ launches: AdminLaunch[] }>({ launches });
  });

  r.get("/moderation", async (c) => {
    await requireRole(c, CURATORS);
    const { db, config } = c.get("deps");
    return c.json<{ launches: AdminLaunch[] }>({ launches: await selectModerated(db, config.chainId, now()) });
  });

  r.put("/moderation/:meme", async (c) => {
    const me = await requireRole(c, CURATORS);
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const update = parseModeration(await jsonBody(c));
    if (!(await selectAdminLaunch(db, config.chainId, meme, now()))) throw new HttpError(404, "not_found", "launch not found");
    await upsertModeration(db, config.chainId, meme, update, me.address);
    await audit(db, config.chainId, me.address, "moderation", meme, update);
    return c.json<AdminLaunch>((await selectAdminLaunch(db, config.chainId, meme, now()))!);
  });

  // ---- featured (Core Admin, General Admin)

  r.get("/featured", async (c) => {
    await requireRole(c, CURATORS);
    return c.json<{ launches: AdminLaunch[] }>({ launches: await featuredForAdmin(c) });
  });

  r.put("/featured", async (c) => {
    const me = await requireRole(c, CURATORS);
    const { db, config } = c.get("deps");
    const body = await jsonBody(c);
    if (!Array.isArray(body.memes)) throw new HttpError(400, "bad_param", "memes must be a list of addresses");
    if (body.memes.length > MAX_FEATURED) throw new HttpError(400, "bad_param", `at most ${MAX_FEATURED} featured launches`);
    const memes = body.memes.map((m: unknown) => addressParam(typeof m === "string" ? m : undefined, "meme"));
    if (new Set(memes).size !== memes.length) throw new HttpError(400, "bad_param", "a launch appears twice");
    const known = await existingLaunches(db, config.chainId, memes);
    const missing = memes.find((m: string) => !known.has(m));
    if (missing) throw new HttpError(404, "not_found", `launch not found: ${missing}`);
    await replaceFeatured(db, config.chainId, memes, me.address);
    await audit(db, config.chainId, me.address, "featured", null, { memes });
    return c.json<{ launches: AdminLaunch[] }>({ launches: await featuredForAdmin(c) });
  });

  // ---- quote currency display (Core Admin, General Admin)

  r.put("/quote-assets/:quote", async (c) => {
    const me = await requireRole(c, CURATORS);
    const { db, config } = c.get("deps");
    const quote = addressParam(c.req.param("quote"), "quote");
    const display = parseQuoteDisplay(await jsonBody(c), config.publicApiUrl);
    if (!(await quoteAssetExists(db, config.chainId, quote))) throw new HttpError(404, "not_found", "quote asset not found");
    await upsertQuoteDisplay(db, config.chainId, quote, display, me.address);
    await audit(db, config.chainId, me.address, "quote_display", quote, display);
    const asset = (await selectQuoteAssets(db, config)).find((a) => a.address === quote);
    return c.json(asset);
  });

  return r;
}

// ---------------------------------------------------------------- helpers

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function limit(c: Context<AppEnv>): void {
  const { authLimiter } = c.get("deps");
  if (!authLimiter.take(clientKey(c))) throw new HttpError(429, "rate_limited", "rate limited");
}

/** Who holds the on-chain roles right now, from the contracts. 503 when the chain cannot be read. */
async function chainRoleHolders(c: Context<AppEnv>): Promise<RoleHolders> {
  try {
    return await authoritativeRoleHolders(c.get("deps").roles);
  } catch (err) {
    logError("admin roles unavailable", err);
    throw new HttpError(503, "roles_unavailable", "the admin roles cannot be checked right now; try again shortly");
  }
}

/** The site the request comes from; sign-in messages name it, so it must be one this API serves. */
function siteOrigin(c: Context<AppEnv>): string {
  const origin = c.req.header("origin");
  if (!origin || !c.get("deps").config.corsOrigins.includes(origin)) {
    throw new HttpError(403, "bad_origin", "sign in from the Perk site");
  }
  return origin;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "bad_json", "body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_json", "body must be a JSON object");
  return body as Record<string, unknown>;
}

async function requireRole(c: Context<AppEnv>, allowed: AdminRole[]) {
  const { db, config } = c.get("deps");
  const session = await sessionFor(db, config.chainId, c.req.header("authorization"));
  if (!session) throw new HttpError(401, "unauthorized", "sign in first");
  const roles = await selectAdminRoles(db, config.chainId, session.address, await chainRoleHolders(c));
  if (!roles.some((role) => allowed.includes(role))) throw new HttpError(403, "forbidden", "your admin role does not allow this");
  return { address: session.address.toLowerCase() as `0x${string}`, roles, expiresAt: session.expiresAt };
}

async function featuredForAdmin(c: Context<AppEnv>): Promise<AdminLaunch[]> {
  const { db, config } = c.get("deps");
  const rows = await selectFeatured(db, config.chainId, now(), { includeHidden: true });
  const out: AdminLaunch[] = [];
  for (const row of rows) {
    const l = await selectAdminLaunch(db, config.chainId, row.meme, now());
    if (l) out.push(l);
  }
  return out;
}

function text(v: unknown, max: number, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new HttpError(400, "bad_param", `${name} must be text`);
  if (!v.isWellFormed() || hasControlChars(v, true)) {
    throw new HttpError(400, "bad_param", `${name} contains control characters`);
  }
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, "bad_param", `${name} is longer than ${max} characters`);
  return s === "" ? null : s;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new HttpError(400, "bad_param", `${name} must be true or false`);
  return v;
}

export function parseModeration(body: Record<string, unknown>): ModerationUpdate {
  const hidden = bool(body.hidden, "hidden");
  return {
    hidden,
    mediaHidden: hidden || bool(body.mediaHidden, "mediaHidden"),
    reason: text(body.reason, 200, "reason"),
  };
}

const CATEGORIES: QuoteCategory[] = ["native", "ecosystem", "rwa", "stablecoin", "other"];

/** `publicApiUrl`: images this API stored itself are accepted at its own address (plain http in development). */
export function parseQuoteDisplay(body: Record<string, unknown>, publicApiUrl: string): QuoteDisplayUpdate {
  const iconUrl = text(body.iconUrl, 300, "iconUrl");
  const ownMedia = iconUrl !== null && iconUrl.startsWith(`${publicApiUrl}/v1/media/`) && !/\s/.test(iconUrl);
  if (iconUrl !== null && !ownMedia && !/^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(iconUrl)) {
    throw new HttpError(400, "bad_param", "iconUrl must be an https:// or ipfs:// address");
  }
  const category = body.category === null || body.category === undefined ? null : body.category;
  if (category !== null && !CATEGORIES.includes(category as QuoteCategory)) {
    throw new HttpError(400, "bad_param", `category must be one of ${CATEGORIES.join(", ")}`);
  }
  const notice: QuoteNotice = {};
  if (body.notice !== null && body.notice !== undefined) {
    if (typeof body.notice !== "object" || Array.isArray(body.notice)) throw new HttpError(400, "bad_param", "notice must be an object");
    for (const [locale, value] of Object.entries(body.notice as Record<string, unknown>)) {
      if (locale !== "en" && locale !== "zh-CN" && locale !== "ja") throw new HttpError(400, "bad_param", `unknown locale ${locale}`);
      const s = text(value, 600, `notice.${locale}`);
      if (s !== null) notice[locale] = s;
    }
  }
  const sortOrder = body.sortOrder === undefined ? 0 : body.sortOrder;
  if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder) || sortOrder < -1000 || sortOrder > 1000) {
    throw new HttpError(400, "bad_param", "sortOrder must be an integer in [-1000, 1000]");
  }
  return {
    displayName: text(body.displayName, 40, "displayName"),
    iconUrl,
    category: category as QuoteCategory | null,
    notice,
    sortOrder,
    listed: body.listed === undefined ? true : bool(body.listed, "listed"),
  };
}
