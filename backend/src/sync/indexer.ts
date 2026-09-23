import type { Address, Hex } from "viem";
import type { Db, Tx } from "../db/client";
import type { AppConfig } from "../config";
import { type Client, getHeader, getHeaders, getLogsPaged, getTxOrigins, SWAP_TOPIC, TRANSFER_TOPIC } from "../chain/rpc";
import {
  decodePerkLog,
  decodeSwapLog,
  decodeTransferLog,
  perkContracts,
  orderForApply,
  sortLogs,
  type DecodedLog,
  type PerkContract,
  type RawLog,
} from "../chain/events";
import { applyLog, lower, type ApplyContext } from "./apply";
import { findReorgPoint, rollbackTo } from "./reorg";
import { notifySync } from "./notify";
import {
  advanceCursor,
  INDEX_VERSION,
  initSyncState,
  readSyncState,
  recordError,
  recordHead,
  resetIndex,
  type SyncState,
} from "./state";
import { loadTracked, TrackedSet } from "./tracked";

export interface IndexerDeps {
  db: Db;
  client: Client;
  config: AppConfig;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Injected for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncResult {
  /** first..last block applied in this pass (null when nothing to do). */
  fromBlock: bigint | null;
  toBlock: bigint | null;
  logsApplied: number;
  head: bigint;
  /** target - cursor after this pass (0 when the pass reached its target). */
  lag: bigint;
  /**
   * true when the pass processed everything up to the target it computed from the head it saw at its start.
   * false only when it stopped at maxWindows with blocks left: runForever then starts the next pass immediately.
   */
  reachedTarget: boolean;
  /** "catchup" when the gap at the start of the pass exceeded config.catchupBlocks, else "live" (logging / tests). */
  mode: "catchup" | "live";
}

/**
 * The sync engine. One instance per chain. Resumable: state lives in sync_state and every range is applied
 * in a single transaction together with the cursor update, so a crash mid-range re-applies that range on
 * restart (applied_logs makes re-application idempotent).
 */
export class Indexer {
  readonly db: Db;
  readonly client: Client;
  readonly config: AppConfig;
  readonly log: NonNullable<IndexerDeps["log"]>;
  tracked: TrackedSet = new TrackedSet();
  state: SyncState | null = null;
  readonly sleep: (ms: number) => Promise<void>;
  private contractsByAddress = new Map<string, { name: PerkContract; abi: readonly unknown[] }>();
  private stopped = false;
  /** Last head written to sync_state; an idle pass with an unchanged head writes nothing. */
  private recordedHead: bigint | null = null;

  constructor(deps: IndexerDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.log ?? (() => {});
    this.sleep = deps.sleep ?? Bun.sleep;
    for (const c of perkContracts(this.config.deployment)) {
      this.contractsByAddress.set(c.address.toLowerCase(), { name: c.name, abi: c.abi });
    }
  }

  /** Load sync_state (creating it at the deployment block on first boot) and the tracked memes/pools. */
  async init(): Promise<void> {
    const chainId = this.config.chainId;
    const startBlock = BigInt(this.config.deployment.blockNumber);
    let state = await readSyncState(this.db, chainId);
    if (state && state.startBlock !== startBlock) {
      // The database was filled from a different deployment of the contracts. Nothing in it is about this one.
      const tables = await resetIndex(this.db);
      this.log("deployment changed; index rebuilt from scratch", {
        previousStartBlock: state.startBlock.toString(),
        startBlock: startBlock.toString(),
        tablesCleared: tables.length,
      });
      state = null;
    } else if (state && state.indexVersion < INDEX_VERSION) {
      // This release derives something new from logs the index has already passed; read them again.
      const tables = await resetIndex(this.db);
      this.log("index version changed; index rebuilt from scratch", {
        previousVersion: state.indexVersion,
        version: INDEX_VERSION,
        tablesCleared: tables.length,
      });
      state = null;
    }
    this.state = state ?? (await initSyncState(this.db, chainId, startBlock));
    this.tracked = await loadTracked(this.db, chainId);
    this.log("indexer init", { cursor: this.state.cursorBlock.toString(), memes: this.tracked.memes.size, pools: this.tracked.pools.size });
  }

