import postgres from "postgres";

/**
 * One indexer per chain. Two running at once (a scaled-out container, a process left over from a deploy) would both
 * apply the same windows, and the additive handlers (volumes, trade counts, fee counters) would count them twice.
 *
 * The indexer holds a session-level Postgres advisory lock, keyed by (INDEXER_LOCK_NAMESPACE, chainId), on a connection
 * of its own for as long as it runs. A second indexer waits for it and says so in the log, and takes over when the
 * first one exits. Each window's transaction also checks that the cursor is still where this indexer left it
 * (indexer.ts), so even an indexer that lost its lock without noticing cannot apply a range twice.
 */
export const INDEXER_LOCK_NAMESPACE = 0x7065726b; // "perk"

export interface IndexerLock {
  /** false once the connection that held the lock closed: the lock went with it. */
  readonly held: boolean;
  /** Take the lock again if it was lost. false while another process holds it. */
  ensure(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Wait while another process holds the lock (default true). false returns null at once instead. */
  wait?: boolean;
  /** How often to try again while waiting (default 5 s). */
  retryMs?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stop waiting (returns null) once this says so. */
  shouldStop?: () => boolean;
}

export async function acquireIndexerLock(
  databaseUrl: string,
  chainId: number,
  opts: AcquireLockOptions = {},
): Promise<IndexerLock | null> {
  const wait = opts.wait ?? true;
  const retryMs = opts.retryMs ?? 5_000;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let held = false;
  // one connection, never recycled: postgres.js otherwise ends connections after 30-60 minutes, and the lock with it
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: undefined,
    max_lifetime: null,
    onnotice: () => {},
    onclose: () => {
      if (held) log("indexer lock connection closed; the lock is released", { chainId });
      held = false;
    },
    connection: { application_name: `perk-indexer-${chainId}` },
  });

  const tryLock = async (): Promise<boolean> => {
    const [row] = await sql<{ ok: boolean }[]>`
      select pg_try_advisory_lock(${INDEXER_LOCK_NAMESPACE}::int, ${chainId}::int) as ok`;
    held = row?.ok === true;
    return held;
  };

  let announced = false;
  for (;;) {
    if (await tryLock()) break;
    if (!wait || opts.shouldStop?.()) {
      await sql.end({ timeout: 5 }).catch(() => {});
      return null;
    }
    if (!announced) {
      log("another indexer holds the lock for this chain; waiting for it to exit", { chainId, retryMs });
      announced = true;
    }
    await sleep(retryMs);
  }
  if (announced) log("indexer lock acquired", { chainId });

  return {
    get held() {
      return held;
    },
    async ensure() {
      if (held) return true;
      try {
        return await tryLock();
      } catch {
        return false;
      }
    },
    async release() {
      try {
        if (held) await sql`select pg_advisory_unlock(${INDEXER_LOCK_NAMESPACE}::int, ${chainId}::int)`;
      } catch {
        // the connection is gone, and the lock with it
      }
      held = false;
      await sql.end({ timeout: 5 }).catch(() => {});
    },
  };
}
