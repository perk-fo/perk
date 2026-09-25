import { describe, expect, test } from "bun:test";
import { concatHex, getAddress, keccak256, padHex, toHex, zeroAddress, type Address, type Hex } from "viem";
import { CampaignStatus } from "../src/abi";
import type { CampaignView, ChainReader } from "../src/chain";
import { deploymentSystemAddresses, type Deployment } from "../src/config";
import { DEAD_ADDRESS } from "../src/exclusions";
import { OPTED_IN_TOPIC, type RawLog } from "../src/optin";
import { INVITER_BOUND_TOPIC } from "../src/referrals";
import { runSnapshot, type SnapshotOptions } from "../src/snapshot";
import { TRANSFER_TOPIC } from "../src/twabErc20";
import { samplePlan } from "../src/twabNative";
import { checkDataset, requiredExclusions } from "../src/verify";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const RAW_DEPLOYMENT = {
  blockNumber: 5000,
  deployer: addr(0xd0),
  protocolOwner: addr(0xd1),
  protocolFeeRecipient: addr(0xd2),
  poolManager: addr(0x51),
  positionManager: addr(0x52),
  curve: addr(0x53),
  feeRouter: addr(0x54),
  distributor: addr(0x55),
  treasury: addr(0x56),
  lpGrantVault: addr(0x57),
  locker: addr(0x58),
  hook: addr(0x59),
  factory: addr(0x5a),
  referralRegistry: addr(0x5b),
  templateRegistry: addr(0x5c),
  quoter: zeroAddress,
  quoteAssets: { tQUOTE: addr(0x70) },
};

const DEPLOYMENT: Deployment = {
  chainId: 1952,
  deploymentsPath: "test",
  deploymentBlock: 5000n,
  addresses: {
    referralRegistry: RAW_DEPLOYMENT.referralRegistry,
    lpGrantVault: RAW_DEPLOYMENT.lpGrantVault,
    factory: RAW_DEPLOYMENT.factory,
    templateRegistry: RAW_DEPLOYMENT.templateRegistry,
  },
  systemAddresses: deploymentSystemAddresses(RAW_DEPLOYMENT),
};

const MEME = addr(0x1111);
const TOKEN = RAW_DEPLOYMENT.quoteAssets.tQUOTE;
const A = addr(0xa1);
const B = addr(0xb1);
const C = addr(0xc1);

const topicOf = (a: Address): Hex => padHex(a, { size: 32 });
const transfer = (from: Address, to: Address, value: bigint, block: bigint, logIndex = 0): RawLog => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
  data: toHex(value, { size: 32 }),
  blockNumber: block,
  logIndex,
});
const optIn = (account: Address, block: bigint): RawLog => ({
  address: RAW_DEPLOYMENT.referralRegistry,
  topics: [OPTED_IN_TOPIC, topicOf(account)],
  data: toHex(block, { size: 32 }),
  blockNumber: block,
  logIndex: 0,
});
const bind = (invitee: Address, inviter: Address, block: bigint): RawLog => ({
  address: RAW_DEPLOYMENT.referralRegistry,
  topics: [INVITER_BOUND_TOPIC, topicOf(invitee), topicOf(inviter)],
  data: toHex(block, { size: 32 }),
  blockNumber: block,
  logIndex: 1,
});

interface FakeChain {
  chainId?: number;
  head: bigint;
  campaign: Partial<CampaignView> & { quote: Address; graduatedAtBlock: bigint };
  logs: RawLog[];
  tokenCreatedAt?: bigint;
  nativeBalance?: (account: Address, block: bigint) => bigint;
  supplyOverride?: bigint;
}

const blockHash = (b: bigint): Hex => keccak256(toHex(`block-${b}`));

