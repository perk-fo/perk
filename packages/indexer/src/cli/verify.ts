/**
 * Verify CLI: the independent check a third party runs during the root delay window.
 *
 *   RPC_URL=https://… bun run src/cli/verify.ts <dataset.json> [--recompute] [--offline]
 *
 * From the file alone: rebuilds the StandardMerkleTree from the allocations, rejects duplicate (case-insensitive)
 * and excluded accounts (the dataset's own list plus the deployment's contracts, the meme, the quote, zero and
 * 0xdead), recomputes the sums and holds them against the budgets and the declared totals, and checks each leaf
 * against the allocation rules.
 *
 * Against the chain (skipped with --offline): the endpoint serves the dataset's chain, and the campaign's quote,
 * cutoff, budgets, root and the totals declared on chain match the dataset and its leaves.
 *
 * With --recompute: re-runs the snapshot from the inputs the dataset records and compares the result, leaf by leaf.
 *
 * Prints MATCH, or MISMATCH with every problem found, and exits non-zero on MISMATCH.
 */
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { loadDeployment, parseFlags, stringFlag, type Deployment } from "../config";
import { parseDataset } from "../dataset";
import { runSnapshot, DEFAULT_CONFIRMATIONS } from "../snapshot";
import { DEFAULT_SAMPLE_STEP } from "../twabNative";
import { checkAgainstCampaign, checkDataset, compareRecomputed, requiredExclusions, statusName } from "../verify";
import type { CampaignView } from "../chain";
import { connect, fail, NO_RPC_MESSAGE, type Connection } from "./common";

async function main(): Promise<void> {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const path = positional[0] ?? stringFlag(flags, "dataset");
  if (!path) {
    console.error("usage: bun run src/cli/verify.ts <dataset.json> [--recompute] [--offline]");
    process.exit(2);
  }
  const offline = flags.offline === true;
  const recompute = flags.recompute === true;
  if (offline && recompute) throw new Error("--recompute needs the chain; drop --offline");

  const dataset = parseDataset(readFileSync(path, "utf8"));
  const chainId = Number(dataset.chainId);
  let deployment: Deployment | undefined;
  try {
    deployment = loadDeployment(chainId);
  } catch {
    console.error(`note: no deployment record for chain ${chainId}; checking exclusions against the dataset's own list only`);
  }

  let online: { conn: Connection; servedChain: number; head: bigint; campaign: CampaignView } | undefined;
  if (!offline) {
    if (!deployment) throw new Error(`cannot check chain ${chainId} on chain without its deployment record; use --offline`);
    const conn = connect(chainId, flags);
    if (!conn) throw new Error(`${NO_RPC_MESSAGE} Or pass --offline to check the file alone.`);
    const servedChain = await conn.reader.getChainId();
    const head = await conn.reader.getBlockNumber();
    const campaign = await conn.reader.readCampaign(deployment.addresses.lpGrantVault, getAddress(dataset.meme), head);
    online = { conn, servedChain, head, campaign };
  }

  // the verifier's own exclusion list: the deployment's contracts and the campaign's hook, whatever the file says
  const excluded = requiredExclusions(dataset, deployment?.systemAddresses ?? [], online?.campaign.hooks);
  const report = checkDataset(dataset, { excluded });
  const problems = [...report.problems];

  console.log(`dataset root:    ${dataset.root}`);
  console.log(`recomputed root: ${report.root ?? "(not rebuilt)"}`);
  console.log(`accounts:        ${dataset.allocations.length}`);
  console.log(`leaf sums:       base=${report.sums.base} boost=${report.sums.boost}`);
  console.log(`budgets:         basePool=${dataset.inputs?.basePool} referralBudget=${dataset.inputs?.referralBudget}`);

  if (!online) {
    console.log("on-chain:        skipped (--offline)");
  } else {
    const { conn, servedChain, head, campaign } = online;
    console.log(
      `on-chain:        ${conn.endpoint} chain ${servedChain} block ${head}: ${statusName(campaign.status)} ` +
        `root=${campaign.root} totalBase=${campaign.rootTotalBase} totalBoost=${campaign.rootTotalInviteeBoost}`,
    );
    problems.push(...checkAgainstCampaign(dataset, report.sums, { chainId: servedChain, campaign }, { expectRoot: true }));

    if (recompute && deployment) {
      const inputs = dataset.inputs;
      const seedBlocks =
        inputs.sampling !== undefined ? BigInt(inputs.sampling.seedToBlock) - BigInt(dataset.cutoffBlock) : undefined;
      if (BigInt(dataset.quote) === 0n && seedBlocks === undefined) {
        problems.push("the dataset records no sampling seed (made before toolVersion 0.2.0), so it cannot be recomputed");
      } else {
        console.log("recomputing from the recorded inputs…");
        const { dataset: again } = await runSnapshot(conn.reader, {
          chainId,
          meme: getAddress(dataset.meme),
          deployment,
          minAllocation: BigInt(inputs.minAllocation),
          fromBlock: BigInt(inputs.fromBlock),
          windowBlocks: BigInt(dataset.windowBlocks),
          step: dataset.step !== undefined ? BigInt(dataset.step) : DEFAULT_SAMPLE_STEP,
          confirmations: DEFAULT_CONFIRMATIONS,
          seedBlocks: seedBlocks ?? 1n,
          quoteFromBlock: inputs.replayFromBlock !== undefined ? BigInt(inputs.replayFromBlock) : undefined,
          extraExcluded: (dataset.excluded ?? []).map((a) => getAddress(a)),
          concurrency: conn.settings.concurrency,
          logPage: conn.settings.logPage,
          logConcurrency: conn.settings.logConcurrency,
          log: (m) => console.error(`  ${m}`),
        });
        const diffs = compareRecomputed(dataset, again);
        console.log(`recomputed:      ${again.root}${diffs.length === 0 ? " (same)" : ""}`);
        problems.push(...diffs);
      }
    }
  }

  if (problems.length > 0) {
    console.log("problems:");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("MISMATCH");
    process.exit(1);
  }
  console.log("MATCH");
}

main().catch((err) => fail(err));
