import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** X Layer chain ids. */
export const XLAYER_MAINNET = 196;
export const XLAYER_TESTNET = 1952;

export interface DeploymentAddresses {
  referralRegistry: `0x${string}`;
  lpGrantVault: `0x${string}`;
  factory: `0x${string}`;
  templateRegistry: `0x${string}`;
}

export interface IndexerConfig {
  chainId: number;
  rpcUrl: string;
  /** Repo-root relative deployments file that was loaded. */
  deploymentsPath: string;
  /** Block the stack was deployed at; default lower bound for log scans. */
  deploymentBlock: bigint;
  addresses: DeploymentAddresses;
}

function rpcSlug(chainId: number): string {
  if (chainId === XLAYER_MAINNET) return "mainnet";
  if (chainId === XLAYER_TESTNET) return "testnet";
  throw new Error(`unsupported chain id ${chainId} (expected ${XLAYER_MAINNET} or ${XLAYER_TESTNET})`);
}

/** Load config for a chain. Reads ALCHEMY_API_KEY from the environment; never hardcodes addresses. */
export function loadConfig(chainId: number, opts: { rpcUrl?: string; repoRoot?: string } = {}): IndexerConfig {
  const repoRoot = opts.repoRoot ?? resolve(import.meta.dir, "../../..");
  const deploymentsPath = resolve(repoRoot, `contracts/deployments/${chainId}.json`);
  const raw = JSON.parse(readFileSync(deploymentsPath, "utf8")) as Record<string, unknown>;
  const addresses: DeploymentAddresses = {
    referralRegistry: requireAddress(raw, "referralRegistry"),
    lpGrantVault: requireAddress(raw, "lpGrantVault"),
    factory: requireAddress(raw, "factory"),
    templateRegistry: requireAddress(raw, "templateRegistry"),
  };

  let rpcUrl = opts.rpcUrl;
  if (!rpcUrl) {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) throw new Error("ALCHEMY_API_KEY is not set (or pass --rpc-url)");
    rpcUrl = `https://xlayer-${rpcSlug(chainId)}.g.alchemy.com/v2/${key}`;
  }
  const deploymentBlock = BigInt(typeof raw.blockNumber === "number" || typeof raw.blockNumber === "string" ? raw.blockNumber : 0);
  return { chainId, rpcUrl, deploymentsPath, deploymentBlock, addresses };
}

function requireAddress(raw: Record<string, unknown>, key: string): `0x${string}` {
  const v = raw[key];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`deployments file is missing a valid "${key}" address`);
  }
  return v as `0x${string}`;
}

/** Minimal CLI flag parser: supports --flag value, --flag=value and boolean --flag. */
export function parseFlags(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function requireFlag(flags: Record<string, string | true>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required --${name}`);
  return v;
}
