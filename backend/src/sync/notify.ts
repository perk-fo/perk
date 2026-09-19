import type { Db, Tx } from "../db/client";

/**
 * Indexer → API change feed over Postgres LISTEN/NOTIFY. Works the same whether the indexer and the API run in one
 * process or in separate containers (`--sync-only` / `--serve-only`), because both only share the database.
 */
export const SYNC_CHANNEL = "perk_sync";

/** Payload of one NOTIFY: a committed window. Kept small (NOTIFY payloads are capped at 8000 bytes). */
export interface SyncNotice {
  chainId: number;
  fromBlock: number;
  toBlock: number;
  /** Lowercase memes that got at least one new trade row in [fromBlock, toBlock]. */
  memes: string[];
}

const NOTIFY_MAX_BYTES = 7900;

function parseNotice(payload: string): SyncNotice | null {
  try {
    const v = JSON.parse(payload) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.chainId !== "number" || typeof o.fromBlock !== "number" || typeof o.toBlock !== "number") return null;
    if (!Array.isArray(o.memes) || !o.memes.every((m) => typeof m === "string")) return null;
    return { chainId: o.chainId, fromBlock: o.fromBlock, toBlock: o.toBlock, memes: o.memes };
  } catch {
    return null;
  }
}

/**
 * Queue a notice inside the window's transaction (`select pg_notify(...)`), so listeners hear about it only after the
 * window commits and never about a rolled-back window. Skips the NOTIFY when `memes` is empty and `always` is false.
 * If the JSON would exceed 7900 bytes, send memes: [] with the block range (listeners then treat it as "anything in
 * the range may have changed").
 */
export async function notifySync(tx: Tx, notice: SyncNotice, always = false): Promise<void> {
  if (!always && notice.memes.length === 0) return;
  let payload = JSON.stringify(notice);
  if (payload.length > NOTIFY_MAX_BYTES) {
    payload = JSON.stringify({ ...notice, memes: [] });
  }
  await tx`select pg_notify(${SYNC_CHANNEL}, ${payload})`;
}

/**
 * LISTEN on SYNC_CHANNEL. Calls onNotice for every well-formed payload of this chainId; malformed payloads are ignored.
 * postgres.js re-establishes the LISTEN connection by itself after a drop; `onReconnect` fires when that happens so
 * the caller can treat it like a notice covering an unknown range.
 */
export async function listenSync(
  db: Db,
  chainId: number,
  onNotice: (n: SyncNotice) => void,
  onReconnect?: () => void,
): Promise<{ unlisten: () => Promise<void> }> {
  let initial = true;
  const handle = await db.listen(
    SYNC_CHANNEL,
    (payload) => {
      const n = parseNotice(payload);
      if (!n || n.chainId !== chainId) return;
      onNotice(n);
    },
    () => {
      if (initial) {
        initial = false;
        return;
      }
      onReconnect?.();
    },
  );
  return { unlisten: () => handle.unlisten() };
}
