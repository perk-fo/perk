import { describe, expect, test } from "bun:test";
import { getAddress, padHex, toHex, zeroAddress, type Address } from "viem";
import {
  buildBalanceSegments,
  decodeTransfer,
  findCreationBlock,
  replayErc20,
  resolveReplayStart,
  TRANSFER_TOPIC,
  twabErc20,
  twabFromSegments,
  type Transfer,
} from "../src/twabErc20";
import { fetchLogsPaged, type RawLog } from "../src/optin";

const TOKEN = getAddress("0xc36e4448cfeF79F3bF31C746B8520ef93747fAf6");
const A = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
const B = getAddress("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB");

/** In-memory log store standing in for eth_getLogs. */
function fakeLogFetcher(logs: RawLog[]) {
  const ranges: [bigint, bigint][] = [];
  const fetcher = async (from: bigint, to: bigint): Promise<RawLog[]> => {
    ranges.push([from, to]);
    return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  };
  return { fetcher, ranges };
}

function transferLog(from: Address, to: Address, value: bigint, blockNumber: bigint, logIndex = 0): RawLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, padHex(from, { size: 32 }), padHex(to, { size: 32 })],
    data: toHex(value, { size: 32 }),
    blockNumber,
    logIndex,
  };
}

describe("decodeTransfer", () => {
  test("decodes topics and data", () => {
    const t = decodeTransfer(transferLog(zeroAddress, A, 123n, 10n));
    expect(t).toEqual({ from: zeroAddress, to: A, value: 123n, blockNumber: 10n, logIndex: 0 });
  });
});

describe("twabErc20", () => {
  test("transfers at known blocks integrate to the expected value", () => {
    // Mint 1000 to A at block 10; A sends 400 to B at block 20. Window = [10, 110).
    const transfers: Transfer[] = [
      { from: zeroAddress, to: A, value: 1000n, blockNumber: 10n, logIndex: 0 },
      { from: A, to: B, value: 400n, blockNumber: 20n, logIndex: 0 },
    ];
    const segments = buildBalanceSegments(transfers);
    const twab = twabFromSegments(segments, 10n, 110n);
    // A: 1000 * (20-10) + 600 * (110-20) = 64000 → 640 per block
    expect(twab.get(A)).toBe(640n);
    // B: 400 * (110-20) = 36000 → 360 per block
    expect(twab.get(B)).toBe(360n);
  });

  test("balances before the window count from the window start", () => {
    const transfers: Transfer[] = [{ from: zeroAddress, to: A, value: 500n, blockNumber: 1n, logIndex: 0 }];
    const twab = twabFromSegments(buildBalanceSegments(transfers), 100n, 200n);
    expect(twab.get(A)).toBe(500n); // held flat across the whole window
  });

  test("a holder who sold before the window gets zero", () => {
    const transfers: Transfer[] = [
      { from: zeroAddress, to: A, value: 100n, blockNumber: 1n, logIndex: 0 },
      { from: A, to: B, value: 100n, blockNumber: 50n, logIndex: 0 },
    ];
    const twab = twabFromSegments(buildBalanceSegments(transfers), 100n, 200n);
    expect(twab.has(A)).toBe(false);
    expect(twab.get(B)).toBe(100n);
  });

  test("same-block transfers coalesce (only the end-of-block balance integrates)", () => {
    const transfers: Transfer[] = [
      { from: zeroAddress, to: A, value: 1000n, blockNumber: 10n, logIndex: 0 },
      { from: A, to: B, value: 1000n, blockNumber: 10n, logIndex: 1 },
    ];
    const twab = twabFromSegments(buildBalanceSegments(transfers), 10n, 110n);
    expect(twab.has(A)).toBe(false);
    expect(twab.get(B)).toBe(1000n);
  });

  test("end-to-end through the paged log fetcher", async () => {
    const logs = [
      transferLog(zeroAddress, A, 1000n, 10n),
      transferLog(A, B, 400n, 20n),
      transferLog(zeroAddress, B, 7n, 5000n), // after cutoff — must be excluded
    ];
    const { fetcher, ranges } = fakeLogFetcher(logs);
    const twab = await twabErc20(fetcher, 110n, 100n, 0n, 50n);
    expect(twab.get(A)).toBe(640n);
    expect(twab.get(B)).toBe(360n);
    // 0..110 paged at 50 → [0,49] [50,99] [100,110], no page beyond the cutoff
    expect(ranges).toEqual([
      [0n, 49n],
      [50n, 99n],
      [100n, 110n],
    ]);
  });

  test("rejects balances going negative (bad --fromBlock)", () => {
    const transfers: Transfer[] = [{ from: A, to: B, value: 5n, blockNumber: 10n, logIndex: 0 }];
    expect(() => buildBalanceSegments(transfers)).toThrow();
  });
});

/** eth_getCode for a contract created at `created`. */
function codeFrom(created: bigint) {
  const calls: bigint[] = [];
  const fetcher = async (b: bigint) => {
    calls.push(b);
    return b >= created ? ("0x6080" as const) : ("0x" as const);
  };
  return { fetcher, calls };
}

