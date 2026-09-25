import { getAddress, toEventSelector, type Address, type Hex } from "viem";
import { TRANSFER_EVENT } from "./abi";
import { fetchLogsPaged, LOG_PAGE_SIZE, type LogFetcher, type PagingOptions, type RawLog } from "./optin";

export const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT);

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface Transfer {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
}

/** Decode an ERC-20 `Transfer` log (from = topic 1, to = topic 2, value in data). */
export function decodeTransfer(log: RawLog): Transfer {
  if (log.topics.length < 3) throw new Error("Transfer log missing topics");
  return {
    from: getAddress(`0x${log.topics[1].slice(26)}`),
    to: getAddress(`0x${log.topics[2].slice(26)}`),
    value: BigInt(log.data),
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

/**
 * A holder's balance history: segment i means `balance` held from `fromBlock` (inclusive)
 * until the next segment's `fromBlock` (exclusive), or indefinitely for the last segment.
 */
export interface BalanceSegment {
  fromBlock: bigint;
  balance: bigint;
}

/**
 * Replay `Transfer` logs in [fromBlock, cutoff] and build per-holder balance segments. The replay is only exact when
 * it starts at or before the token's creation block (see `resolveReplayStart`), or when the balances at `fromBlock`
 * are supplied via `initialBalances`.
 */
export function buildBalanceSegments(
  transfers: readonly Transfer[],
  initialBalances: Map<Address, bigint> = new Map(),
): Map<Address, BalanceSegment[]> {
  const sorted = [...transfers].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const balances = new Map<Address, bigint>(initialBalances);
  const segments = new Map<Address, BalanceSegment[]>();

  const apply = (account: Address, delta: bigint, blockNumber: bigint): void => {
    if (account === ZERO) return;
    const prev = balances.get(account) ?? 0n;
    const next = prev + delta;
    if (next < 0n) {
      throw new Error(
        `negative balance for ${account} at block ${blockNumber}: the Transfer replay did not start at the quote token's creation`,
      );
    }
    balances.set(account, next);
    let segs = segments.get(account);
    if (!segs) {
      segs = [{ fromBlock: 0n, balance: prev }];
      segments.set(account, segs);
    }
    // Coalesce same-block updates: only the final balance of a block matters for integration.
    if (segs[segs.length - 1].fromBlock === blockNumber) {
      segs[segs.length - 1].balance = next;
    } else {
      segs.push({ fromBlock: blockNumber, balance: next });
    }
  };

  for (const t of sorted) {
    apply(t.from, -t.value, t.blockNumber);
    apply(t.to, t.value, t.blockNumber);
  }
  return segments;
}

/**
 * Exact TWAB over [windowStart, cutoff]: integrate each holder's balance segments over the
 * window and divide by the window length (floor). Holders whose integral is zero are omitted.
 */
export function twabFromSegments(
  segments: Map<Address, BalanceSegment[]>,
  windowStart: bigint,
  cutoff: bigint,
): Map<Address, bigint> {
  if (cutoff <= windowStart) throw new Error("cutoff must be after windowStart");
  const windowLen = cutoff - windowStart;
  const out = new Map<Address, bigint>();
  for (const [account, segs] of segments) {
    let integral = 0n;
    for (let i = 0; i < segs.length; i++) {
      const segStart = segs[i].fromBlock;
      const segEnd = i + 1 < segs.length ? segs[i + 1].fromBlock : cutoff;
      // Balance applies from the block the transfer is included in, so the segment
      // covers [segStart, segEnd). Clip to the window and integrate.
      const start = segStart > windowStart ? segStart : windowStart;
      const end = segEnd < cutoff ? segEnd : cutoff;
      if (end > start && segs[i].balance > 0n) integral += segs[i].balance * (end - start);
    }
    const twab = integral / windowLen;
    if (twab > 0n) out.set(account, twab);
  }
  return out;
}

/** Each holder's balance after the last replayed block (the last segment), zero balances omitted. */
export function finalBalances(segments: Map<Address, BalanceSegment[]>): Map<Address, bigint> {
  const out = new Map<Address, bigint>();
  for (const [account, segs] of segments) {
    const last = segs[segs.length - 1].balance;
    if (last > 0n) out.set(account, last);
  }
  return out;
}

export interface Erc20Replay {
  /** Exact TWAB over [cutoff - windowBlocks, cutoff) per holder, zero omitted. */
  twab: Map<Address, bigint>;
  /** Replayed balance of every holder at the end of the cutoff block. */
  balancesAtCutoff: Map<Address, bigint>;
  /** Sum of `balancesAtCutoff`: equals totalSupply() at the cutoff when the replay is complete. */
  replayedSupply: bigint;
  transfers: number;
}

/** Fetch Transfer logs in [fromBlock, cutoff] and return the TWAB plus the end balances used by the supply check. */
export async function replayErc20(
  fetchRange: LogFetcher,
  cutoff: bigint,
  windowBlocks: bigint,
  fromBlock: bigint = 0n,
  pageSize: bigint = LOG_PAGE_SIZE,
  initialBalances: Map<Address, bigint> = new Map(),
  paging: PagingOptions = {},
): Promise<Erc20Replay> {
  const logs = await fetchLogsPaged(fetchRange, fromBlock, cutoff, pageSize, paging);
  const transfers = logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).map(decodeTransfer);
  const segments = buildBalanceSegments(transfers, initialBalances);
  const windowStart = cutoff > windowBlocks ? cutoff - windowBlocks : 0n;
  const balancesAtCutoff = finalBalances(segments);
  let replayedSupply = 0n;
  for (const b of balancesAtCutoff.values()) replayedSupply += b;
  return { twab: twabFromSegments(segments, windowStart, cutoff), balancesAtCutoff, replayedSupply, transfers: transfers.length };
}

/** Full pipeline: fetch Transfer logs and return exact per-holder TWAB over the window. */
export async function twabErc20(
  fetchRange: LogFetcher,
  cutoff: bigint,
  windowBlocks: bigint,
  fromBlock: bigint = 0n,
  pageSize: bigint = LOG_PAGE_SIZE,
  initialBalances: Map<Address, bigint> = new Map(),
  paging: PagingOptions = {},
): Promise<Map<Address, bigint>> {
  return (await replayErc20(fetchRange, cutoff, windowBlocks, fromBlock, pageSize, initialBalances, paging)).twab;
}

/** eth_getCode at a block: "0x" (or empty) when no contract existed there yet. */
export type CodeFetcher = (blockNumber: bigint) => Promise<Hex | undefined>;

const hasCode = (code: Hex | undefined): boolean => code !== undefined && code !== "0x" && code !== "0x0";

/**
 * The block a token contract was created in: the lowest block at which it has code, by binary search over
 * [0, atBlock] (about 26 eth_getCode calls on X Layer). Needs an archive endpoint.
 */
export async function findCreationBlock(getCodeAt: CodeFetcher, atBlock: bigint): Promise<bigint> {
  if (!hasCode(await getCodeAt(atBlock))) throw new Error(`the quote token has no code at block ${atBlock}`);
  let lo = 0n; // lowest candidate
  let hi = atBlock; // known to have code
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (hasCode(await getCodeAt(mid))) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Where the Transfer replay starts. An explicit start (a flag or quote-assets.json) is taken as given and then
 * checked; otherwise the creation block is discovered. Either way the replay is refused unless the token had no code
 * in the block before the start: a replay that begins after the token existed misses the balances held before it,
 * so pre-existing holders would go negative or silently count as zero for part of the window.
 */
export async function resolveReplayStart(
  getCodeAt: CodeFetcher,
  cutoff: bigint,
  configured?: bigint,
): Promise<{ fromBlock: bigint; source: "configured" | "discovered" }> {
  if (configured === undefined) {
    return { fromBlock: await findCreationBlock(getCodeAt, cutoff), source: "discovered" };
  }
  if (configured > cutoff) throw new Error(`the replay start ${configured} is after the cutoff ${cutoff}`);
  if (configured > 0n && hasCode(await getCodeAt(configured - 1n))) {
    throw new Error(
      `the quote token already existed at block ${configured - 1n}, so a Transfer replay from ${configured} is incomplete; ` +
        "start at or before its creation block (omit the start to discover it)",
    );
  }
  return { fromBlock: configured, source: "configured" };
}
