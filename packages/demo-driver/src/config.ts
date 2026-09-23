/**
 * Driver configuration: chain, deployed addresses, and the wallets that play creator, traders and grant
 * participants. Everything comes from the environment (scripts/stack.sh loads .env.dev); nothing is logged.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** How many trader wallets take the other side of the curve. */
export const TRADER_COUNT = 4;
/** Wallets that register a grant allocation and provide subsidised liquidity. */
export const PARTICIPANT_COUNT = 3;
/**
 * Mnemonic index of the grant publisher: the key the vault accepts for proposing and cancelling grant roots and
 * nothing else (appointed at deploy through GRANT_PUBLISHER). Kept well clear of the creator, trader and
 * participant indexes.
 */
export const PUBLISHER_INDEX = 40;

export interface Deployment {
  chainId: number;
  blockNumber: number;
  factory: Address;
  curve: Address;
  graduationManager: Address;
  lpGrantVault: Address;
  templateRegistry: Address;
  referralRegistry: Address;
  poolManager: Address;
  positionManager: Address;
  quoteAssets?: Record<string, Address>;
}

export function loadDeployment(chainId: number): Deployment {
  const path = join(repoRoot, "contracts", "deployments", `${chainId}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

export const xlayerTestnet = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function buildConfig() {
  const chainId = Number(process.env.CHAIN_ID ?? 1952);
  if (chainId === 196) throw new Error("the demo driver is testnet-only; refusing to run against mainnet");
  const deployment = loadDeployment(chainId);
  const rpcUrl = requireEnv("RPC_URL");
  const chain = { ...xlayerTestnet, id: chainId };

  const transport = http(rpcUrl, { batch: true });
  const publicClient = createPublicClient({ chain, transport });

  // The deployer funds everyone else. Grant roots are published by the separate publisher key below.
  const deployer = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
  const mnemonic = requireEnv("TEST_MNEMONIC");
  // index 0 is the creator, then traders, then grant participants
  const creator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const traders = Array.from({ length: TRADER_COUNT }, (_, i) =>
    mnemonicToAccount(mnemonic, { addressIndex: 1 + i }),
  );
  const participants = Array.from({ length: PARTICIPANT_COUNT }, (_, i) =>
    mnemonicToAccount(mnemonic, { addressIndex: 1 + TRADER_COUNT + i }),
  );
  const publisher = mnemonicToAccount(mnemonic, { addressIndex: PUBLISHER_INDEX });

  const wallet = (account: Parameters<typeof createWalletClient>[0]["account"]) =>
    createWalletClient({ account, chain, transport });

  return {
    chainId,
    chain,
    rpcUrl,
    deployment,
    publicClient,
    deployer,
    creator,
    traders,
    participants,
    publisher,
    wallet,
    /** keccak256 of the template name, matching TEST_TEMPLATE in .env.dev */
    templateName: process.env.TEST_TEMPLATE ?? "TEST_FAST_V1",
    stateFile: process.env.DRIVER_STATE ?? join(repoRoot, ".run", "driver-state.json"),
    datasetDir: process.env.DRIVER_DATASETS ?? join(repoRoot, ".run", "datasets"),
  };
}

export type DriverConfig = ReturnType<typeof buildConfig>;