describe("replay start", () => {
  test("finds the creation block by binary search in a few dozen calls", async () => {
    const { fetcher, calls } = codeFrom(41_290_108n);
    expect(await findCreationBlock(fetcher, 41_794_474n)).toBe(41_290_108n);
    expect(calls.length).toBeLessThan(30);
  });

  test("a contract created at genesis", async () => {
    expect(await findCreationBlock(codeFrom(0n).fetcher, 1000n)).toBe(0n);
  });

  test("no code at the cutoff is an error, not block 0", async () => {
    await expect(findCreationBlock(codeFrom(5000n).fetcher, 1000n)).rejects.toThrow(/no code/);
  });

  test("without configuration the start is discovered", async () => {
    expect(await resolveReplayStart(codeFrom(700n).fetcher, 1000n)).toEqual({ fromBlock: 700n, source: "discovered" });
  });

  test("a configured start at or before creation is accepted", async () => {
    expect(await resolveReplayStart(codeFrom(700n).fetcher, 1000n, 700n)).toEqual({ fromBlock: 700n, source: "configured" });
    expect(await resolveReplayStart(codeFrom(700n).fetcher, 1000n, 650n)).toEqual({ fromBlock: 650n, source: "configured" });
  });

  test("a configured start after the token existed is refused (the replay would be incomplete)", async () => {
    await expect(resolveReplayStart(codeFrom(700n).fetcher, 1000n, 800n)).rejects.toThrow(/incomplete/);
  });

  test("a configured start after the cutoff is refused", async () => {
    await expect(resolveReplayStart(codeFrom(0n).fetcher, 1000n, 1001n)).rejects.toThrow();
  });
});

describe("replayErc20", () => {
  test("holders from before the window keep their balance for the whole window when the replay starts at creation", async () => {
    // Token created (and A funded) at block 100; the window is [900, 1000); A pays B 400 at block 950.
    const logs = [transferLog(zeroAddress, A, 1000n, 100n), transferLog(A, B, 400n, 950n)];
    const { fetcher } = fakeLogFetcher(logs);
    const r = await replayErc20(fetcher, 1000n, 100n, 100n, 1000n);
    expect(r.twab.get(A)).toBe((1000n * 50n + 600n * 50n) / 100n);
    expect(r.twab.get(B)).toBe((400n * 50n) / 100n);
    expect(r.replayedSupply).toBe(1000n);
    expect(r.balancesAtCutoff.get(A)).toBe(600n);
  });

  test("starting the replay after the token existed makes the earlier holder go negative", async () => {
    const logs = [transferLog(zeroAddress, A, 1000n, 100n), transferLog(A, B, 400n, 950n)];
    const { fetcher } = fakeLogFetcher(logs);
    await expect(replayErc20(fetcher, 1000n, 100n, 500n, 1000n)).rejects.toThrow(/negative balance/);
  });

  test("burns reduce the replayed supply", async () => {
    const logs = [transferLog(zeroAddress, A, 1000n, 10n), transferLog(A, zeroAddress, 250n, 20n)];
    const r = await replayErc20(fakeLogFetcher(logs).fetcher, 100n, 50n, 0n, 1000n);
    expect(r.replayedSupply).toBe(750n);
  });
});

describe("fetchLogsPaged", () => {
  const logs = Array.from({ length: 30 }, (_, i) => transferLog(zeroAddress, A, 1n, BigInt(i * 10), 0));

  test("shrinks the page when the provider rejects the range, to the maximum the error states", async () => {
    const ranges: [bigint, bigint][] = [];
    const fetcher = async (from: bigint, to: bigint) => {
      ranges.push([from, to]);
      if (to - from + 1n > 100n) throw new Error("block range greater than 100 max");
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    };
    const out = await fetchLogsPaged(fetcher, 0n, 299n, 1000n);
    expect(out.length).toBe(30);
    // one rejected 300-block request, then 100-block pages only
    expect(ranges).toEqual([
      [0n, 299n],
      [0n, 99n],
      [100n, 199n],
      [200n, 299n],
    ]);
  });

  test("halves the page when the error states no maximum", async () => {
    const ranges: [bigint, bigint][] = [];
    const fetcher = async (from: bigint, to: bigint) => {
      ranges.push([from, to]);
      if (to - from + 1n > 64n) throw new Error("query exceeds max block range");
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    };
    const out = await fetchLogsPaged(fetcher, 0n, 299n, 256n);
    expect(out.map((l) => l.blockNumber)).toEqual(logs.map((l) => l.blockNumber));
    expect(ranges.every(([f, t]) => t - f + 1n <= 256n)).toBe(true);
  });

  test("other failures are not retried as range problems", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      throw new Error("connection refused");
    };
    await expect(fetchLogsPaged(fetcher, 0n, 999n, 100n)).rejects.toThrow("connection refused");
    expect(calls).toBe(1);
  });

  test("pages concurrently up to the limit and still returns logs in order", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = async (from: bigint, to: bigint) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to).reverse();
    };
    const out = await fetchLogsPaged(fetcher, 0n, 299n, 10n, { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(out.map((l) => l.blockNumber)).toEqual(logs.map((l) => l.blockNumber));
  });

  test("a zero page size is rejected instead of looping forever", async () => {
    await expect(fetchLogsPaged(async () => [], 0n, 10n, 0n)).rejects.toThrow();
  });
});
