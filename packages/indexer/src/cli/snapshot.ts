/**
 * Snapshot CLI: builds the grant dataset + Merkle tree for a graduated meme.
 *
 *   RPC_URL=https://… bun run src/cli/snapshot.ts --meme 0x… [--chain 1952] [--out dataset.json]
 *       [--min-allocation 0] [--from-block N] [--window N] [--step 300] [--quote-from-block N]
 *       [--confirmations 64] [--seed-blocks 32] [--exclude 0x…,0x…]
 *
 * Reads the campaign from LPGrantVault (cutoff = graduatedAtBlock), collects the holder set (opt-in registry for
 * native OKB quotes, Transfer replay for ERC-20 quotes), computes TWAB, drops excluded accounts, derives
 * allocations, builds the StandardMerkleTree and writes the public dataset plus the tree dump. Never sends a
 * transaction.
 *
 * Refuses to run when the endpoint serves another chain, when the cutoff has fewer than --confirmations
 * confirmations (for native quotes, counted after the --seed-blocks blocks whose hashes seed the sampling), or when
 * an ERC-20 replay would start after the quote token already existed.
 *
 * Flags:
 *   --from-block N        first block of the registry scans (default: the deployment block)
 *   --quote-from-block N  first block of the ERC-20 Transfer replay (default: quote-assets.json, else the token's
 *                         creation block found by eth_getCode binary search); checked on chain either way
 *   --confirmations N     SNAPSHOT_CONFIRMATIONS, default 64
 *   --seed-blocks N       SNAPSHOT_SEED_BLOCKS, default 32 (native quotes)
 *   --exclude a,b         SNAPSHOT_EXCLUDE: extra accounts to exclude, on top of the deployment's contracts
 *   --rpc-url URL         insecure: visible in the process list and shell history; use RPC_URL
 *
 * Environment: RPC_URL (else ALCHEMY_API_KEY), LOG_PAGE (blocks per eth_getLogs, default 1000; 100 on the public
 * X Layer endpoints), LOG_CONCURRENCY (4), RPC_BATCH_SIZE (10; 1 disables batching), RPC_CONCURRENCY (10),
 * RPC_RETRIES (6), RPC_RETRY_DELAY_MS (500), RPC_TIMEOUT_MS (30000).
 */
import { writeFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { bigintSetting, loadDeployment, loadQuoteAssetSettings, parseFlags, requireFlag, stringFlag, XLAYER_TESTNET } from "../config";
import { parseAddressList } from "../exclusions";
import { DEFAULT_CONFIRMATIONS, runSnapshot } from "../snapshot";
import { DEFAULT_SAMPLE_STEP, DEFAULT_SEED_BLOCKS } from "../twabNative";
import { connect, fail, NO_RPC_MESSAGE } from "./common";

async function main(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const meme = getAddress(requireFlag(flags, "meme")) as Address;
  const chainId = Number(stringFlag(flags, "chain") ?? XLAYER_TESTNET);
  const out = stringFlag(flags, "out") ?? `dataset-${chainId}-${meme.toLowerCase()}.json`;
  const env = process.env;

  const deployment = loadDeployment(chainId);
  const conn = connect(chainId, flags);
  if (!conn) throw new Error(NO_RPC_MESSAGE);
  console.error(`rpc: ${conn.endpoint}; batch ${conn.settings.batchSize}, concurrency ${conn.settings.concurrency}, log page ${conn.settings.logPage}`);

  const { dataset, tree } = await runSnapshot(conn.reader, {
    chainId,
    meme,
    deployment,
    minAllocation: bigintSetting(flags, ["min-allocation"], undefined, 0n, "--min-allocation")!,
    fromBlock: bigintSetting(flags, ["from-block", "fromBlock"], undefined, undefined, "--from-block"),
    windowBlocks: bigintSetting(flags, ["window"], undefined, undefined, "--window"),
    step: bigintSetting(flags, ["step"], undefined, DEFAULT_SAMPLE_STEP, "--step")!,
    confirmations: bigintSetting(flags, ["confirmations"], env.SNAPSHOT_CONFIRMATIONS, DEFAULT_CONFIRMATIONS, "--confirmations")!,
    seedBlocks: bigintSetting(flags, ["seed-blocks"], env.SNAPSHOT_SEED_BLOCKS, DEFAULT_SEED_BLOCKS, "--seed-blocks")!,
    quoteFromBlock: bigintSetting(flags, ["quote-from-block"], undefined, undefined, "--quote-from-block"),
    configuredReplayStart: (quote) => {
      const created = loadQuoteAssetSettings(chainId, quote)?.createdAtBlock;
      return created === undefined ? undefined : BigInt(created);
    },
    extraExcluded: [...parseAddressList(env.SNAPSHOT_EXCLUDE), ...parseAddressList(stringFlag(flags, "exclude"))],
    concurrency: conn.settings.concurrency,
    logPage: conn.settings.logPage,
    logConcurrency: conn.settings.logConcurrency,
    log: (m) => console.error(m),
  });

  writeFileSync(out, JSON.stringify(dataset, null, 2) + "\n");
  writeFileSync(`${out}.tree.json`, tree.dumpJson());
  console.error(`wrote ${out} and ${out}.tree.json`);
}

main().catch((err) => fail(err));
