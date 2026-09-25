import type { Db } from "../db/client";
import type { AppConfig } from "../config";
import type { TokenMetadataView } from "../api/types";
import { errorText } from "../log";
import { fetchPublic, UrlRefusedError, type LookupFn } from "../net/fetchPublic";
import { ipfsToHttps, localMediaFilename, withTrailingSlash, type FetchLike, type MediaStore } from "./store";
import { FALLBACK_GATEWAYS } from "./ipfsImages";
import { parseTokenMetadata } from "./metadata";

const FETCH_TIMEOUT_MS = 5_000;
const FETCH_MAX_BYTES = 64 * 1024;
const RETRY_AFTER_SEC = 10 * 60;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MetadataResolverDeps {
  db: Db;
  config: AppConfig;
  media: MediaStore;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  /** DNS for the outbound fetch guard; tests inject one so nothing leaves the machine. */
  lookup?: LookupFn;
  now?: () => number;
}

interface PendingLaunch {
  chain_id: number;
  meme: string;
  token_uri: string | null;
  metadata_status: string;
  metadata_checked_at: number | string | bigint | null;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadMetadataBytes(
  uri: string,
  deps: MetadataResolverDeps,
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "invalid" } | { kind: "unreachable"; error: string }> {
  const local = localMediaFilename(uri, deps.config.publicApiUrl);
  if (local) {
    const hit = deps.media.get(local);
    if (!hit) return { kind: "unreachable", error: "local media missing" };
    return { kind: "ok", bytes: hit.bytes };
  }

  const fetchOpts = { fetch: deps.fetch, lookup: deps.lookup, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES };
  if (uri.startsWith("ipfs://")) {
    // The same content is on every gateway, and public gateways rate-limit, so one refusing is no reason to wait for
    // the next pass: the configured gateway first, then the public ones the image route also falls back to.
    const gateways = [...new Set([deps.config.ipfsGateway, ...FALLBACK_GATEWAYS].map(withTrailingSlash))];
    let lastError = "no gateway";
    for (const gateway of gateways) {
      try {
        return { kind: "ok", bytes: await fetchPublic(ipfsToHttps(uri, gateway), fetchOpts) };
      } catch (err) {
        lastError = errMessage(err);
      }
    }
    return { kind: "unreachable", error: lastError };
  }
  if (!uri.startsWith("https://")) return { kind: "invalid" };

  try {
    return { kind: "ok", bytes: await fetchPublic(uri, fetchOpts) };
  } catch (err) {
    // an address this server will not fetch (private host, http, credentials) does not become valid later
    if (err instanceof UrlRefusedError) return { kind: "invalid" };
    return { kind: "unreachable", error: errMessage(err) };
  }
}

async function mark(
  db: Db,
  chainId: number,
  meme: string,
  status: "ok" | "invalid" | "unreachable",
  metadata: TokenMetadataView | null,
  checkedAt: number,
): Promise<void> {
  const payload =
    metadata === null
      ? null
      : {
          image: metadata.image,
          description: metadata.description,
          links: { ...metadata.links },
        };
  await db`
    update launches set
      metadata_status = ${status},
      metadata = ${payload === null ? null : db.json(payload)},
      metadata_checked_at = ${checkedAt},
      updated_at = now()
    where chain_id = ${chainId} and meme = ${meme}
  `;
}

/**
 * One resolver pass: launches in `pending`, plus `unreachable` whose last check is at least 10 minutes ago.
 * Each launch is resolved on its own: whatever goes wrong with one (its JSON refused by the database, say) marks that
 * launch `invalid` and the pass moves on, so no single launch can hold back the ones after it.
 */
export async function resolvePendingMetadata(deps: MetadataResolverDeps): Promise<void> {
  const now = (deps.now ?? unixNow)();
  const retryBefore = now - RETRY_AFTER_SEC;
  const rows = await deps.db<PendingLaunch[]>`
    select chain_id, meme, token_uri, metadata_status, metadata_checked_at
    from launches
    where metadata_status = 'pending'
       or (metadata_status = 'unreachable' and coalesce(metadata_checked_at, 0) <= ${retryBefore})
    order by created_block asc
    limit 50
  `;

  for (const row of rows) {
    try {
      await resolveOne(deps, row, now);
    } catch (err) {
      (deps.log ?? (() => {}))("metadata-resolver", { meme: row.meme, error: errorText(err) });
      try {
        await mark(deps.db, row.chain_id, row.meme, "invalid", null, now);
      } catch {
        // the database is unavailable; the launch stays as it was and is tried again next pass
      }
    }
  }
}

async function resolveOne(deps: MetadataResolverDeps, row: PendingLaunch, now: number): Promise<void> {
  const uri = row.token_uri?.trim() ?? "";
  if (!uri) {
    await mark(deps.db, row.chain_id, row.meme, "invalid", null, now);
    return;
  }
  const loaded = await loadMetadataBytes(uri, deps);
  if (loaded.kind === "unreachable") {
    await mark(deps.db, row.chain_id, row.meme, "unreachable", null, now);
    return;
  }
  if (loaded.kind === "invalid") {
    await mark(deps.db, row.chain_id, row.meme, "invalid", null, now);
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes)) as unknown;
  } catch {
    await mark(deps.db, row.chain_id, row.meme, "invalid", null, now);
    return;
  }
  // parseTokenMetadata refuses control characters and unpaired surrogates, which jsonb could not hold anyway
  const parsed = parseTokenMetadata(parsedJson, {
    imageRule: "resolved",
    publicApiUrl: deps.config.publicApiUrl,
    ipfsGateway: deps.config.ipfsGateway,
  });
  if (!parsed) {
    await mark(deps.db, row.chain_id, row.meme, "invalid", null, now);
    return;
  }
  await mark(deps.db, row.chain_id, row.meme, "ok", parsed.view, now);
}

