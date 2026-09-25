import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import deploymentsJson from "./generated/deployments.json";
import { registerSecret } from "./log";
import { parsePriceSources, type PriceSourceConfig } from "./prices/sources";

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
  positionManager: Address;
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
  deployment: Deployment;
  /** `local` writes to MEDIA_DIR; `pinata` pins via PINATA_JWT. */
  mediaDriver: "local" | "pinata";
  mediaDir: string;
  /** Origin used to mint local media URLs (no trailing slash). */
  publicApiUrl: string;
  pinataJwt: string | undefined;
  /** Gateway prefix for rewriting ipfs:// → https, including trailing slash. */
  ipfsGateway: string;
  /** Shared POST /v1/media/* token-bucket capacity per client (IPv6 clients by /64). */
  mediaRateLimit: number;
  mediaRateWindowMs: number;
  /**
   * Bytes all clients together may upload per day (MEDIA_DAILY_UPLOAD_BYTES, default 256 MiB). Uploads nothing refers
   * to yet are only removed after a week, so this bounds how much unreferenced media can pile up, from however many
   * addresses it comes.
   */
  mediaDailyUploadBytes: number;
  /** trustedProxyHops > 0. Kept for callers that only ask whether a proxy is trusted. */
  trustProxy: boolean;
  /**
   * Reverse proxies in front of the API that append to X-Forwarded-For (TRUSTED_PROXY_HOPS; TRUST_PROXY=true alone
   * means 1, which is what DigitalOcean App Platform needs). The client address is the entry that many places from the
   * right. 0 (the default): the socket peer is the client and forwarded headers are ignored.
   */
  trustedProxyHops: number;
  /** Largest request body the server will read at all (media uploads are the only POSTs). */
  maxBodyBytes: number;
  /** WebSocket connections one client address may hold at once (WS_MAX_CLIENTS_PER_IP, default 20). */
  wsMaxClientsPerIp: number;
  /**
   * Grant datasets may be read from file:// URIs (ALLOW_FILE_DATASET_URIS=true). For local development with the demo
   * driver only: it lets whoever publishes a grant root make the API read local files. Never on chain 196.
   */
  allowFileDatasetUris: boolean;
  /**
   * IPv4 ranges (CIDR) that outbound fetches accept in addition to public addresses (FETCH_ALLOW_RANGES, comma
   * separated). For a development machine behind a proxy that answers every DNS query with a "fake IP" (for example
   * 198.18.0.0/15), where no host would otherwise pass the public-address check. Never on chain 196.
   */
  fetchAllowRanges: string[];
  /**
   * Where each quote asset's US-dollar price comes from (PRICE_SOURCES, a JSON object from `native`, a quote address
   * or a quote symbol to a source string, merged over the defaults: native OKB from OKX's OKB-USDT ticker, tAAPL and
   * other "t" + US ticker stocks from CNBC's quote for the ticker). See src/prices/sources.ts.
   */
  priceSources: PriceSourceConfig;
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
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function boolEnv(name: string): boolean | undefined {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false, got "${process.env[name]}"`);
}

/** Every number the process runs on is checked once, whatever its source: LOG_PAGE=0 would loop forever. */
function checkInt(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return value;
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
  const publicApiUrlSet = overrides.publicApiUrl ?? (process.env.PUBLIC_API_URL?.trim() || undefined);
  // With the local media driver PUBLIC_API_URL is baked into every token's on-chain tokenURI: a deployment that
  // forgot it would publish http://localhost links forever. Development may default it; production may not.
  const productionLike = process.env.NODE_ENV === "production" || chainId === XLAYER_MAINNET;
  if (mediaDriverRaw === "local" && productionLike && publicApiUrlSet === undefined) {
    throw new Error(
      "PUBLIC_API_URL is required with MEDIA_DRIVER=local in production (it is written into on-chain tokenURIs)",
    );
  }
  const publicApiUrlRaw = publicApiUrlSet ?? `http://localhost:${port}`;
  if (!/^https?:\/\/[^\s/]+/.test(publicApiUrlRaw)) {
    throw new Error(`PUBLIC_API_URL must be an http(s) origin, got "${publicApiUrlRaw}"`);
  }
  const trustProxyFlag = overrides.trustProxy ?? boolEnv("TRUST_PROXY") ?? false;
  const trustedProxyHops = checkInt(
    "TRUSTED_PROXY_HOPS",
    overrides.trustedProxyHops ?? intEnv("TRUSTED_PROXY_HOPS", trustProxyFlag ? 1 : 0),
    0,
    10,
  );
  const allowFileDatasetUris = overrides.allowFileDatasetUris ?? boolEnv("ALLOW_FILE_DATASET_URIS") ?? false;
  if (allowFileDatasetUris && chainId === XLAYER_MAINNET) {
    throw new Error("ALLOW_FILE_DATASET_URIS is for local development and cannot be used on chain 196");
  }
  const fetchAllowRanges = overrides.fetchAllowRanges ?? listEnv("FETCH_ALLOW_RANGES");
  if (fetchAllowRanges.length > 0 && chainId === XLAYER_MAINNET) {
    throw new Error("FETCH_ALLOW_RANGES is for local development and cannot be used on chain 196");
  }
  for (const secret of [rpcUrl, databaseUrl, pinataJwt]) registerSecret(secret);
  return {
    chainId: checkInt("CHAIN_ID", chainId, 1),
    rpcUrl,
    databaseUrl,
    confirmations: checkInt("CONFIRMATIONS", overrides.confirmations ?? intEnv("CONFIRMATIONS", 2), 0, 10_000),
    pollMs: checkInt("POLL_MS", overrides.pollMs ?? intEnv("POLL_MS", 1500), 0, 3_600_000),
    catchupBlocks: checkInt("CATCHUP_BLOCKS", overrides.catchupBlocks ?? intEnv("CATCHUP_BLOCKS", 200), 0),
    logPage: checkInt("LOG_PAGE", overrides.logPage ?? intEnv("LOG_PAGE", 1000), 1, 1_000_000),
    port: checkInt("PORT", port, 0, 65_535),
    corsOrigins: overrides.corsOrigins ?? (listEnv("CORS_ORIGINS").length ? listEnv("CORS_ORIGINS") : ["http://localhost:3000"]),
    deployment,
    mediaDriver: mediaDriverRaw,
    mediaDir: overrides.mediaDir ?? process.env.MEDIA_DIR ?? "./data/media",
    publicApiUrl: publicApiUrlRaw.replace(/\/+$/, ""),
    pinataJwt,
    ipfsGateway: ipfsGatewayRaw.endsWith("/") ? ipfsGatewayRaw : `${ipfsGatewayRaw}/`,
    mediaRateLimit: checkInt("MEDIA_RATE_LIMIT", overrides.mediaRateLimit ?? intEnv("MEDIA_RATE_LIMIT", 20), 1),
    mediaRateWindowMs: checkInt(
      "MEDIA_RATE_WINDOW_MS",
      overrides.mediaRateWindowMs ?? intEnv("MEDIA_RATE_WINDOW_MS", 600_000),
      1_000,
    ),
    mediaDailyUploadBytes: checkInt(
      "MEDIA_DAILY_UPLOAD_BYTES",
      overrides.mediaDailyUploadBytes ?? intEnv("MEDIA_DAILY_UPLOAD_BYTES", 256 * 1024 * 1024),
      1024 * 1024,
    ),
    trustProxy: trustedProxyHops > 0,
    trustedProxyHops,
    maxBodyBytes: checkInt(
      "MAX_BODY_BYTES",
      overrides.maxBodyBytes ?? intEnv("MAX_BODY_BYTES", 3 * 1024 * 1024),
      64 * 1024,
    ),
    wsMaxClientsPerIp: checkInt(
      "WS_MAX_CLIENTS_PER_IP",
      overrides.wsMaxClientsPerIp ?? intEnv("WS_MAX_CLIENTS_PER_IP", 20),
      1,
    ),
    allowFileDatasetUris,
    fetchAllowRanges,
    priceSources: overrides.priceSources ?? parsePriceSources(process.env.PRICE_SOURCES),
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
