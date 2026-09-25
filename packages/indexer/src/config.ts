import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { XLAYER_MAINNET, XLAYER_TESTNET } from "./rpc";

export { XLAYER_MAINNET, XLAYER_TESTNET };

export interface DeploymentAddresses {
  referralRegistry: `0x${string}`;
  lpGrantVault: `0x${string}`;
  factory: `0x${string}`;
  templateRegistry: `0x${string}`;
}

export interface Deployment {
  chainId: number;
  /** Repo-root relative deployments file that was loaded. */
  deploymentsPath: string;
  /** Block the stack was deployed at; default lower bound for registry and vault log scans. */
  deploymentBlock: bigint;
  addresses: DeploymentAddresses;
  /**
   * Every contract address the deployment file records (Perk contracts, the v4 PoolManager and PositionManager,
   * Permit2, routers, the quote tokens themselves). None of them can take part in a grant.
   */
  systemAddresses: Address[];
}

/**
 * Deployment-file keys that name people rather than contracts. They are not excluded from grants by default; a
 * deployment that wants them out passes them with --exclude.
 */
const ROLE_KEYS = new Set(["deployer", "protocolOwner", "protocolFeeRecipient"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

export function defaultRepoRoot(): string {
  return resolve(import.meta.dir, "../../..");
}

/** Every address-valued entry of a deployments file (one level of nesting, e.g. `quoteAssets`), minus role keys. */
export function deploymentSystemAddresses(raw: Record<string, unknown>): Address[] {
  const out = new Set<Address>();
  const visit = (key: string, value: unknown, depth: number): void => {
    if (typeof value === "string") {
      if (!ROLE_KEYS.has(key) && ADDRESS_RE.test(value) && value.toLowerCase() !== ZERO) out.add(getAddress(value));
    } else if (value && typeof value === "object" && !Array.isArray(value) && depth === 0) {
      for (const [k, v] of Object.entries(value)) visit(k, v, depth + 1);
    }
  };
  for (const [k, v] of Object.entries(raw)) visit(k, v, 0);
  return [...out].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Load a chain's deployment record. Needs no RPC and never hardcodes addresses. */
export function loadDeployment(chainId: number, opts: { repoRoot?: string } = {}): Deployment {
  if (chainId !== XLAYER_MAINNET && chainId !== XLAYER_TESTNET) {
    throw new Error(`unsupported chain id ${chainId} (expected ${XLAYER_MAINNET} or ${XLAYER_TESTNET})`);
  }
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const deploymentsPath = resolve(repoRoot, `contracts/deployments/${chainId}.json`);
  const raw = JSON.parse(readFileSync(deploymentsPath, "utf8")) as Record<string, unknown>;
  const addresses: DeploymentAddresses = {
    referralRegistry: requireAddress(raw, "referralRegistry"),
    lpGrantVault: requireAddress(raw, "lpGrantVault"),
    factory: requireAddress(raw, "factory"),
    templateRegistry: requireAddress(raw, "templateRegistry"),
  };
  const deploymentBlock = BigInt(
    typeof raw.blockNumber === "number" || typeof raw.blockNumber === "string" ? raw.blockNumber : 0,
  );
  return { chainId, deploymentsPath, deploymentBlock, addresses, systemAddresses: deploymentSystemAddresses(raw) };
}

function requireAddress(raw: Record<string, unknown>, key: string): `0x${string}` {
  const v = raw[key];
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) {
    throw new Error(`deployments file is missing a valid "${key}" address`);
  }
  return v as `0x${string}`;
}

/** Per-asset settings from quote-assets.json: `{ "<chainId>": { "<token>": { "createdAtBlock": n } } }`. */
export interface QuoteAssetSettings {
  symbol?: string;
  /** Block the token contract was created in: the ERC-20 replay starts here. The snapshot checks it on chain. */
  createdAtBlock?: number;
}

export function loadQuoteAssetSettings(
  chainId: number,
  quote: Address,
  opts: { path?: string } = {},
): QuoteAssetSettings | undefined {
  const path = opts.path ?? resolve(import.meta.dir, "../quote-assets.json");
  if (!existsSync(path)) return undefined;
  const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, QuoteAssetSettings>>;
  const perChain = all[String(chainId)] ?? {};
  for (const [token, settings] of Object.entries(perChain)) {
    if (token.toLowerCase() === quote.toLowerCase()) return settings;
  }
  return undefined;
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

/** A string flag's value, or undefined. */
export function stringFlag(flags: Record<string, string | true>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags[n];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** A non-negative integer flag (falling back to an environment variable, then the default). */
export function bigintSetting(
  flags: Record<string, string | true>,
  names: string[],
  envValue: string | undefined,
  fallback: bigint | undefined,
  label: string,
): bigint | undefined {
  const raw = stringFlag(flags, ...names) ?? (envValue !== undefined && envValue.trim() !== "" ? envValue : undefined);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a non-negative integer (got "${raw}")`);
  return BigInt(raw.trim());
}
