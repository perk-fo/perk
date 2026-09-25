/**
 * The snapshot pipeline behind `src/cli/snapshot.ts` and `verify --recompute`: reads the campaign, checks the chain
 * and finality, collects the holder set, computes TWAB, removes excluded accounts, derives allocations and builds
 * the Merkle tree and the public dataset. Reads only; never sends a transaction.
 */
import { getAddress, type Address } from "viem";
import { CampaignStatus } from "./abi";
import { computeAllocations } from "./allocations";
import type { ChainReader } from "./chain";
import type { Deployment } from "./config";
import { buildDataset, type SamplingRecord, type SnapshotDataset } from "./dataset";
import { applyExclusions, buildExclusions } from "./exclusions";
import { buildTree, type GrantTree, type LeafTuple } from "./merkle";
import { collectOptIns, OPTED_IN_TOPIC, type LogFetcher, type PagingOptions } from "./optin";
import { collectReferrals, INVITER_BOUND_TOPIC } from "./referrals";
import { replayErc20, resolveReplayStart, TRANSFER_TOPIC } from "./twabErc20";
import { deriveSamplingSeed, estimateWindowBlocks, SAMPLING_METHOD, samplePlan, twabNative } from "./twabNative";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Confirmations the cutoff block (and, for native quotes, the last seed block) must have before a snapshot. */
export const DEFAULT_CONFIRMATIONS = 64n;
/** Largest replayed holders whose balanceOf at the cutoff is compared with the replay. */
export const BALANCE_SPOT_CHECKS = 5;

export interface SnapshotOptions {
  /** The chain the dataset is for; the endpoint must serve exactly this chain. */
  chainId: number;
  meme: Address;
  deployment: Deployment;
  minAllocation: bigint;
  /** First block of the registry scans (opt-ins, referral bindings); defaults to the deployment block. */
  fromBlock?: bigint;
  /** Window length override; by default estimated from the block time before the cutoff. */
  windowBlocks?: bigint;
  /** Native quotes: stratum length in blocks. */
  step: bigint;
  confirmations: bigint;
  /** Native quotes: blocks after the cutoff hashed into the sampling seed. */
  seedBlocks: bigint;
  /** ERC-20 quotes: where the Transfer replay starts; discovered from the token's creation when absent. */
  quoteFromBlock?: bigint;
  /** Per-asset replay start from configuration, consulted when `quoteFromBlock` is absent. */
  configuredReplayStart?: (quote: Address) => bigint | undefined;
  extraExcluded?: readonly Address[];
  /** Balance reads in flight at once. */
  concurrency: number;
  logPage: bigint;
  logConcurrency: number;
  log?: (message: string) => void;
}

export interface SnapshotResult {
  dataset: SnapshotDataset;
  tree: GrantTree;
  /** Excluded accounts that held the quote, with the TWAB they would otherwise have been allocated on. */
  excludedHolders: { account: Address; twab: bigint }[];
  dropped: Address[];
}

