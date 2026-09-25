import { getAddress, toEventSelector, type Address } from "viem";
import { OPTED_IN_EVENT } from "./abi";
import { isLogRangeError, logRangeHint, positiveInt } from "./rpc";

/** Minimal shape of an eth_getLogs entry the indexer consumes. */
export interface RawLog {
  address: Address;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

/** Anything that can page eth_getLogs — a viem PublicClient adapter in production, an in-memory fake in tests. */
export type LogFetcher = (fromBlock: bigint, toBlock: bigint) => Promise<RawLog[]>;

/**
 * Blocks per eth_getLogs request. Alchemy allows 1,000 on X Layer; the public X Layer endpoints allow 100. Set with
 * LOG_PAGE, the same variable the backend indexer reads, so both follow whichever RPC is configured. A provider that
 * rejects a range as too wide makes the pager shrink its page for the rest of the scan, so a wrong LOG_PAGE costs a
 * few failed requests rather than the whole run.
 */
export const LOG_PAGE_SIZE = BigInt(positiveInt(process.env.LOG_PAGE, 1000, "LOG_PAGE"));

export interface PagingOptions {
  /** Pages in flight at once (default 1: strictly sequential). */
  concurrency?: number;
  /** Which failures mean "range too wide" and should shrink the page instead of failing (default: isLogRangeError). */
  isRangeError?: (err: unknown) => boolean;
  /** Called after each page with the blocks scanned so far and the total. */
  onProgress?: (blocksDone: bigint, blocksTotal: bigint) => void;
}

/**
 * Page through [fromBlock, toBlock] in ranges of at most `pageSize` blocks, up to `concurrency` pages at a time.
 * When the provider rejects a range as too wide, the page shrinks (to the provider's stated maximum when its error
 * gives one, else by half) and the range is retried; a one-block range that still fails is a real error.
 */
export async function fetchLogsPaged(
  fetchRange: LogFetcher,
  fromBlock: bigint,
  toBlock: bigint,
  pageSize: bigint = LOG_PAGE_SIZE,
  opts: PagingOptions = {},
): Promise<RawLog[]> {
  if (pageSize <= 0n) throw new Error("log page size must be positive (LOG_PAGE)");
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const isRangeError = opts.isRangeError ?? isLogRangeError;
  const out: RawLog[] = [];
  if (toBlock < fromBlock) return out;

  let page = pageSize;
  let cursor = fromBlock; // first block not yet handed out
  const retry: [bigint, bigint][] = []; // ranges handed back after a range error, served first
  let failure: unknown;
  let failed = false;
  const total = toBlock - fromBlock + 1n;
  let done = 0n;

  const take = (): [bigint, bigint] | undefined => {
    const r = retry.shift();
    if (r) return r;
    if (cursor > toBlock) return undefined;
    const to = cursor + page - 1n > toBlock ? toBlock : cursor + page - 1n;
    const range: [bigint, bigint] = [cursor, to];
    cursor = to + 1n;
    return range;
  };

  const worker = async (): Promise<void> => {
    for (let r = take(); r && !failed; r = take()) {
      let [from, to] = r;
      if (to - from + 1n > page) {
        // the page shrank after this range was cut: fetch the head now, hand the tail back
        retry.unshift([from + page, to]);
        to = from + page - 1n;
      }
      try {
        out.push(...(await fetchRange(from, to)));
        done += to - from + 1n;
        opts.onProgress?.(done, total);
      } catch (err) {
        if (from === to || !isRangeError(err)) {
          failed = true;
          failure = err;
          return;
        }
        const size = to - from + 1n;
        const hint = logRangeHint(err);
        const smaller = hint !== undefined && hint < size ? hint : size / 2n;
        if (smaller < page) page = smaller > 0n ? smaller : 1n;
        retry.unshift([from, to]);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failed) throw failure;

  out.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  return out;
}

/** Decode the indexed account topic of an `OptedIn` log. */
export function decodeOptedInAccount(log: RawLog): Address {
  if (log.topics.length < 2) throw new Error("OptedIn log missing account topic");
  return getAddress(`0x${log.topics[1].slice(26)}`);
}

export const OPTED_IN_TOPIC = toEventSelector(OPTED_IN_EVENT);

/**
 * Collect the opt-in set from `OptedIn` logs in [fromBlock, cutoff].
 * Returns checksummed, deduplicated, sorted addresses for a deterministic dataset.
 */
export async function collectOptIns(
  fetchRange: LogFetcher,
  cutoff: bigint,
  fromBlock: bigint = 0n,
  pageSize: bigint = LOG_PAGE_SIZE,
  paging: PagingOptions = {},
): Promise<Address[]> {
  const logs = await fetchLogsPaged(fetchRange, fromBlock, cutoff, pageSize, paging);
  const set = new Set<Address>();
  for (const log of logs) {
    if (log.topics[0] !== OPTED_IN_TOPIC) continue;
    set.add(decodeOptedInAccount(log));
  }
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