  /**
   * One pass:
   *  1. head = getBlockNumber() — the only RPC call of an idle pass.
   *  2. target = head - confirmations. If cursor >= target: recordHead(head, null) and return live / lag 0.
   *     No header fetch, no reorg check.
   *  3. Otherwise: reorg check via findReorgPoint; on a reorg, rollbackTo(point) and continue from it.
   *     Then windows of ≤ logPage blocks from cursor+1 to target (at most `maxWindows` per pass).
   *  4. lag = max(0, target - cursorAfter); reachedTarget = lag == 0;
   *     mode = catchup when the gap at the start (target - cursorBefore) > catchupBlocks, else live.
   */
  async syncOnce(maxWindows = 20): Promise<SyncResult> {
    if (!this.state) await this.init();
    const chainId = this.config.chainId;
    const head = await this.client.getBlockNumber();
    const conf = BigInt(this.config.confirmations);
    const target = head - conf;

    const noteHead = async () => {
      if (head === this.recordedHead) return;
      await recordHead(this.db, chainId, head, null);
      this.recordedHead = head;
    };
    if (this.state!.cursorBlock >= target) {
      await noteHead();
      await this.clearError();
      return { fromBlock: null, toBlock: null, logsApplied: 0, head, lag: 0n, reachedTarget: true, mode: "live" };
    }
    const gapAtStart = target - this.state!.cursorBlock;
    // Health shows head - cursor. In live mode the head is written only after this pass has moved the cursor, so the
    // pill never shows the brief "new head, old cursor" gap of a pass in flight; while catching up it is written now so
    // the UI can show how far behind we are.
    const catchingUp = gapAtStart > BigInt(this.config.catchupBlocks);
    if (catchingUp) await noteHead();

    const point = await findReorgPoint(
      this.db,
      this.client,
      chainId,
      this.state!.cursorBlock,
      this.state!.cursorHash,
    );
    if (point !== null) {
      const good = await getHeader(this.client, point);
      await this.db.begin(async (tx) => {
        await rollbackTo(tx as unknown as Tx, chainId, point, good.hash);
      });
      this.state = (await readSyncState(this.db, chainId))!;
      this.tracked = await loadTracked(this.db, chainId);
      this.log("reorg rollback", { point: point.toString() });
    }

    const page = BigInt(this.config.logPage);
    let from = this.state!.cursorBlock + 1n;
    let windows = 0;
    let fromBlock: bigint | null = null;
    let toBlock: bigint | null = null;
    let logsApplied = 0;
    while (from <= target && windows < maxWindows && !this.stopped) {
      const to = from + page - 1n > target ? target : from + page - 1n;
      const n = await this.applyWindow(from, to);
      logsApplied += n;
      if (fromBlock === null) fromBlock = from;
      toBlock = to;
      from = to + 1n;
      windows++;
    }

    const cursorAfter = this.state!.cursorBlock;
    const lag = cursorAfter >= target ? 0n : target - cursorAfter;
    const mode: SyncResult["mode"] = catchingUp ? "catchup" : "live";
    if (!catchingUp) await noteHead();
    await this.clearError();
    return { fromBlock, toBlock, logsApplied, head, lag, reachedTarget: lag === 0n, mode };
  }

