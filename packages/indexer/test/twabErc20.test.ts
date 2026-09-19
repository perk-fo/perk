import { describe, expect, test } from "bun:test";
import { getAddress, padHex, toHex, zeroAddress, type Address } from "viem";
import { buildBalanceSegments, decodeTransfer, TRANSFER_TOPIC, twabErc20, twabFromSegments, type Transfer } from "../src/twabErc20";
import type { RawLog } from "../src/optin";

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
