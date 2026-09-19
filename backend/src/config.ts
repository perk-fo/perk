import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import deploymentsJson from "./generated/deployments.json";

export const XLAYER_MAINNET = 196;
export const XLAYER_TESTNET = 1952;

/** Public (keyless) RPCs, used only as a fallback when RPC_URL is unset. Server-side only. */
export const PUBLIC_RPC: Record<number, string> = {
  [XLAYER_MAINNET]: "https://rpc.xlayer.tech",
  [XLAYER_TESTNET]: "https://testrpc.xlayer.tech",
};

/** Subset of contracts/deployments/<chainId>.json the indexer tracks. */
export interface Deployment {
  chainId: number;
  blockNumber: number;
  deployer: Address;
  protocolOwner: Address;
  factory: Address;
  curve: Address;
  hook: Address;
  graduationManager: Address;
  feeRouter: Address;
  distributor: Address;
  lpGrantVault: Address;
  referralRegistry: Address;
  templateRegistry: Address;
  assetRegistry?: Address;
  poolManager: Address;
  xdogToken?: Address;
  quoteAssets?: Record<string, Address>;
}

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  databaseUrl: string;
  confirmations: number;
  /** Live mode: one poll per pollMs (default 1500). */
  pollMs: number;
  /** Lag (blocks) above which the indexer is in catch-up mode: windows back to back, no sleep (default 200). */
  catchupBlocks: number;
  logPage: number;
  port: number;
  corsOrigins: string[];
  adminAddresses: Address[];
  deployment: Deployment;
  /** `local` writes to MEDIA_DIR; `pinata` pins via PINATA_JWT. */
  mediaDriver: "local" | "pinata";
  mediaDir: string;
  /** Origin used to mint local media URLs (no trailing slash). */
  publicApiUrl: string;
  pinataJwt: string | undefined;
  /** Gateway prefix for rewriting ipfs:// → https, including trailing slash. */
  ipfsGateway: string;
  /** Shared POST /v1/media/* token-bucket capacity per IP. */
  mediaRateLimit: number;
  mediaRateWindowMs: number;
  /** Honour X-Forwarded-For / X-Real-IP when rate limiting. Only enable behind a proxy that overwrites them. */
  trustProxy: boolean;
  /** Largest request body the server will read at all (media uploads are the only POSTs). */
  maxBodyBytes: number;
}

const deployments = deploymentsJson as unknown as Record<string, Deployment | null>;

export function getDeployment(chainId: number): Deployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId} (run bun run sync-abis after deploying)`);
  return d;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Load configuration from the environment (see .env.example). Never logs secrets.
 * `overrides` is for tests.
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const chainId = overrides.chainId ?? intEnv("CHAIN_ID", XLAYER_TESTNET);
  const deployment = overrides.deployment ?? getDeployment(chainId);
  const rpcUrl = overrides.rpcUrl ?? process.env.RPC_URL ?? PUBLIC_RPC[chainId];
  if (!rpcUrl) throw new Error("RPC_URL is not set");
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const admins = new Set<string>([deployment.protocolOwner, deployment.deployer].map((a) => a.toLowerCase()));
  for (const a of listEnv("ADMIN_ADDRESSES")) admins.add(a.toLowerCase());
  for (const a of overrides.adminAddresses ?? []) admins.add(a.toLowerCase());
  const port = overrides.port ?? intEnv("PORT", 8787);
  const mediaDriverRaw = (overrides.mediaDriver ?? process.env.MEDIA_DRIVER ?? "local").trim() || "local";
  if (mediaDriverRaw !== "local" && mediaDriverRaw !== "pinata") {
    throw new Error(`MEDIA_DRIVER must be local or pinata, got "${mediaDriverRaw}"`);
  }
  const pinataJwt = overrides.pinataJwt !== undefined ? overrides.pinataJwt : process.env.PINATA_JWT || undefined;
  if (mediaDriverRaw === "pinata" && !pinataJwt) {
    throw new Error("PINATA_JWT is required when MEDIA_DRIVER=pinata");
  }
  const ipfsGatewayRaw = overrides.ipfsGateway ?? process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";
  const publicApiUrlRaw = overrides.publicApiUrl ?? process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  return {
    chainId,
    rpcUrl,
    databaseUrl,
    confirmations: overrides.confirmations ?? intEnv("CONFIRMATIONS", 2),
    pollMs: overrides.pollMs ?? intEnv("POLL_MS", 1500),
    catchupBlocks: overrides.catchupBlocks ?? intEnv("CATCHUP_BLOCKS", 200),
    logPage: overrides.logPage ?? intEnv("LOG_PAGE", 1000),
    port,
    corsOrigins: overrides.corsOrigins ?? (listEnv("CORS_ORIGINS").length ? listEnv("CORS_ORIGINS") : ["http://localhost:3000"]),
    adminAddresses: [...admins] as Address[],
    deployment,
    mediaDriver: mediaDriverRaw,
    mediaDir: overrides.mediaDir ?? process.env.MEDIA_DIR ?? "./data/media",
    publicApiUrl: publicApiUrlRaw.replace(/\/+$/, ""),
    pinataJwt,
    ipfsGateway: ipfsGatewayRaw.endsWith("/") ? ipfsGatewayRaw : `${ipfsGatewayRaw}/`,
    mediaRateLimit: overrides.mediaRateLimit ?? intEnv("MEDIA_RATE_LIMIT", 20),
    mediaRateWindowMs: overrides.mediaRateWindowMs ?? intEnv("MEDIA_RATE_WINDOW_MS", 600_000),
    trustProxy: overrides.trustProxy ?? (process.env.TRUST_PROXY ?? "").toLowerCase() === "true",
    maxBodyBytes: overrides.maxBodyBytes ?? intEnv("MAX_BODY_BYTES", 3 * 1024 * 1024),
  };
}

/** Load a .env file into process.env without overriding existing values (no dependency). */
export function loadDotenv(path = resolve(import.meta.dir, "../.env")): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
