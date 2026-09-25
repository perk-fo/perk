import type { Db, Tx } from "../db/client";
import type { RawLog } from "../chain/events";

/**
 * Version of what the indexer derives from logs. Bump it when a release adds or changes a handler for events that
 * may already be behind the cursor: on boot an index built by an older version is rebuilt from the start block.
 *   2: admin roles (factory OwnershipTransferred, vault PublisherUpdated); template status from the struct.
 */
export const INDEX_VERSION = 2;

/**
 * Tables that hold decisions people made rather than facts derived from logs. A rebuild of the index keeps them.
 */
export const PRESERVED_TABLES = [
  "schema_migrations",
  "admin_operators",
  "admin_nonces",
  "admin_sessions",
  "admin_audit",
  "launch_moderation",
  "launch_featured",
  "quote_asset_display",
] as const;

export interface SyncState {
  chainId: number;
  cursorBlock: bigint;
  cursorHash: string | null;
  startBlock: bigint;
  headBlock: bigint | null;
  headTime: bigint | null;
  lastError: string | null;
  indexVersion: number;
}

/** Read sync_state for the chain; null before the first run. */
export async function readSyncState(db: Db, chainId: number): Promise<SyncState | null> {
  const rows = await db<
    { chain_id: number; cursor_block: string; cursor_hash: string | null; start_block: string; head_block: string | null; head_time: string | null; last_error: string | null; index_version: number }[]
  >`select chain_id, cursor_block, cursor_hash, start_block, head_block, head_time, last_error, index_version
    from sync_state where chain_id = ${chainId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    chainId: r.chain_id,
    cursorBlock: BigInt(r.cursor_block),
    cursorHash: r.cursor_hash,
    startBlock: BigInt(r.start_block),
    headBlock: r.head_block === null ? null : BigInt(r.head_block),
    headTime: r.head_time === null ? null : BigInt(r.head_time),
    lastError: r.last_error,
    indexVersion: Number(r.index_version),
  };
}

/** Create the row on first boot: cursor = startBlock - 1 so the deployment block itself gets scanned. */
export async function initSyncState(db: Db, chainId: number, startBlock: bigint): Promise<SyncState> {
  await db`insert into sync_state (chain_id, cursor_block, start_block, index_version)
    values (${chainId}, ${startBlock - 1n}, ${startBlock}, ${INDEX_VERSION})
    on conflict (chain_id) do nothing`;
  return (await readSyncState(db, chainId))!;
}

/**
 * Delete everything the indexer has written for one chain. The index is derived from one deployment's logs, so when
 * the contracts are redeployed (or the chain reorganised under the cursor) none of it can be trusted any more. Every
 * table except PRESERVED_TABLES (the migration ledger and what admins decided) loses its rows for `chainId`; other
 * chains sharing the database are untouched. The caller re-creates sync_state. Run it inside a transaction when the
 * caller needs the reset and the new sync_state to appear together.
 *
 * Every derived table carries chain_id; one without it would make this throw rather than be emptied for every chain.
 */
export async function resetIndex(db: Db, chainId: number): Promise<string[]> {
  const rows = await db<{ table_name: string; has_chain: boolean }[]>`
    select t.table_name,
      exists (
        select 1 from information_schema.columns c
        where c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'chain_id'
      ) as has_chain
    from information_schema.tables t
    where t.table_schema = current_schema() and t.table_type = 'BASE TABLE'
    order by t.table_name`;
  const keep = new Set<string>(PRESERVED_TABLES);
  const derived = rows.filter((r) => !keep.has(r.table_name));
  const unscoped = derived.filter((r) => !r.has_chain).map((r) => r.table_name);
  if (unscoped.length > 0) throw new Error(`cannot reset one chain: tables without chain_id: ${unscoped.join(", ")}`);
  for (const { table_name } of derived) {
    await db.unsafe(`delete from "${table_name.replace(/"/g, '""')}" where chain_id = $1`, [chainId]);
  }
  return derived.map((r) => r.table_name);
}

/** Advance the cursor inside the same transaction that applied the range's logs. */
export async function advanceCursor(tx: Tx, chainId: number, block: bigint, hash: string | null): Promise<void> {
  await tx`update sync_state set cursor_block = ${block}, cursor_hash = ${hash}, updated_at = now(), last_error = null
    where chain_id = ${chainId}`;
}

/** Persist the observed chain head. `headTime === null` keeps the stored head_time (`coalesce`). */
export async function recordHead(db: Db, chainId: number, head: bigint, headTime: bigint | null): Promise<void> {
  await db`update sync_state set head_block = ${head}, head_time = coalesce(${headTime}, head_time), updated_at = now()
    where chain_id = ${chainId}`;
}

/** `message` is served by GET /health: pass `publicErrorText(err)`, never a raw error message. */
export async function recordError(db: Db, chainId: number, message: string): Promise<void> {
  await db`update sync_state set last_error = ${message.slice(0, 300)}, last_error_at = now(), updated_at = now()
    where chain_id = ${chainId}`;
}

/**
 * Set a log aside: its window is applied without it. Kept with its raw topics and data so an operator can see what it
 * was; GET /health reports how many there are. A rebuild of the index (a new INDEX_VERSION, say, after the handler
 * is fixed) clears the table and applies every log again.
 */
export async function quarantineLog(
  tx: Tx,
  chainId: number,
  log: RawLog & { eventName?: string; contract?: string },
  error: string,
  attempts: number,
): Promise<void> {
  const event = log.contract && log.eventName ? `${log.contract}.${log.eventName}` : "unknown";
  await tx`insert into quarantined_logs (
      chain_id, tx_hash, log_index, block_number, block_hash, address, event_name, topics, data, error, attempts
    ) values (
      ${chainId}, ${log.transactionHash.toLowerCase()}, ${log.logIndex}, ${log.blockNumber},
      ${log.blockHash.toLowerCase()}, ${log.address.toLowerCase()}, ${event}, ${tx.json(log.topics as never)},
      ${log.data}, ${error.slice(0, 300)}, ${attempts}
    )
    on conflict (chain_id, tx_hash, log_index) do update set
      error = excluded.error, attempts = excluded.attempts, quarantined_at = now()`;
}
