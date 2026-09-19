import type { Db, Tx } from "../db/client";

export interface SyncState {
  chainId: number;
  cursorBlock: bigint;
  cursorHash: string | null;
  startBlock: bigint;
  headBlock: bigint | null;
  headTime: bigint | null;
  lastError: string | null;
}

/** Read sync_state for the chain; null before the first run. */
export async function readSyncState(db: Db, chainId: number): Promise<SyncState | null> {
  const rows = await db<
    { chain_id: number; cursor_block: string; cursor_hash: string | null; start_block: string; head_block: string | null; head_time: string | null; last_error: string | null }[]
  >`select chain_id, cursor_block, cursor_hash, start_block, head_block, head_time, last_error from sync_state where chain_id = ${chainId}`;
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
  };
}

/** Create the row on first boot: cursor = startBlock - 1 so the deployment block itself gets scanned. */
export async function initSyncState(db: Db, chainId: number, startBlock: bigint): Promise<SyncState> {
  await db`insert into sync_state (chain_id, cursor_block, start_block)
    values (${chainId}, ${startBlock - 1n}, ${startBlock})
    on conflict (chain_id) do nothing`;
  return (await readSyncState(db, chainId))!;
}

/**
 * Empty everything the indexer has written. The index is derived from one deployment's logs, so when the
 * contracts are redeployed none of it describes the chain any more: old launches, cursors and balances would sit
 * next to the new ones. Every table in the schema goes except the migration ledger; the caller re-creates
 * sync_state for the new deployment.
 */
export async function resetIndex(db: Db): Promise<string[]> {
  const rows = await db<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name <> 'schema_migrations'
    order by table_name`;
  const tables = rows.map((r) => r.table_name);
  if (tables.length === 0) return tables;
  const list = tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(", ");
  await db.unsafe(`truncate table ${list} restart identity cascade`);
  return tables;
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

export async function recordError(db: Db, chainId: number, message: string): Promise<void> {
  await db`update sync_state set last_error = ${message.slice(0, 2000)}, last_error_at = now(), updated_at = now()
    where chain_id = ${chainId}`;
}
