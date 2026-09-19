import type { Address, Hex } from "viem";
import type { Db } from "../db/client";

/**
 * Addresses / pool ids the indexer must also watch besides the fixed Perk contracts:
 * every launched meme token (Transfer logs) and every graduated pool id (PoolManager Swap logs).
 * Loaded from the DB at boot and extended in memory as LaunchCreated / LaunchGraduated are applied.
 */
export class TrackedSet {
  readonly memes = new Set<string>();
  /** poolId (lowercase) → meme (lowercase) */
  readonly pools = new Map<string, string>();

  addMeme(meme: Address): void {
    this.memes.add(meme.toLowerCase());
  }

  addPool(poolId: Hex, meme: Address): void {
    this.pools.set(poolId.toLowerCase(), meme.toLowerCase());
  }

  memeAddresses(): Address[] {
    return [...this.memes] as Address[];
  }

  poolIds(): Hex[] {
    return [...this.pools.keys()] as Hex[];
  }

  memeForPool(poolId: Hex): Address | undefined {
    return this.pools.get(poolId.toLowerCase()) as Address | undefined;
  }
}

/** Rebuild the tracked set from `launches` (all memes; pool ids where status = GRADUATED). */
export async function loadTracked(db: Db, chainId: number): Promise<TrackedSet> {
  const set = new TrackedSet();
  const rows = await db<{ meme: string; pool_id: string | null }[]>`
    select meme, pool_id from launches where chain_id = ${chainId}`;
  for (const r of rows) {
    set.addMeme(r.meme as Address);
    if (r.pool_id) set.addPool(r.pool_id as Hex, r.meme as Address);
  }
  return set;
}
