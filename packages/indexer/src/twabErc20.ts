import { getAddress, toEventSelector, type Address } from "viem";
import { TRANSFER_EVENT } from "./abi";
import { fetchLogsPaged, LOG_PAGE_SIZE, type LogFetcher, type RawLog } from "./optin";

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
 * Replay `Transfer` logs in [fromBlock, cutoff] (use token deployment block, or a --fromBlock
 * override — overriding requires that balances at fromBlock are supplied via `initialBalances`)
 * and build per-holder balance segments.
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
    if (next < 0n) throw new Error(`negative balance for ${account} at block ${blockNumber} (check --fromBlock)`);
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

/** Full pipeline: fetch Transfer logs and return exact per-holder TWAB over the window. */
export async function twabErc20(
  fetchRange: LogFetcher,
  cutoff: bigint,
  windowBlocks: bigint,
  fromBlock: bigint = 0n,
  pageSize: bigint = LOG_PAGE_SIZE,
  initialBalances: Map<Address, bigint> = new Map(),
): Promise<Map<Address, bigint>> {
  const logs = await fetchLogsPaged(fetchRange, fromBlock, cutoff, pageSize);
  const transfers = logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).map(decodeTransfer);
  const segments = buildBalanceSegments(transfers, initialBalances);
  const windowStart = cutoff > windowBlocks ? cutoff - windowBlocks : 0n;
  return twabFromSegments(segments, windowStart, cutoff);
}