  /**
   * Loop (T21 pacing, reviewed by Claude):
   *   - a pass that stopped at maxWindows with blocks left (reachedTarget = false) → next pass immediately;
   *   - a pass that reached its target → wait until pollMs after that pass *started*, then look at the head again
   *     (start-to-start pacing: a 1 s pass is followed by 0.5 s of sleep, not 1.5 s). That is "caught up": the
   *     indexer processed everything up to the head it saw; blocks minted meanwhile are picked up on the next pass.
   * catchupBlocks does not steer the loop. It labels passes that started far behind (log lines "catchup" / "caught up")
   * and drives Health.mode for the UI.
   * On error: recordError and back off 1 s → 30 s.
   */
  async runForever(): Promise<void> {
    let failures = 0;
    let catchupStartedAt: number | null = null;
    while (!this.stopped) {
      const passStart = Date.now();
      try {
        const result = await this.syncOnce();
        failures = 0;
        if (result.mode === "catchup" && catchupStartedAt === null) {
          catchupStartedAt = Date.now();
          this.log("catchup", { cursor: this.state?.cursorBlock.toString(), remaining: result.lag.toString() });
        }
        if (!result.reachedTarget) continue;
        if (catchupStartedAt !== null) {
          this.log("caught up", { cursor: this.state?.cursorBlock.toString(), tookMs: Date.now() - catchupStartedAt });
          catchupStartedAt = null;
        }
        await this.sleep(Math.max(0, this.config.pollMs - (Date.now() - passStart)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordError(this.db, this.config.chainId, message);
        this.log("indexer error", { err: message });
        const delay = Math.min(30_000, 1000 * 2 ** failures);
        failures++;
        await this.sleep(delay);
      }
    }
  }

  private async clearError(): Promise<void> {
    await this.db`update sync_state set last_error = null, updated_at = now()
      where chain_id = ${this.config.chainId} and last_error is not null`;
  }

  private async applyWindow(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const snapMemes = new Set(this.tracked.memes);
    const snapPools = new Map(this.tracked.pools);
    try {
      return await this.applyWindowInner(fromBlock, toBlock);
    } catch (err) {
      this.tracked.memes.clear();
      for (const m of snapMemes) this.tracked.memes.add(m);
      this.tracked.pools.clear();
      for (const [k, v] of snapPools) this.tracked.pools.set(k, v);
      throw err;
    }
  }

  private async applyWindowInner(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const page = this.config.logPage;
    const perkAddrs = perkContracts(this.config.deployment).map((c) => c.address);
    const memes = this.tracked.memeAddresses();
    const poolIds = this.tracked.poolIds();
    // the three queries are independent: issue them together (the http transport batches them into one request)
    const [perkLogs, transferLogs, swapLogs] = await Promise.all([
      getLogsPaged(this.client, { address: perkAddrs, fromBlock, toBlock }, page),
      memes.length === 0
        ? Promise.resolve([] as RawLog[])
        : getLogsPaged(this.client, { address: memes, topics: [TRANSFER_TOPIC], fromBlock, toBlock }, page),
      poolIds.length === 0
        ? Promise.resolve([] as RawLog[])
        : getLogsPaged(
            this.client,
            { address: this.config.deployment.poolManager, topics: [SWAP_TOPIC, poolIds], fromBlock, toBlock },
            page,
          ),
    ]);

    let raw = dedupeRaw([...perkLogs, ...transferLogs, ...swapLogs]);
    let decoded = this.decodeAll(raw);

    const newMemes: Address[] = [];
    const newPools: Array<{ id: Hex; meme: Address }> = [];
    const seenMeme = new Set<string>();
    const seenPool = new Set<string>();
    for (const d of decoded) {
      if (d.contract === "factory" && d.eventName === "LaunchCreated") {
        const meme = String((d.args as { meme: Address }).meme).toLowerCase() as Address;
        if (!this.tracked.memes.has(meme) && !seenMeme.has(meme)) {
          seenMeme.add(meme);
          newMemes.push(meme);
        }
      }
      if (d.contract === "graduationManager" && d.eventName === "LaunchGraduated") {
        const args = d.args as { poolId: Hex; meme: Address };
        const id = String(args.poolId).toLowerCase() as Hex;
        if (!this.tracked.pools.has(id) && !seenPool.has(id)) {
          seenPool.add(id);
          newPools.push({ id, meme: args.meme });
        }
      }
    }

    if (newMemes.length || newPools.length) {
      const [extraTransfers, extraSwaps] = await Promise.all([
        newMemes.length
          ? getLogsPaged(this.client, { address: newMemes, topics: [TRANSFER_TOPIC], fromBlock, toBlock }, page)
          : Promise.resolve([] as RawLog[]),
        newPools.length
          ? getLogsPaged(
              this.client,
              {
                address: this.config.deployment.poolManager,
                topics: [SWAP_TOPIC, newPools.map((p) => p.id)],
                fromBlock,
                toBlock,
              },
              page,
            )
          : Promise.resolve([] as RawLog[]),
      ]);
      raw = dedupeRaw([...raw, ...extraTransfers, ...extraSwaps]);
    }

    for (const m of newMemes) this.tracked.addMeme(m);
    for (const p of newPools) this.tracked.addPool(p.id, p.meme);

    if (newMemes.length || newPools.length) decoded = this.decodeAll(raw);
    else decoded = orderForApply(decoded);

    const pendingRaw = await dropApplied(this.db, this.config.chainId, decoded);
    const pendingSet = new Set(pendingRaw.map((l) => `${l.transactionHash.toLowerCase()}:${l.logIndex}`));
    const pending = decoded.filter((l) => pendingSet.has(`${l.transactionHash.toLowerCase()}:${l.logIndex}`));

    // one header fetch for the log blocks + the window end, running alongside the tx-origin lookups
    const headerBlocks = [...new Set([...pending.map((l) => l.blockNumber.toString()), toBlock.toString()])].map(BigInt);
    const headersP = getHeaders(this.client, headerBlocks);
    const ctx = await this.buildContext(pending, headersP);
    const headers = await headersP;
    for (const [n, h] of headers) {
      if (!ctx.blockTime.has(n)) ctx.blockTime.set(n, h.timestamp);
    }
    const endHeader = headers.get(toBlock) ?? (await getHeader(this.client, toBlock));
    if (!ctx.blockTime.has(toBlock)) ctx.blockTime.set(toBlock, endHeader.timestamp);

    await this.db.begin(async (tx) => {
      const t = tx as unknown as Tx;
      for (const log of pending) await applyLog(t, ctx, log);
      for (const [n, h] of headers) {
        await t`insert into blocks (chain_id, number, hash, ts)
          values (${this.config.chainId}, ${n}, ${lower(h.hash)}, ${h.timestamp})
          on conflict (chain_id, number) do update set hash = excluded.hash, ts = excluded.ts`;
      }
      if (!headers.has(toBlock)) {
        await t`insert into blocks (chain_id, number, hash, ts)
          values (${this.config.chainId}, ${toBlock}, ${lower(endHeader.hash)}, ${endHeader.timestamp})
          on conflict (chain_id, number) do update set hash = excluded.hash, ts = excluded.ts`;
      }
      await advanceCursor(t, this.config.chainId, toBlock, lower(endHeader.hash));
      const memeRows = await t<{ meme: string }[]>`
        select distinct meme from trades
        where chain_id = ${this.config.chainId}
          and block_number between ${fromBlock} and ${toBlock}`;
      await notifySync(t, {
        chainId: this.config.chainId,
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock),
        memes: memeRows.map((r) => r.meme.toLowerCase()),
      });
    });

    this.state = {
      ...this.state!,
      cursorBlock: toBlock,
      cursorHash: lower(endHeader.hash),
      lastError: null,
    };
    return pending.length;
  }

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Test seam: decode a batch of raw logs the way syncOnce does (Perk contracts, tracked Transfers, tracked Swaps). */
  decodeAll(raw: Parameters<typeof decodePerkLog>[0][]): DecodedLog[] {
    const out: DecodedLog[] = [];
    for (const log of raw) {
      const addr = log.address.toLowerCase();
      if (this.contractsByAddress.has(addr)) {
        const d = decodePerkLog(log, this.contractsByAddress);
        if (d) out.push(d);
        continue;
      }
      if (this.tracked.memes.has(addr) && log.topics[0] === TRANSFER_TOPIC) {
        const d = decodeTransferLog(log);
        if (d) out.push(d);
        continue;
      }
      if (addr === this.config.deployment.poolManager.toLowerCase() && log.topics[0] === SWAP_TOPIC) {
        const d = decodeSwapLog(log);
        if (d && this.tracked.memeForPool(d.args.id)) out.push(d);
      }
    }
    return orderForApply(out);
  }

  /**
   * Test seam: build the ApplyContext for a set of decoded logs. Headers come from `headers` when the caller already
   * started that fetch (it must cover every log block), otherwise from the client; tx origins are fetched concurrently.
   */
  async buildContext(
    logs: DecodedLog[],
    headers?: Promise<Map<bigint, { timestamp: bigint }>>,
  ): Promise<ApplyContext> {
    const swapTxs = logs.filter((l) => l.contract === "poolManager").map((l) => l.transactionHash as Hex);
    const [hdrs, origins] = await Promise.all([
      headers ?? getHeaders(this.client, logs.map((l) => l.blockNumber)),
      swapTxs.length ? getTxOrigins(this.client, swapTxs) : Promise.resolve(new Map<Hex, Address>()),
    ]);
    const blockTime = new Map<bigint, bigint>();
    for (const [n, h] of hdrs) blockTime.set(n, h.timestamp);
    const txOrigin = new Map<Hex, Address>();
    for (const [hash, from] of origins) txOrigin.set(hash.toLowerCase() as Hex, from);
    return {
      chainId: this.config.chainId,
      deployment: this.config.deployment,
      client: this.client,
      tracked: this.tracked,
      blockTime,
      txOrigin,
      quoteDecimals: new Map(),
    };
  }
}

function dedupeRaw(logs: RawLog[]): RawLog[] {
  const seen = new Set<string>();
  const out: RawLog[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}

async function dropApplied(db: Db, chainId: number, logs: RawLog[]): Promise<RawLog[]> {
  if (logs.length === 0) return logs;
  const keys = logs.map((l) => `${lower(l.transactionHash)}:${l.logIndex}`);
  const existing = await db<{ tx_hash: string; log_index: number | string }[]>`
    select tx_hash, log_index from applied_logs
    where chain_id = ${chainId}
      and (tx_hash || ':' || log_index::text) in ${db(keys)}`;
  const skip = new Set(existing.map((r) => `${r.tx_hash.toLowerCase()}:${Number(r.log_index)}`));
  return logs.filter((l) => !skip.has(`${lower(l.transactionHash)}:${l.logIndex}`));
}

export { applyLog, getLogsPaged, advanceCursor, recordHead, recordError, findReorgPoint, rollbackTo };
