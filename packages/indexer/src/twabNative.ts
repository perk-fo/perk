import type { Address } from "viem";

/** eth_getBalance at a historical block — viem PublicClient adapter in production, in-memory fake in tests. */
export type BalanceFetcher = (account: Address, blockNumber: bigint) => Promise<bigint>;

/** Anything that can return a block's timestamp (for the average-block-time estimate). */
export type BlockTimestampFetcher = (blockNumber: bigint) => Promise<bigint>;

export const SEVEN_DAYS_SECONDS = 7n * 24n * 3600n;
export const BLOCK_TIME_SAMPLE_SPAN = 1000n;
export const DEFAULT_SAMPLE_STEP = 300n;
export const RPC_CONCURRENCY = 20;

/**
 * Estimate the average block time over the `span` blocks ending at `cutoff`,
 * then derive the 7-day window length in blocks.
 */
export async function estimateWindowBlocks(
  getTimestamp: BlockTimestampFetcher,
  cutoff: bigint,
  span: bigint = BLOCK_TIME_SAMPLE_SPAN,
): Promise<{ windowBlocks: bigint; avgBlockTimeMs: bigint }> {
  const from = cutoff > span ? cutoff - span : 0n;
  const [t0, t1] = await Promise.all([getTimestamp(from), getTimestamp(cutoff)]);
  if (t1 <= t0 || cutoff === from) throw new Error("cannot estimate block time: non-increasing timestamps");
  const avgBlockTimeMs = ((t1 - t0) * 1000n) / (cutoff - from);
  const windowBlocks = (SEVEN_DAYS_SECONDS * 1000n) / avgBlockTimeMs;
  if (windowBlocks === 0n) throw new Error("estimated window is zero blocks");
  return { windowBlocks, avgBlockTimeMs };
}

/** Run async tasks with a bounded concurrency pool. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Sample native balances for `accounts` at blocks `cutoff - window .. cutoff` every `step`
 * blocks (both endpoints included when window is a multiple of step). TWAB = mean of samples.
 *
 * Note: viem's multicall cannot batch native balance reads, so the production adapter uses a
 * plain JSON-RPC batch client (`createClient({ batch: { multicall: false } })`) plus this
 * Promise.all pool with a concurrency limit of RPC_CONCURRENCY.
 */
export async function twabNative(
  getBalanceAt: BalanceFetcher,
  accounts: readonly Address[],
  cutoff: bigint,
  windowBlocks: bigint,
  step: bigint = DEFAULT_SAMPLE_STEP,
  concurrency: number = RPC_CONCURRENCY,
): Promise<Map<Address, bigint>> {
  if (step <= 0n) throw new Error("step must be positive");
  const sampleBlocks: bigint[] = [];
  const first = cutoff > windowBlocks ? cutoff - windowBlocks : 0n;
  for (let b = first; b <= cutoff; b += step) sampleBlocks.push(b);
  if (sampleBlocks[sampleBlocks.length - 1] !== cutoff) sampleBlocks.push(cutoff);

  const out = new Map<Address, bigint>();
  await mapWithConcurrency(accounts, concurrency, async (account) => {
    const samples = await mapWithConcurrency(sampleBlocks, concurrency, (b) => getBalanceAt(account, b));
    let sum = 0n;
    for (const s of samples) sum += s;
    out.set(account, sum / BigInt(samples.length));
  });
  return out;
}
