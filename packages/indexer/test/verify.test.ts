import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { computeAllocations } from "../src/allocations";
import { CampaignStatus } from "../src/abi";
import type { CampaignView } from "../src/chain";
import { buildDataset, leavesFromDataset, parseDataset, recomputeRoot, type SnapshotDataset } from "../src/dataset";
import { buildTree, verifyProof, type LeafTuple } from "../src/merkle";
import { checkAgainstCampaign, checkDataset, compareRecomputed } from "../src/verify";

function account(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

const MEME = getAddress("0xb4E911d58E50aC6B6020c391790EbdCc8dCD5668");
const QUOTE = getAddress("0x0000000000000000000000000000000000000000");

function makeDataset(): SnapshotDataset {
  const inputs = [1, 2, 3, 4].map((i) => ({ account: account(i), twab: 1000n * BigInt(i) }));
  const result = computeAllocations(inputs, 10n ** 24n, 10n ** 23n, 0n, new Map());
  const leaves: LeafTuple[] = result.allocations.map((a) => [a.account, a.base, a.boost]);
  const tree = buildTree(leaves);
  return buildDataset({
    chainId: 1952,
    meme: MEME,
    quote: QUOTE,
    cutoffBlock: 41179664n,
    windowBlocks: 302400n,
    step: 300n,
    basePool: 10n ** 24n,
    referralBudget: 10n ** 23n,
    minAllocation: 0n,
    boostScaled: result.boostScaled,
    eligibleAccounts: inputs.length,
    fromBlock: 0n,
    allocations: result.allocations,
    root: tree.root,
    generatedAt: new Date("2026-09-17T00:00:00Z"),
  });
}

describe("dataset + verify", () => {
  test("recomputed root matches an untampered dataset", () => {
    const dataset = makeDataset();
    const { matches } = recomputeRoot(dataset);
    expect(matches).toBe(true);
  });

  test("survives a JSON round-trip (bigints as decimal strings)", () => {
    const dataset = parseDataset(JSON.stringify(makeDataset()));
    expect(recomputeRoot(dataset).matches).toBe(true);
    expect(dataset.totals.accounts).toBe(4);
    expect(dataset.toolVersion).toBeTruthy();
  });

  test("detects a tampered allocation (verify CLI logic → MISMATCH)", () => {
    const dataset = makeDataset();
    const tampered: SnapshotDataset = structuredClone(dataset);
    tampered.allocations[0].base = (BigInt(tampered.allocations[0].base) + 1n).toString();
    const { matches, root } = recomputeRoot(tampered);
    expect(matches).toBe(false);
    expect(root).not.toBe(tampered.root);
  });

  test("detects a tampered root", () => {
    const dataset = makeDataset();
    dataset.root = `0x${"11".repeat(32)}`;
    expect(recomputeRoot(dataset).matches).toBe(false);
  });

  test("rejects malformed datasets", () => {
    expect(() => parseDataset("{}")).toThrow();
    const dataset = makeDataset();
    dataset.allocations[0].account = "not-an-address" as Address;
    expect(() => leavesFromDataset(dataset)).toThrow();
  });

  test("proofs from the dataset leaves verify against the root", () => {
    const dataset = makeDataset();
    const leaves = leavesFromDataset(dataset);
    const tree = buildTree(leaves);
    for (const [acc, base, boost] of leaves) {
      expect(verifyProof(dataset.root, acc, base, boost, tree.proofFor(acc))).toBe(true);
    }
  });
});

/** A dataset whose root honestly commits to `allocations`, with whatever totals the leaves give. */
function datasetWith(
  allocations: { account: Address; twab: bigint; base: bigint; boost: bigint }[],
  extra: Partial<Parameters<typeof buildDataset>[0]> = {},
): SnapshotDataset {
  const tree = buildTree(allocations.map((a) => [a.account, a.base, a.boost] as LeafTuple));
  return buildDataset({
    chainId: 1952,
    meme: MEME,
    quote: QUOTE,
    cutoffBlock: 1n,
    windowBlocks: 1n,
    step: 1n,
    basePool: 1000n,
    referralBudget: 250n,
    minAllocation: 0n,
    boostScaled: false,
    eligibleAccounts: allocations.length,
    fromBlock: 0n,
    allocations,
    root: tree.root,
    ...extra,
  });
}

function campaign(over: Partial<CampaignView> = {}): CampaignView {
  return {
    status: CampaignStatus.ROOT_PROPOSED,
    quote: QUOTE,
    hooks: account(0xbb),
    graduatedAtBlock: 41179664n,
    basePool: 10n ** 24n,
    referralBudget: 10n ** 23n,
    root: `0x${"00".repeat(32)}`,
    rootUri: "ipfs://x",
    rootTotalBase: 0n,
    rootTotalInviteeBoost: 0n,
    ...over,
  };
}

describe("checkDataset", () => {
  test("a dataset built by the tool passes", () => {
    expect(checkDataset(makeDataset()).problems).toEqual([]);
  });

  test("an older dataset without the new fields still passes", () => {
    const old = makeDataset() as unknown as Record<string, unknown>;
    const inputs = old.inputs as Record<string, unknown>;
    delete inputs.eligibleTwab;
    old.toolVersion = "0.1.0";
    expect(checkDataset(parseDataset(JSON.stringify(old))).problems).toEqual([]);
  });

  test("leaves that over-allocate the base pool behind within-budget totals, with a duplicate account, are rejected", () => {
    const A = getAddress("0x1000000000000000000000000000000000000001");
    const B = getAddress("0x2000000000000000000000000000000000000002");
    const d = datasetWith([
      { account: A, twab: 1n, base: 900n, boost: 0n },
      { account: B, twab: 1n, base: 900n, boost: 0n },
      { account: A, twab: 1n, base: 5n, boost: 0n },
    ]);
    d.totals.base = "905"; // what would be declared on chain: within basePool
    expect(recomputeRoot(d).matches).toBe(true); // the root alone says nothing is wrong
    const { problems, sums } = checkDataset(d);
    expect(sums.base).toBe(1805n);
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
    expect(problems.some((p) => p.includes("more than basePool 1000"))).toBe(true);
    expect(problems.some((p) => p.includes("totals.base is 905"))).toBe(true);
  });

  test("duplicates are found case-insensitively", () => {
    const A = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
    const d = datasetWith([{ account: A, twab: 1n, base: 10n, boost: 0n }]);
    d.allocations.push({ ...d.allocations[0], account: A.toLowerCase() as Address, base: "1" });
    expect(checkDataset(d).problems.some((p) => p.includes("duplicate"))).toBe(true);
  });

  test("excluded accounts are rejected: the dataset's list, the verifier's list, and always zero / 0xdead / meme", () => {
    const system = account(0x51);
    const listed = account(0x52);
    const d = datasetWith(
      [
        { account: account(1), twab: 1n, base: 10n, boost: 0n },
        { account: system, twab: 1n, base: 10n, boost: 0n },
        { account: listed, twab: 1n, base: 10n, boost: 0n },
        { account: getAddress("0x000000000000000000000000000000000000dEaD"), twab: 1n, base: 10n, boost: 0n },
        { account: MEME, twab: 1n, base: 10n, boost: 0n },
      ],
      { excluded: [listed] },
    );
    const problems = checkDataset(d, { excluded: [system] }).problems.filter((p) => p.includes("excluded"));
    expect(problems.length).toBe(4);
  });

  test("boosts above 10% of base, bases below minAllocation and bases that do not follow from the twab are rejected", () => {
    const d = datasetWith(
      [
        { account: account(1), twab: 300n, base: 300n, boost: 31n },
        { account: account(2), twab: 100n, base: 99n, boost: 0n },
        { account: account(3), twab: 1n, base: 1n, boost: 0n },
      ],
      { minAllocation: 2n, eligibleTwab: 1000n },
    );
    const problems = checkDataset(d).problems;
    expect(problems.some((p) => p.includes("more than 10%"))).toBe(true);
    expect(problems.some((p) => p.includes("below minAllocation"))).toBe(true);
    expect(problems.some((p) => p.includes("its twab 100 gives 100"))).toBe(true);
  });

  test("boosts beyond the referral budget are rejected", () => {
    const d = datasetWith([
      { account: account(1), twab: 1n, base: 1000n, boost: 100n },
      { account: account(2), twab: 1n, base: 2000n, boost: 200n },
    ]);
    const problems = checkDataset(d).problems;
    expect(problems.some((p) => p.includes("more than referralBudget 250"))).toBe(true);
  });

  test("malformed leaves are reported instead of crashing", () => {
    const d = makeDataset();
    d.allocations[1].base = "-5";
    d.allocations[2].account = "0x123" as Address;
    const problems = checkDataset(d).problems;
    expect(problems.some((p) => p.includes("#1 base"))).toBe(true);
    expect(problems.some((p) => p.includes("#2 has no valid account"))).toBe(true);
  });
});

describe("checkAgainstCampaign", () => {
  const d = makeDataset();
  const sums = checkDataset(d).sums;

  test("a proposed root that matches the dataset and was declared with the leaf sums passes", () => {
    const c = campaign({ root: d.root, rootTotalBase: sums.base, rootTotalInviteeBoost: sums.boost });
    expect(checkAgainstCampaign(d, sums, { chainId: 1952, campaign: c }, { expectRoot: true })).toEqual([]);
  });

  test("declared totals below the leaf sums are caught", () => {
    const c = campaign({ root: d.root, rootTotalBase: sums.base - 1n, rootTotalInviteeBoost: sums.boost });
    const p = checkAgainstCampaign(d, sums, { chainId: 1952, campaign: c }, { expectRoot: true });
    expect(p.some((x) => x.includes("totalBase"))).toBe(true);
  });

  test("another root, another chain, another quote, cutoff or budget are caught", () => {
    const c = campaign({
      root: `0x${"11".repeat(32)}`,
      quote: account(0x70),
      graduatedAtBlock: 5n,
      basePool: 1n,
      rootTotalBase: sums.base,
      rootTotalInviteeBoost: sums.boost,
    });
    const p = checkAgainstCampaign(d, sums, { chainId: 196, campaign: c }, { expectRoot: true });
    for (const needle of ["serves chain 196", "on-chain root", "quote", "cutoff", "basePool"]) {
      expect(p.some((x) => x.includes(needle))).toBe(true);
    }
  });

  test("before proposing, the campaign must be waiting for a root", () => {
    const waiting = campaign({ status: CampaignStatus.AWAITING_ROOT });
    expect(checkAgainstCampaign(d, sums, { chainId: 1952, campaign: waiting }, { expectRoot: false })).toEqual([]);
    const active = campaign({ status: CampaignStatus.ACTIVE });
    expect(checkAgainstCampaign(d, sums, { chainId: 1952, campaign: active }, { expectRoot: false })[0]).toContain("ACTIVE");
  });

  test("no campaign at all", () => {
    const none = campaign({ status: CampaignStatus.NONE });
    expect(checkAgainstCampaign(d, sums, { chainId: 1952, campaign: none }, { expectRoot: true })[0]).toContain(
      "no grant campaign",
    );
  });
});

describe("compareRecomputed", () => {
  test("same root → nothing to report; otherwise the differing leaves are named", () => {
    const d = makeDataset();
    expect(compareRecomputed(d, d)).toEqual([]);
    const other = structuredClone(d);
    other.allocations[0].base = "1";
    other.root = `0x${"22".repeat(32)}`;
    const p = compareRecomputed(d, other);
    expect(p[0]).toContain("recomputing");
    expect(p.some((x) => x.includes(d.allocations[0].account))).toBe(true);
  });
});
