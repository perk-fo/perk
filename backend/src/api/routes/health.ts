import { Hono } from "hono";
import type { AppConfig } from "../../config";
import type { Db } from "../../db/client";
import { readSyncState } from "../../sync/state";
import type { AppEnv } from "../server";
import type { Health } from "../types";
import { selectHealth } from "../queries";
import { iso, num, numNull } from "../serialize";

/**
 * GET /health → Health. ok = cursor within 30 blocks of head and no error in the last 2 minutes.
 * lagSeconds uses blocks.ts of the cursor block (null before the first applied block). No caching.
 */
export function healthRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const { db, config } = c.get("deps");
    c.header("Cache-Control", "no-store");
    return c.json<Health>(await buildHealth(db, config));
  });
  return r;
}

/** Shared by the health route and the WebSocket hub. */
export async function buildHealth(db: Db, config: AppConfig): Promise<Health> {
  const state = await readSyncState(db, config.chainId);
  const row = await selectHealth(db, config.chainId);
  const serverTime = Math.floor(Date.now() / 1000);

  if (!state || !row) {
    return {
      ok: false,
      chainId: config.chainId,
      cursorBlock: 0,
      headBlock: null,
      lagBlocks: null,
      confirmations: config.confirmations,
      lagSeconds: null,
      startBlock: config.deployment.blockNumber,
      updatedAt: new Date(0).toISOString(),
      lastError: null,
      lastErrorAt: null,
      serverTime,
      mode: "catchup",
    };
  }

  const cursorBlock = Number(state.cursorBlock);
  const headBlock = state.headBlock === null ? null : Number(state.headBlock);
  const lagBlocks = headBlock === null ? null : Math.max(0, headBlock - cursorBlock);
  const cursorTs = row.cursor_ts === null || row.cursor_ts === undefined ? null : num(row.cursor_ts);
  const lagSeconds = cursorTs === null ? null : serverTime - cursorTs;
  const lastErrorAt = iso(row.last_error_at);
  const recentError = hasRecentError(state.lastError, row.last_error_at, serverTime);
  const ok = lagBlocks !== null && lagBlocks <= 30 && !recentError;
  const mode: Health["mode"] = lagBlocks === null || lagBlocks > config.catchupBlocks ? "catchup" : "live";

  return {
    ok,
    chainId: config.chainId,
    cursorBlock,
    headBlock,
    lagBlocks,
    confirmations: config.confirmations,
    lagSeconds,
    startBlock: Number(state.startBlock),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    lastError: state.lastError,
    lastErrorAt,
    serverTime,
    mode,
  };
}

function hasRecentError(lastError: string | null, lastErrorAt: Date | string | null, serverTime: number): boolean {
  if (!lastError) return false;
  if (!lastErrorAt) return true;
  const at =
    lastErrorAt instanceof Date ? Math.floor(lastErrorAt.getTime() / 1000) : numNull(lastErrorAt as string | number);
  if (at === null || !Number.isFinite(at)) return true;
  return serverTime - at < 120;
}

export type { Health };