function fakeReader(f: FakeChain) {
  const balanceReads: { account: Address; block: bigint }[] = [];
  const tokenBalance = (account: Address | null, block: bigint): bigint => {
    let bal = 0n;
    for (const l of f.logs) {
      if (l.address !== TOKEN || l.topics[0] !== TRANSFER_TOPIC || l.blockNumber > block) continue;
      const from = getAddress(`0x${l.topics[1].slice(26)}`);
      const to = getAddress(`0x${l.topics[2].slice(26)}`);
      const v = BigInt(l.data);
      if (account === null) {
        if (from === zeroAddress) bal += v;
        if (to === zeroAddress) bal -= v;
      } else {
        if (to === account) bal += v;
        if (from === account) bal -= v;
      }
    }
    return bal;
  };
  const reader: ChainReader = {
    getChainId: async () => f.chainId ?? 1952,
    getBlockNumber: async () => f.head,
    getBlockTimestamp: async (b) => 1_700_000_000n + b,
    getBlockHash: async (b) => blockHash(b),
    getCode: async (a, b) =>
      a === TOKEN && f.tokenCreatedAt !== undefined && b >= f.tokenCreatedAt ? ("0x6080" as Hex) : ("0x" as Hex),
    getBalance: async (account, block) => {
      balanceReads.push({ account, block });
      return f.nativeBalance?.(account, block) ?? 0n;
    },
    getLogs: async (address, topic0, from, to) =>
      f.logs.filter(
        (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === topic0 && l.blockNumber >= from && l.blockNumber <= to,
      ),
    readCampaign: async () => ({
      status: CampaignStatus.AWAITING_ROOT,
      hooks: RAW_DEPLOYMENT.hook,
      basePool: 1_000_000n,
      referralBudget: 100_000n,
      root: `0x${"00".repeat(32)}`,
      rootUri: "",
      rootTotalBase: 0n,
      rootTotalInviteeBoost: 0n,
      ...f.campaign,
    }),
    readTotalSupply: async (_t, block) => f.supplyOverride ?? tokenBalance(null, block),
    readBalanceOf: async (_t, account, block) => tokenBalance(account, block),
  };
  return { reader, balanceReads };
}

const OPTIONS: SnapshotOptions = {
  chainId: 1952,
  meme: MEME,
  deployment: DEPLOYMENT,
  minAllocation: 0n,
  windowBlocks: 1000n,
  step: 50n,
  confirmations: 64n,
  seedBlocks: 8n,
  concurrency: 4,
  logPage: 100n,
  logConcurrency: 2,
};

// ERC-20 quote created at block 100, long before the Perk deployment at 5000. Window [5000, 6000).
const erc20Chain = (): FakeChain => ({
  head: 6100n,
  campaign: { quote: TOKEN, graduatedAtBlock: 6000n },
  tokenCreatedAt: 100n,
  logs: [
    transfer(zeroAddress, A, 1000n, 100n), // pre-deployment holder
    transfer(zeroAddress, RAW_DEPLOYMENT.poolManager, 5000n, 150n), // pool liquidity
    transfer(zeroAddress, DEAD_ADDRESS, 300n, 160n),
    transfer(zeroAddress, RAW_DEPLOYMENT.feeRouter, 70n, 170n),
    transfer(A, B, 500n, 5500n),
    transfer(zeroAddress, C, 999n, 6050n), // after the cutoff
  ],
});

describe("runSnapshot, ERC-20 quote", () => {
  test("replays from the token's creation, so holders from before the deployment count for the whole window", async () => {
    const { reader } = fakeReader(erc20Chain());
    const { dataset } = await runSnapshot(reader, OPTIONS);
    const byAccount = new Map(dataset.allocations.map((a) => [a.account, a]));
    expect(dataset.inputs.replayFromBlock).toBe("100");
    expect(byAccount.get(A)?.twab).toBe("750"); // 1000 for 500 blocks, 500 for 500 blocks
    expect(byAccount.get(B)?.twab).toBe("250");
    expect(byAccount.get(A)?.base).toBe("750000");
    expect(byAccount.get(B)?.base).toBe("250000");
    expect(dataset.inputs.eligibleTwab).toBe("1000");
    expect(dataset.inputs.headBlock).toBe("6100");
  });

  test("system and unclaimable holders get nothing and are published in dataset.excluded", async () => {
    const { reader } = fakeReader(erc20Chain());
    const { dataset, excludedHolders } = await runSnapshot(reader, OPTIONS);
    const accounts = dataset.allocations.map((a) => a.account);
    expect(accounts).toEqual([A, B]);
    const excluded = new Set(dataset.excluded);
    for (const a of [RAW_DEPLOYMENT.poolManager, RAW_DEPLOYMENT.feeRouter, DEAD_ADDRESS, zeroAddress, MEME, TOKEN]) {
      expect(excluded.has(getAddress(a))).toBe(true);
    }
    // people are not system contracts
    expect(excluded.has(RAW_DEPLOYMENT.deployer)).toBe(false);
    expect(excludedHolders.map((h) => h.account).sort()).toEqual(
      [RAW_DEPLOYMENT.poolManager, DEAD_ADDRESS, RAW_DEPLOYMENT.feeRouter].map((a) => getAddress(a)).sort(),
    );
    // and the result passes the verifier's checks
    expect(checkDataset(dataset, { excluded: requiredExclusions(dataset, DEPLOYMENT.systemAddresses) }).problems).toEqual([]);
  });

  test("operator exclusions are applied and published", async () => {
    const { reader } = fakeReader(erc20Chain());
    const { dataset } = await runSnapshot(reader, { ...OPTIONS, extraExcluded: [B] });
    expect(dataset.allocations.map((a) => a.account)).toEqual([A]);
    expect(dataset.excluded).toContain(B);
  });

  test("a configured replay start after the token existed is refused", async () => {
    const { reader } = fakeReader(erc20Chain());
    await expect(runSnapshot(reader, { ...OPTIONS, quoteFromBlock: 5000n })).rejects.toThrow(/incomplete/);
  });

  test("the per-asset configured start is used when it is complete", async () => {
    const { reader } = fakeReader(erc20Chain());
    const { dataset } = await runSnapshot(reader, { ...OPTIONS, configuredReplayStart: () => 90n });
    expect(dataset.inputs.replayFromBlock).toBe("90");
  });

  test("a replay that does not reproduce totalSupply() is refused", async () => {
    const { reader } = fakeReader({ ...erc20Chain(), supplyOverride: 1n });
    await expect(runSnapshot(reader, OPTIONS)).rejects.toThrow(/totalSupply/);
  });

  test("the endpoint must serve the requested chain", async () => {
    const { reader } = fakeReader({ ...erc20Chain(), chainId: 196 });
    await expect(runSnapshot(reader, OPTIONS)).rejects.toThrow(/serves chain 196/);
  });

  test("the cutoff must have the required confirmations", async () => {
    const { reader } = fakeReader({ ...erc20Chain(), head: 6063n });
    await expect(runSnapshot(reader, OPTIONS)).rejects.toThrow(/not final/);
    const ok = fakeReader({ ...erc20Chain(), head: 6064n });
    await expect(runSnapshot(ok.reader, OPTIONS)).resolves.toBeDefined();
  });

  test("an ungraduated or unknown campaign is refused", async () => {
    const none = fakeReader({ ...erc20Chain(), campaign: { quote: TOKEN, graduatedAtBlock: 0n, status: CampaignStatus.NONE } });
    await expect(runSnapshot(none.reader, OPTIONS)).rejects.toThrow(/no grant campaign/);
  });
});

describe("runSnapshot, native quote", () => {
  const nativeChain = (): FakeChain => ({
    head: 6000n + 64n + 8n,
    campaign: { quote: zeroAddress, graduatedAtBlock: 6000n },
    logs: [optIn(A, 5100n), optIn(B, 5200n), optIn(RAW_DEPLOYMENT.treasury, 5300n), optIn(C, 6001n), bind(B, A, 5250n)],
    nativeBalance: (account) => (account === A ? 300n : account === B ? 100n : 10_000n),
  });

  test("samples at blocks drawn from the hashes of the blocks after the cutoff, and records the seed", async () => {
    const { reader, balanceReads } = fakeReader(nativeChain());
    const { dataset } = await runSnapshot(reader, OPTIONS);
    const expectedSeed = keccak256(concatHex(Array.from({ length: 8 }, (_, i) => blockHash(6001n + BigInt(i)))));
    expect(dataset.inputs.sampling).toEqual({
      method: "stratified-blockhash-v1",
      seed: expectedSeed,
      seedFromBlock: "6001",
      seedToBlock: "6008",
      strata: 20,
    });
    // anyone can recompute the sample blocks from the dataset
    const plan = samplePlan(6000n, 1000n, 50n, expectedSeed).map((s) => s.block);
    expect(balanceReads.filter((r) => r.account === A).map((r) => r.block)).toEqual(plan);
  });

  test("excluded contracts that opted in are not sampled; opt-ins after the cutoff do not count", async () => {
    const { reader, balanceReads } = fakeReader(nativeChain());
    const { dataset } = await runSnapshot(reader, OPTIONS);
    expect(dataset.allocations.map((a) => a.account)).toEqual([A, B]);
    expect(balanceReads.some((r) => r.account === RAW_DEPLOYMENT.treasury)).toBe(false);
    expect(dataset.inputs.eligibleAccounts).toBe(2);
    // B was invited by A
    const b = dataset.allocations.find((a) => a.account === B)!;
    expect(BigInt(b.boost)).toBe(BigInt(b.base) / 10n);
  });

  test("the seed blocks must be confirmed too", async () => {
    const { reader } = fakeReader({ ...nativeChain(), head: 6000n + 64n + 7n });
    await expect(runSnapshot(reader, OPTIONS)).rejects.toThrow(/seed blocks/);
  });
});