function referencedFilenames(
  rows: Array<{ token_uri: string | null; metadata: unknown }>,
  publicApiUrl: string,
): Set<string> {
  const out = new Set<string>();
  const consider = (uri: unknown) => {
    if (typeof uri !== "string") return;
    const file = localMediaFilename(uri, publicApiUrl);
    if (file) out.add(file);
  };
  for (const row of rows) {
    consider(row.token_uri);
    const meta = row.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      consider((meta as { image?: unknown }).image);
    }
  }
  return out;
}

/** Delete local files older than 7 days that no launch token_uri / metadata.image points at. */
export async function gcLocalMedia(deps: MetadataResolverDeps, nowMs = Date.now()): Promise<number> {
  const rows = await deps.db<{ token_uri: string | null; metadata: unknown }[]>`
    select token_uri, metadata from launches
    where token_uri is not null or metadata is not null
  `;
  const refs = referencedFilenames(rows, deps.config.publicApiUrl);
  return deps.media.gc(refs, GC_MAX_AGE_MS, nowMs);
}

/**
 * Background loop: resolve pending/unreachable launch metadata every `everyMs` (default 15 s).
 * Local-store GC runs at most once a day. Never throws out of the loop. Serve-side only.
 */
export async function runMetadataResolver(
  deps: MetadataResolverDeps,
  opts: { everyMs?: number } = {},
): Promise<void> {
  const everyMs = opts.everyMs ?? 15_000;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? (() => {});
  let lastGc = 0;
  for (;;) {
    try {
      await resolvePendingMetadata(deps);
    } catch (err) {
      log("metadata-resolver", { error: errorText(err) });
    }
    const t = Date.now();
    if (t - lastGc >= GC_INTERVAL_MS) {
      try {
        await gcLocalMedia(deps, t);
      } catch (err) {
        log("metadata-gc", { error: errorText(err) });
      }
      lastGc = t;
    }
    await sleep(everyMs);
  }
}
