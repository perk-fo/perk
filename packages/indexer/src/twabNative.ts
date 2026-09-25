import { concatHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** eth_getBalance at a historical block — viem PublicClient adapter in production, in-memory fake in tests. */
export type BalanceFetcher = (account: Address, blockNumber: bigint) => Promise<bigint>;

/** Anything that can return a block's timestamp (for the average-block-time estimate). */
export type BlockTimestampFetcher = (blockNumber: bigint) => Promise<bigint>;

/** Anything that can return a block's hash (for the sampling seed). */
export type BlockHashFetcher = (blockNumber: bigint) => Promise<Hex>;

export const SEVEN_DAYS_SECONDS = 7n * 24n * 3600n;
export const BLOCK_TIME_SAMPLE_SPAN = 1000n;
/** Stratum length in blocks: one balance sample per stratum. */
export const DEFAULT_SAMPLE_STEP = 300n;
/** Blocks after the cutoff whose hashes make up the sampling seed. */
export const DEFAULT_SEED_BLOCKS = 32n;
export const RPC_CONCURRENCY = 10;

/** Identifies the sampling scheme in the dataset, so a verifier knows how to recompute the sample blocks. */
export const SAMPLING_METHOD = "stratified-blockhash-v1";

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
  let failed = false;
  async function worker(): Promise<void> {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true; // stop handing out work; Promise.all rejects with this error
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface SamplingSeed {
  seed: Hex;
  /** First and last block whose hash went into the seed: cutoff + 1 .. cutoff + seedBlocks. */
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The sampling seed: keccak256 of the concatenated hashes of blocks cutoff+1 .. cutoff+seedBlocks. None of these
 * blocks exists when the cutoff is fixed (graduation), so whoever completes graduation, and so picks the cutoff,
 * cannot know which blocks will be sampled.
 */
export async function deriveSamplingSeed(
  getBlockHash: BlockHashFetcher,
  cutoff: bigint,
  seedBlocks: bigint = DEFAULT_SEED_BLOCKS,
): Promise<SamplingSeed> {
  if (seedBlocks <= 0n) throw new Error("seedBlocks must be positive");
  const blocks: bigint[] = [];
  for (let b = cutoff + 1n; b <= cutoff + seedBlocks; b++) blocks.push(b);
  const hashes = await mapWithConcurrency(blocks, blocks.length, getBlockHash);
  return { seed: keccak256(concatHex(hashes)), fromBlock: cutoff + 1n, toBlock: cutoff + seedBlocks };
}

/** One stratum of the window: [from, to) with the single block sampled in it. */
export interface Stratum {
  from: bigint;
  to: bigint;
  block: bigint;
}

/**
 * The sample plan. The window [cutoff - windowBlocks, cutoff) is cut into consecutive strata of `step` blocks (the
 * last may be shorter) and one block is drawn in each: stratum i starting at s with length len samples block
 * s + (uint256(keccak256(abi.encode(bytes32 seed, uint256 i))) mod len). Every block in the window is equally likely
 * to be sampled, so holding the quote only on particular blocks buys nothing in expectation.
 */
export function samplePlan(cutoff: bigint, windowBlocks: bigint, step: bigint, seed: Hex): Stratum[] {
  if (step <= 0n) throw new Error("step must be positive");
  const windowStart = cutoff > windowBlocks ? cutoff - windowBlocks : 0n;
  if (cutoff <= windowStart) throw new Error("cutoff must be after the window start");
  const plan: Stratum[] = [];
  let i = 0n;
  for (let from = windowStart; from < cutoff; from += step, i++) {
    const to = from + step < cutoff ? from + step : cutoff;
    const draw = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, i])));
    plan.push({ from, to, block: from + (draw % (to - from)) });
  }
  return plan;
}

/**
 * Sampled TWAB per account: each stratum's sampled balance weighted by the stratum's length, divided by the window
 * length (floor). Every (account, block) read goes through one pool bounded by `concurrency`, so the number of
 * calls in flight never exceeds it.
 */
export async function twabNative(
  getBalanceAt: BalanceFetcher,
  accounts: readonly Address[],
  plan: readonly Stratum[],
  concurrency: number = RPC_CONCURRENCY,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<Address, bigint>> {
  if (plan.length === 0) throw new Error("empty sample plan");
  const windowLen = plan[plan.length - 1].to - plan[0].from;
  const weighted = new Array<bigint>(accounts.length).fill(0n);
  const total = accounts.length * plan.length;
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < total && !failed) {
      const k = next++;
      const a = Math.floor(k / plan.length);
      const s = plan[k % plan.length];
      try {
        // read first, then add: `weighted[a] += await …` would read weighted[a] before the await and lose updates
        const balance = await getBalanceAt(accounts[a], s.block);
        weighted[a] += balance * (s.to - s.from);
      } catch (err) {
        failed = true;
        throw err;
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));

  const out = new Map<Address, bigint>();
  accounts.forEach((account, a) => out.set(account, weighted[a] / windowLen));
  return out;
}
