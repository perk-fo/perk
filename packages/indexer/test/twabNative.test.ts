import { describe, expect, test } from "bun:test";
import { concatHex, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import {
  deriveSamplingSeed,
  estimateWindowBlocks,
  mapWithConcurrency,
  samplePlan,
  twabNative,
  type BalanceFetcher,
} from "../src/twabNative";

const A = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
const B = getAddress("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB");
const SEED = keccak256(toHex("perk-test-seed"));

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

const seedOf = (n: number): Hex => keccak256(toHex(`seed-${n}`));

describe("samplePlan", () => {
  test("cuts the window into consecutive strata and samples one block inside each", () => {
    const plan = samplePlan(1000n, 100n, 30n, SEED);
    // [900,930) [930,960) [960,990) [990,1000)
    expect(plan.map((s) => [s.from, s.to])).toEqual([
      [900n, 930n],
      [930n, 960n],
      [960n, 990n],
      [990n, 1000n],
    ]);
    for (const s of plan) {
      expect(s.block).toBeGreaterThanOrEqual(s.from);
      expect(s.block).toBeLessThan(s.to);
    }
    // the cutoff block itself is outside the window [cutoff - W, cutoff)
    expect(plan.some((s) => s.block === 1000n)).toBe(false);
  });

  test("is a pure function of the seed: same seed, same blocks; another seed, other blocks", () => {
    const a = samplePlan(1_000_000n, 30_000n, 300n, SEED).map((s) => s.block);
    const b = samplePlan(1_000_000n, 30_000n, 300n, SEED).map((s) => s.block);
    const c = samplePlan(1_000_000n, 30_000n, 300n, seedOf(2)).map((s) => s.block);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("offsets are spread across the stratum, not fixed to one residue of the cutoff", () => {
    const plan = samplePlan(10_000_017n, 300n * 2016n, 300n, SEED);
    const residues = new Set(plan.map((s) => (s.block - s.from).toString()));
    expect(residues.size).toBeGreaterThan(250); // ~2016 draws over 300 offsets cover nearly all of them
  });

  test("a window reaching past genesis starts at block 0", () => {
    const plan = samplePlan(50n, 100n, 20n, SEED);
    expect(plan[0].from).toBe(0n);
    expect(plan[plan.length - 1].to).toBe(50n);
  });

  test("rejects a non-positive step", () => {
    expect(() => samplePlan(100n, 10n, 0n, SEED)).toThrow();
  });
});

describe("deriveSamplingSeed", () => {
  test("hashes the blocks after the cutoff, and only those", async () => {
    const asked: bigint[] = [];
    const hashOf = (b: bigint): Hex => keccak256(toHex(b));
    const seed = await deriveSamplingSeed(async (b) => {
      asked.push(b);
      return hashOf(b);
    }, 1000n, 4n);
    expect(asked.sort((x, y) => (x < y ? -1 : 1))).toEqual([1001n, 1002n, 1003n, 1004n]);
    expect(seed.fromBlock).toBe(1001n);
    expect(seed.toBlock).toBe(1004n);
    expect(seed.seed).toBe(keccak256(concatHex([hashOf(1001n), hashOf(1002n), hashOf(1003n), hashOf(1004n)])));
  });
});

describe("twabNative", () => {
  test("constant balance → twab == balance", async () => {
    const { fetcher } = fakeBalanceFetcher(new Map([[A, [[0n, 1000n]]]]));
    const twab = await twabNative(fetcher, [A], samplePlan(1000n, 10n, 1n, SEED));
    expect(twab.get(A)).toBe(1000n);
  });

  test("with one-block strata the sample is exact: balance doubling at the midpoint → 1.5x", async () => {
    // window [990, 1000): 100 for 990..994, 200 for 995..999
    const { fetcher } = fakeBalanceFetcher(
      new Map([
        [
          A,
          [
            [0n, 100n],
            [995n, 200n],
          ],
        ],
      ]),
    );
    const twab = await twabNative(fetcher, [A], samplePlan(1000n, 10n, 1n, SEED));
    expect(twab.get(A)).toBe(150n);
  });

  test("a shorter last stratum weighs by its length", async () => {
    // strata [0,8) and [8,10): 80 in the first, 0 in the second → (80*8 + 0*2) / 10 = 64
    const plan = samplePlan(10n, 10n, 8n, SEED);
    const twab = await twabNative(async (_a, b) => (b < 8n ? 80n : 0n), [A], plan);
    expect(twab.get(A)).toBe(64n);
  });

  test("reads exactly the planned blocks for every account", async () => {
    const { fetcher, calls } = fakeBalanceFetcher(new Map([[A, [[0n, 5n]]]]));
    const plan = samplePlan(1000n, 10n, 3n, SEED);
    await twabNative(fetcher, [A, B], plan);
    expect(calls.length).toBe(2 * plan.length);
    for (const who of [A, B]) {
      expect(calls.filter((c) => c.account === who).map((c) => c.block)).toEqual(plan.map((s) => s.block));
    }
  });

  test("multiple accounts sampled independently", async () => {
    const { fetcher } = fakeBalanceFetcher(
      new Map([
        [A, [[0n, 100n]]],
        [B, [[0n, 300n]]],
      ]),
    );
    const twab = await twabNative(fetcher, [A, B], samplePlan(100n, 20n, 5n, SEED));
    expect(twab.get(A)).toBe(100n);
    expect(twab.get(B)).toBe(300n);
  });

  test("never has more reads in flight than the concurrency limit, across all accounts", async () => {
    let active = 0;
    let peak = 0;
    const accounts = Array.from({ length: 20 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    await twabNative(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return 1n;
      },
      accounts,
      samplePlan(10_000n, 400n, 20n, SEED),
      7,
    );
    expect(peak).toBeLessThanOrEqual(7);
    expect(peak).toBeGreaterThan(1);
  });

  test("holding on one residue of the stride no longer buys the TWAB of a week-long holder", async () => {
    // A wallet that holds X on one block in every 300, aligned to the cutoff, got the full TWAB under a fixed stride.
    const X = 1000n * 10n ** 18n;
    const STEP = 300n;
    const W = STEP * 2016n;
    const r = 17n;
    const cutoff = 41_683_800n + r;
    const honest: BalanceFetcher = async () => X;
    const phased: BalanceFetcher = async (_a, b) => (b % STEP === r ? X : 0n);
    const plan = samplePlan(cutoff, W, STEP, seedOf(7));
    const h = (await twabNative(honest, [A], plan)).get(A)!;
    const p = (await twabNative(phased, [A], plan)).get(A)!;
    expect(h).toBe(X);
    // true average is X/300; the stratified sample stays in that neighbourhood, nowhere near X
    expect(p).toBeLessThan(X / 50n);
  });

  test("the phased holder's expected TWAB is its true average", async () => {
    const X = 3000n;
    const STEP = 30n;
    const cutoff = 100_007n;
    const W = STEP * 200n;
    const phased: BalanceFetcher = async (_a, b) => (b % STEP === 7n ? X : 0n);
    let sum = 0n;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      sum += (await twabNative(phased, [A], samplePlan(cutoff, W, STEP, seedOf(100 + i)))).get(A)!;
    }
    const mean = Number(sum) / runs;
    expect(mean).toBeGreaterThan(Number(X / STEP) * 0.7);
    expect(mean).toBeLessThan(Number(X / STEP) * 1.3);
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

  test("stops handing out work after a failure", async () => {
    let started = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    await expect(
      mapWithConcurrency(items, 2, async (i) => {
        started++;
        await new Promise((r) => setTimeout(r, 1));
        if (i === 3) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
    expect(started).toBeLessThan(10);
  });
});
