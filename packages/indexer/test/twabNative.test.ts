import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { estimateWindowBlocks, mapWithConcurrency, twabNative, type BalanceFetcher } from "../src/twabNative";

const A = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
const B = getAddress("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB");

/** In-memory fake eth_getBalance: balances[account] is a list of [fromBlock, balance] segments. */
function fakeBalanceFetcher(history: Map<Address, [bigint, bigint][]>) {
  const calls: { account: Address; block: bigint }[] = [];
  const fetcher: BalanceFetcher = async (account, blockNumber) => {
    calls.push({ account, block: blockNumber });
    const segs = history.get(account) ?? [];
    let bal = 0n;
    for (const [from, b] of segs) {
      if (from <= blockNumber) bal = b;
      else break;
    }
    return bal;
  };
  return { fetcher, calls };
}

describe("twabNative", () => {
  test("constant balance → twab == balance", async () => {
    const { fetcher } = fakeBalanceFetcher(new Map([[A, [[0n, 1000n]]]]));
    const twab = await twabNative(fetcher, [A], 1000n, 10n, 1n);
    expect(twab.get(A)).toBe(1000n);
  });

  test("balance doubling at the midpoint → twab == 1.5x (step aligned to the midpoint)", async () => {
    // cutoff=1000, window=10, step=2 → samples at 990, 992, 994, 996, 998, 1000.
    // Balance is 100 before block 995 and 200 from 995 on: 3 samples each side.
    const { fetcher } = fakeBalanceFetcher(
      new Map([[A, [
        [0n, 100n],
        [995n, 200n],
      ]]]),
    );
    const twab = await twabNative(fetcher, [A], 1000n, 10n, 2n);
    expect(twab.get(A)).toBe(150n);
  });

  test("samples exactly the expected blocks, endpoints included", async () => {
    const { fetcher, calls } = fakeBalanceFetcher(new Map([[A, [[0n, 5n]]]]));
    await twabNative(fetcher, [A], 1000n, 10n, 3n);
    // 990, 993, 996, 999, then cutoff appended because 999 + 3 > 1000
    expect(calls.map((c) => c.block)).toEqual([990n, 993n, 996n, 999n, 1000n]);
  });

  test("multiple accounts sampled independently", async () => {
    const { fetcher } = fakeBalanceFetcher(
      new Map([
        [A, [[0n, 100n]]],
        [B, [[0n, 300n]]],
      ]),
    );
    const twab = await twabNative(fetcher, [A, B], 100n, 20n, 5n);
    expect(twab.get(A)).toBe(100n);
    expect(twab.get(B)).toBe(300n);
  });

  test("rejects a non-positive step", async () => {
    const { fetcher } = fakeBalanceFetcher(new Map());
    await expect(twabNative(fetcher, [A], 100n, 10n, 0n)).rejects.toThrow();
  });
});

describe("estimateWindowBlocks", () => {
  test("derives a 7-day window from the average block time over the span", async () => {
    // 2s blocks: t(n) = 1_000_000 + 2n. span = 1000 blocks before cutoff 5000.
    const ts = async (b: bigint) => 1_000_000n + 2n * b;
    const { windowBlocks, avgBlockTimeMs } = await estimateWindowBlocks(ts, 5000n);
    expect(avgBlockTimeMs).toBe(2000n);
    expect(windowBlocks).toBe((7n * 24n * 3600n * 1000n) / 2000n); // 302400
  });
});

describe("mapWithConcurrency", () => {
  test("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 20, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(20);
  });
});
