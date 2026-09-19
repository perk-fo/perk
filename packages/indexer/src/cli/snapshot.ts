/**
 * Snapshot CLI: builds the grant dataset + Merkle tree for a graduated meme.
 *
 *   bun run src/cli/snapshot.ts --meme 0x… [--chain 1952] [--out dataset.json]
 *                               [--min-allocation 0] [--fromBlock 0] [--window N] [--step 300]
 *                               [--rpc-url https://…]
 *
 * Reads the campaign from LPGrantVault (cutoff = graduatedAtBlock), collects the holder set
 * (opt-in registry for native OKB quotes, Transfer replay for ERC-20 quotes), computes TWAB,
 * derives allocations, builds the StandardMerkleTree and writes the public dataset plus the
 * tree dump. Never sends a transaction.
 */
import { writeFileSync } from "node:fs";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { CAMPAIGN_ABI, CampaignStatus } from "../abi";
import { computeAllocations } from "../allocations";
import { loadConfig, parseFlags, requireFlag, XLAYER_MAINNET, XLAYER_TESTNET } from "../config";
import { buildDataset } from "../dataset";
import { buildTree, type LeafTuple } from "../merkle";
import { collectOptIns, OPTED_IN_TOPIC, type LogFetcher, type RawLog } from "../optin";
import { collectReferrals, INVITER_BOUND_TOPIC } from "../referrals";
import { TRANSFER_TOPIC, twabErc20 } from "../twabErc20";
import { DEFAULT_SAMPLE_STEP, estimateWindowBlocks, twabNative } from "../twabNative";

const ZERO = "0x0000000000000000000000000000000000000000";

