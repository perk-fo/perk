import { getAddress, toEventSelector, type Address } from "viem";
import { OPTED_IN_EVENT } from "./abi";

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
 * LOG_PAGE, the same variable the backend indexer reads, so both follow whichever RPC is configured.
 */
export const LOG_PAGE_SIZE = BigInt(process.env.LOG_PAGE ?? "1000");

/** Page through [fromBlock, toBlock] in ranges of at most `pageSize` blocks. */
export async function fetchLogsPaged(
  fetchRange: LogFetcher,
  fromBlock: bigint,
  toBlock: bigint,
  pageSize: bigint = LOG_PAGE_SIZE,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let from = fromBlock; from <= toBlock; from += pageSize) {
    const to = from + pageSize - 1n > toBlock ? toBlock : from + pageSize - 1n;
    out.push(...(await fetchRange(from, to)));
  }
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
): Promise<Address[]> {
  const logs = await fetchLogsPaged(fetchRange, fromBlock, cutoff, pageSize);
  const set = new Set<Address>();
  for (const log of logs) {
    if (log.topics[0] !== OPTED_IN_TOPIC) continue;
    set.add(decodeOptedInAccount(log));
  }
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