export async function runSnapshot(reader: ChainReader, o: SnapshotOptions): Promise<SnapshotResult> {
  const log = o.log ?? (() => {});
  const meme = getAddress(o.meme);
  const { addresses } = o.deployment;

  // The endpoint must serve the chain the dataset claims, and the cutoff must be final before anything is read.
  const servedChain = await reader.getChainId();
  if (servedChain !== o.chainId) {
    throw new Error(`the RPC endpoint serves chain ${servedChain}, not chain ${o.chainId}`);
  }
  const head = await reader.getBlockNumber();
  const campaign = await reader.readCampaign(addresses.lpGrantVault, meme, head);
  if (campaign.status === CampaignStatus.NONE) throw new Error(`no grant campaign for meme ${meme}`);
  if (campaign.graduatedAtBlock === 0n) throw new Error(`meme ${meme} has not graduated yet`);
  const cutoff = campaign.graduatedAtBlock;
  const quote = getAddress(campaign.quote);
  const native = quote === ZERO;
  const needed = cutoff + o.confirmations + (native ? o.seedBlocks : 0n);
  if (head < needed) {
    throw new Error(
      `the cutoff is not final yet: head ${head}, need ${needed} (cutoff ${cutoff} + ${o.confirmations} confirmations` +
        `${native ? ` + ${o.seedBlocks} seed blocks` : ""}); try again in about ${needed - head} blocks`,
    );
  }
  log(
    `campaign: status=${campaign.status} quote=${quote} cutoff=${cutoff} head=${head} basePool=${campaign.basePool} referralBudget=${campaign.referralBudget}`,
  );

  let windowBlocks: bigint;
  let avgBlockTimeMs: bigint | undefined;
  if (o.windowBlocks !== undefined) {
    windowBlocks = o.windowBlocks;
  } else {
    const estimate = await estimateWindowBlocks((b) => reader.getBlockTimestamp(b), cutoff);
    windowBlocks = estimate.windowBlocks;
    avgBlockTimeMs = estimate.avgBlockTimeMs;
    log(`avg block time ≈ ${avgBlockTimeMs}ms → window = ${windowBlocks} blocks`);
  }
  if (windowBlocks <= 0n) throw new Error("the window must be at least one block");

  const paging: PagingOptions = { concurrency: o.logConcurrency };
  const logFetcher =
    (address: Address, topic0: `0x${string}`): LogFetcher =>
    (from, to) =>
      reader.getLogs(address, topic0, from, to);

  // Registry logs cannot predate the deployment; scanning from genesis would take tens of thousands of requests.
  const fromBlock = o.fromBlock ?? o.deployment.deploymentBlock;
  const referrals = await collectReferrals(
    logFetcher(addresses.referralRegistry, INVITER_BOUND_TOPIC),
    cutoff,
    fromBlock,
    o.logPage,
    paging,
  );
  log(`referral bindings before cutoff: ${referrals.size}`);

  const excluded = buildExclusions({
    system: o.deployment.systemAddresses,
    meme,
    quote,
    hook: campaign.hooks,
    extra: o.extraExcluded,
  });
  const excludedSet = new Set(excluded.map((a) => a.toLowerCase()));

  let twabByAccount: Map<Address, bigint>;
  let replayFromBlock: bigint | undefined;
  let sampling: SamplingRecord | undefined;

  if (native) {
    // Native OKB quote: registration-based holder set + sampled TWAB (DESIGN.md / ADR-008).
    const optedIn = await collectOptIns(
      logFetcher(addresses.referralRegistry, OPTED_IN_TOPIC),
      cutoff,
      fromBlock,
      o.logPage,
      paging,
    );
    const eligible = optedIn.filter((a) => !excludedSet.has(a.toLowerCase()));
    const seed = await deriveSamplingSeed((b) => reader.getBlockHash(b), cutoff, o.seedBlocks);
    const plan = samplePlan(cutoff, windowBlocks, o.step, seed.seed);
    sampling = {
      method: SAMPLING_METHOD,
      seed: seed.seed,
      seedFromBlock: seed.fromBlock.toString(),
      seedToBlock: seed.toBlock.toString(),
      strata: plan.length,
    };
    log(
      `opted-in accounts: ${optedIn.length} (${optedIn.length - eligible.length} excluded); ` +
        `sampling ${plan.length} strata of ${o.step} blocks, seed ${seed.seed} from blocks ${seed.fromBlock}..${seed.toBlock}`,
    );
    let lastPct = -1;
    twabByAccount = await twabNative((a, b) => reader.getBalance(a, b), eligible, plan, o.concurrency, (done, total) => {
      const pct = Math.floor((done * 100) / total);
      if (pct % 10 === 0 && pct !== lastPct) {
        lastPct = pct;
        log(`  balance samples: ${done}/${total}`);
      }
    });
  } else {
    // ERC-20 quote: exact TWAB from a Transfer replay that starts no later than the token's creation.
    const configured = o.quoteFromBlock ?? o.configuredReplayStart?.(quote);
    const start = await resolveReplayStart((b) => reader.getCode(quote, b), cutoff, configured);
    replayFromBlock = start.fromBlock;
    log(`replaying Transfer logs for quote ${quote} from block ${start.fromBlock} (${start.source}) to ${cutoff}…`);
    let lastTenth = -1n;
    const replay = await replayErc20(logFetcher(quote, TRANSFER_TOPIC), cutoff, windowBlocks, start.fromBlock, o.logPage, new Map(), {
      ...paging,
      onProgress: (done, total) => {
        const tenth = (done * 10n) / total;
        if (tenth !== lastTenth) {
          lastTenth = tenth;
          log(`  blocks replayed: ${done}/${total}`);
        }
      },
    });
    log(`transfers replayed: ${replay.transfers}; holders at cutoff: ${replay.balancesAtCutoff.size}`);

    // A complete replay reproduces the token's own books: its supply and its largest balances at the cutoff.
    const supply = await reader.readTotalSupply(quote, cutoff);
    if (replay.replayedSupply !== supply) {
      throw new Error(
        `the Transfer replay does not reproduce the quote token: replayed balances sum to ${replay.replayedSupply} at block ` +
          `${cutoff} but totalSupply() is ${supply}. The token may mint or rebase without Transfer events; refusing to ` +
          "build allocations from an incomplete replay",
      );
    }
    const largest = [...replay.balancesAtCutoff.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, BALANCE_SPOT_CHECKS);
    for (const [account, replayed] of largest) {
      const actual = await reader.readBalanceOf(quote, account, cutoff);
      if (actual !== replayed) {
        throw new Error(
          `the Transfer replay gives ${account} a balance of ${replayed} at block ${cutoff}, but balanceOf() is ${actual}`,
        );
      }
    }
    log(`replay checked against totalSupply() and the ${largest.length} largest balances at the cutoff`);
    twabByAccount = replay.twab;
  }

  const { kept, removed } = applyExclusions(twabByAccount, excluded);
  for (const r of removed) if (r.twab > 0n) log(`  excluded holder ${r.account} (twab ${r.twab})`);
  const inputs = [...kept.entries()].map(([account, twab]) => ({ account, twab }));
  let eligibleTwab = 0n;
  for (const i of inputs) eligibleTwab += i.twab;
  const eligibleAccounts = inputs.length;

  const result = computeAllocations(inputs, campaign.basePool, campaign.referralBudget, o.minAllocation, referrals);
  log(
    `allocations: ${result.allocations.length} accounts, totalBase=${result.totalBase}, totalBoost=${result.totalBoost}` +
      `${result.boostScaled ? " (boost scaled to budget)" : ""}, dropped=${result.dropped.length}, excluded holders=${removed.length}`,
  );
  if (result.allocations.length === 0) throw new Error("no eligible allocations — refusing to write an empty dataset");

  const leaves: LeafTuple[] = result.allocations.map((a) => [a.account, a.base, a.boost]);
  const tree = buildTree(leaves);
  log(`merkle root: ${tree.root}`);

  const dataset = buildDataset({
    chainId: o.chainId,
    meme,
    quote,
    cutoffBlock: cutoff,
    windowBlocks,
    step: o.step,
    basePool: campaign.basePool,
    referralBudget: campaign.referralBudget,
    minAllocation: o.minAllocation,
    boostScaled: result.boostScaled,
    eligibleAccounts,
    fromBlock,
    avgBlockTimeMs,
    excluded,
    replayFromBlock,
    eligibleTwab,
    headBlock: head,
    sampling,
    allocations: result.allocations,
    root: tree.root,
  });
  return { dataset, tree, excludedHolders: removed, dropped: result.dropped };
}