const xlayerMainnet = defineChain({
  id: XLAYER_MAINNET,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
const xlayerTestnet = defineChain({
  id: XLAYER_TESTNET,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

async function main(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const meme = getAddress(requireFlag(flags, "meme")) as Address;
  const chainId = Number(flags.chain ?? XLAYER_TESTNET);
  const out = typeof flags.out === "string" ? flags.out : `dataset-${chainId}-${meme.toLowerCase()}.json`;
  const minAllocation = BigInt(typeof flags["min-allocation"] === "string" ? flags["min-allocation"] : "0");
  const fromBlockArg = typeof flags["from-block"] === "string" ? BigInt(flags["from-block"]) : undefined;
  const fromBlockFlag =
    fromBlockArg ?? (typeof flags.fromBlock === "string" ? BigInt(flags.fromBlock) : undefined);
  const windowOverride = typeof flags.window === "string" ? BigInt(flags.window) : undefined;
  const step = typeof flags.step === "string" ? BigInt(flags.step) : DEFAULT_SAMPLE_STEP;

  const config = loadConfig(chainId, { rpcUrl: typeof flags["rpc-url"] === "string" ? flags["rpc-url"] : undefined });

  // JSON-RPC batching for the balance sampler; multicall cannot batch native balances.
  const client = createPublicClient({
    chain: chainId === XLAYER_MAINNET ? xlayerMainnet : xlayerTestnet,
    transport: http(config.rpcUrl, { batch: true }),
    batch: { multicall: false },
  });

  const campaign = await client.readContract({
    address: config.addresses.lpGrantVault,
    abi: CAMPAIGN_ABI,
    functionName: "campaign",
    args: [meme],
  });
  if (campaign.status === CampaignStatus.NONE) throw new Error(`no grant campaign for meme ${meme}`);
  if (campaign.graduatedAtBlock === 0n) throw new Error(`meme ${meme} has not graduated yet`);
  const cutoff = campaign.graduatedAtBlock;
  const quote = getAddress(campaign.quote) as Address;
  console.error(
    `campaign: status=${campaign.status} quote=${quote} cutoff=${cutoff} basePool=${campaign.basePool} referralBudget=${campaign.referralBudget}`,
  );

  let windowBlocks: bigint;
  let avgBlockTimeMs: bigint | undefined;
  if (windowOverride !== undefined) {
    windowBlocks = windowOverride;
  } else {
    const estimate = await estimateWindowBlocks(async (b) => (await client.getBlock({ blockNumber: b })).timestamp, cutoff);
    windowBlocks = estimate.windowBlocks;
    avgBlockTimeMs = estimate.avgBlockTimeMs;
    console.error(`avg block time ≈ ${avgBlockTimeMs}ms → window = ${windowBlocks} blocks`);
  }

  const logFetcher = (address: Address, topic0: `0x${string}`): LogFetcher =>
    async (from, to) => {
      const logs = await client.getLogs({ address, fromBlock: from, toBlock: to, topics: [topic0] });
      return logs.map(
        (l): RawLog => ({
          address: l.address,
          topics: [...l.topics],
          data: l.data,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        }),
      );
    };

  // Registry / vault logs cannot predate the deployment; scanning from genesis would take tens of thousands of requests.
  const fromBlock = fromBlockFlag ?? config.deploymentBlock;
  const referrals = await collectReferrals(
    logFetcher(config.addresses.referralRegistry, INVITER_BOUND_TOPIC),
    cutoff,
    fromBlock,
  );
  console.error(`referral bindings before cutoff: ${referrals.size}`);

  let twabByAccount: Map<Address, bigint>;
  let eligibleAccounts: number;

  if (quote === ZERO) {
    // Native OKB quote: registration-based holder set + sampled TWAB (DESIGN.md / ADR-008).
    const optedIn = await collectOptIns(logFetcher(config.addresses.referralRegistry, OPTED_IN_TOPIC), cutoff, fromBlock);
    eligibleAccounts = optedIn.length;
    console.error(`opted-in accounts: ${optedIn.length}; sampling ${step}-block steps…`);
    twabByAccount = await twabNative(
      (account, blockNumber) => client.getBalance({ address: account, blockNumber }),
      optedIn,
      cutoff,
      windowBlocks,
      step,
    );
  } else {
    // ERC-20 quote: exact TWAB from Transfer replay over all holders.
    console.error(`replaying Transfer logs for quote ${quote} from block ${fromBlock}…`);
    twabByAccount = await twabErc20(logFetcher(quote, TRANSFER_TOPIC), cutoff, windowBlocks, fromBlock);
    eligibleAccounts = twabByAccount.size;
    console.error(`holders with non-zero TWAB: ${twabByAccount.size}`);
  }

  const inputs = [...twabByAccount.entries()].map(([account, twab]) => ({ account, twab }));
  const result = computeAllocations(inputs, campaign.basePool, campaign.referralBudget, minAllocation, referrals);
  console.error(
    `allocations: ${result.allocations.length} accounts, totalBase=${result.totalBase}, totalBoost=${result.totalBoost}` +
      `${result.boostScaled ? " (boost scaled to budget)" : ""}, dropped=${result.dropped.length}`,
  );
  if (result.allocations.length === 0) throw new Error("no eligible allocations — refusing to write an empty dataset");

  const leaves: LeafTuple[] = result.allocations.map((a) => [a.account, a.base, a.boost]);
  const tree = buildTree(leaves);
  console.error(`merkle root: ${tree.root}`);

  const dataset = buildDataset({
    chainId,
    meme,
    quote,
    cutoffBlock: cutoff,
    windowBlocks,
    step,
    basePool: campaign.basePool,
    referralBudget: campaign.referralBudget,
    minAllocation,
    boostScaled: result.boostScaled,
    eligibleAccounts,
    fromBlock,
    avgBlockTimeMs,
    allocations: result.allocations,
    root: tree.root,
  });

  writeFileSync(out, JSON.stringify(dataset, null, 2) + "\n");
  writeFileSync(`${out}.tree.json`, tree.dumpJson());
  console.error(`wrote ${out} and ${out}.tree.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Re-exported for tests: viem client type used by the adapters above.
export type { PublicClient };
