/**
 * RPC access for the snapshot tooling: where the endpoint comes from, how requests are batched, bounded and
 * retried, and how the endpoint is kept out of anything printed.
 *
 * The endpoint usually carries an API key in its path, so it is read from the environment (RPC_URL, else an Alchemy
 * URL built from ALCHEMY_API_KEY) and never printed, logged or written into a dataset. The `--rpc-url` flag still
 * exists for compatibility, but a flag is visible to every local user in the process list and in shell history, so
 * the CLIs warn when it is used.
 */
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

/** X Layer chain ids. */
export const XLAYER_MAINNET = 196;
export const XLAYER_TESTNET = 1952;

export interface RpcSettings {
  /** Calls per JSON-RPC batch (RPC_BATCH_SIZE). The public X Layer endpoints reject batches above 10; 1 disables batching. */
  batchSize: number;
  /** Calls in flight at once across the balance sampler and the other per-call loops (RPC_CONCURRENCY). */
  concurrency: number;
  /** Retries per call after the first attempt, with exponential backoff (RPC_RETRIES). */
  retries: number;
  /** Base backoff delay in milliseconds; doubles per retry, capped at 30 s (RPC_RETRY_DELAY_MS). */
  retryDelayMs: number;
  /** Per-request timeout in milliseconds (RPC_TIMEOUT_MS). */
  timeoutMs: number;
  /** Blocks per eth_getLogs request (LOG_PAGE). Alchemy serves 1,000; the public X Layer endpoints 100. */
  logPage: bigint;
  /** eth_getLogs pages in flight at once (LOG_CONCURRENCY). */
  logConcurrency: number;
}

export const DEFAULT_RPC_SETTINGS: RpcSettings = {
  batchSize: 10,
  concurrency: 10,
  retries: 6,
  retryDelayMs: 500,
  timeoutMs: 30_000,
  logPage: 1000n,
  logConcurrency: 4,
};

const MAX_RETRY_DELAY_MS = 30_000;

/** Parse a positive integer setting; an empty or missing value falls back to the default, anything else must be valid. */
export function positiveInt(raw: string | undefined, fallback: number, name: string, min = 1): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

/** Read the RPC settings from the environment. Invalid values fail loudly instead of looping or flooding the endpoint. */
export function rpcSettingsFromEnv(env: Record<string, string | undefined> = process.env): RpcSettings {
  const d = DEFAULT_RPC_SETTINGS;
  return {
    batchSize: positiveInt(env.RPC_BATCH_SIZE, d.batchSize, "RPC_BATCH_SIZE"),
    concurrency: positiveInt(env.RPC_CONCURRENCY, d.concurrency, "RPC_CONCURRENCY"),
    retries: positiveInt(env.RPC_RETRIES, d.retries, "RPC_RETRIES", 0),
    retryDelayMs: positiveInt(env.RPC_RETRY_DELAY_MS, d.retryDelayMs, "RPC_RETRY_DELAY_MS", 0),
    timeoutMs: positiveInt(env.RPC_TIMEOUT_MS, d.timeoutMs, "RPC_TIMEOUT_MS"),
    logPage: BigInt(positiveInt(env.LOG_PAGE, Number(d.logPage), "LOG_PAGE")),
    logConcurrency: positiveInt(env.LOG_CONCURRENCY, d.logConcurrency, "LOG_CONCURRENCY"),
  };
}

function alchemySlug(chainId: number): string {
  if (chainId === XLAYER_MAINNET) return "mainnet";
  if (chainId === XLAYER_TESTNET) return "testnet";
  throw new Error(`unsupported chain id ${chainId} (expected ${XLAYER_MAINNET} or ${XLAYER_TESTNET})`);
}

export interface ResolvedRpc {
  url: string;
  source: "--rpc-url" | "RPC_URL" | "ALCHEMY_API_KEY";
}

/**
 * The RPC endpoint: the `--rpc-url` flag if given (insecure: see the module comment), else RPC_URL, else the
 * Alchemy endpoint for the chain built from ALCHEMY_API_KEY. Null when none is configured.
 */
export function resolveRpcUrl(
  chainId: number,
  opts: { flagUrl?: string; env?: Record<string, string | undefined> } = {},
): ResolvedRpc | null {
  const env = opts.env ?? process.env;
  if (opts.flagUrl) return { url: opts.flagUrl, source: "--rpc-url" };
  if (env.RPC_URL && env.RPC_URL.trim() !== "") return { url: env.RPC_URL.trim(), source: "RPC_URL" };
  if (env.ALCHEMY_API_KEY && env.ALCHEMY_API_KEY.trim() !== "") {
    return {
      url: `https://xlayer-${alchemySlug(chainId)}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY.trim()}`,
      source: "ALCHEMY_API_KEY",
    };
  }
  return null;
}

/** The message printed when a CLI passes the endpoint as a flag. */
export const RPC_FLAG_WARNING = "warning: --rpc-url is visible in the process list; set RPC_URL instead";

/** Scheme and host only; any credentials, path, query or fragment are replaced by `<redacted>`. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hidden = u.username !== "" || u.password !== "" || (u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "";
    return `${u.protocol}//${u.host}${hidden ? "/<redacted>" : ""}`;
  } catch {
    return "<redacted>";
  }
}

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`<>)\]}]+/gi;

/**
 * Remove secrets from text that is about to be printed: every URL is cut down to its scheme and host, and each of
 * `secrets` (an API key, a full endpoint URL) is replaced wherever it appears on its own.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(URL_PATTERN, (m) => redactUrl(m));
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join("<redacted>");
    try {
      // the path and query of an endpoint URL are where keys live; hide them even when printed without the host
      const u = new URL(s);
      for (const part of [u.pathname + u.search, u.pathname, u.search.slice(1), u.password]) {
        if (part && part.length >= 6 && part !== "/") out = out.split(part).join("<redacted>");
      }
    } catch {
      /* not a URL: already replaced verbatim */
    }
  }
  return out;
}

/** The secrets a CLI must never print: the resolved endpoint and the key it may have been built from. */
export function secretsFromEnv(rpcUrl?: string, env: Record<string, string | undefined> = process.env): string[] {
  return [rpcUrl, env.RPC_URL, env.ALCHEMY_API_KEY].filter((s): s is string => typeof s === "string" && s !== "");
}

function chainFor(chainId: number) {
  return defineChain({
    id: chainId,
    name: chainId === XLAYER_MAINNET ? "X Layer" : chainId === XLAYER_TESTNET ? "X Layer Testnet" : `chain ${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

/**
 * A viem client over the endpoint. Batching is capped at `batchSize` calls (the public X Layer RPC rejects larger
 * batches); retries are done per call by `withRetry`, not by the transport, so a failure is retried once rather than
 * at two layers. Multicall stays off: it cannot batch native balance reads.
 */
export function createRpcClient(url: string, chainId: number, settings: RpcSettings): PublicClient {
  return createPublicClient({
    chain: chainFor(chainId),
    cacheTime: 0,
    transport: http(url, {
      batch: settings.batchSize > 1 ? { batchSize: settings.batchSize, wait: 10 } : false,
      retryCount: 0,
      timeout: settings.timeoutMs,
    }),
    batch: { multicall: false },
  }) as PublicClient;
}

function errorCode(err: unknown): number | undefined {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    if (e instanceof Error) parts.push(e.message);
    else if (typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      parts.push((e as { message: string }).message);
    } else parts.push(String(e));
    e = typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  }
  return parts.join(" | ");
}

const RANGE_ERROR =
  /block range|range (?:is )?too (?:large|wide|big)|greater than \d+ max|max(?:imum)? (?:block )?range|exceed(?:s|ed)? .*(?:range|limit|results)|response size|more than \d+ (?:results|logs)|query returned more than/i;

/** True when an eth_getLogs failure means the block range was too wide for the provider. */
export function isLogRangeError(err: unknown): boolean {
  return RANGE_ERROR.test(errorText(err));
}

/** The provider's maximum range when its error states one ("block range greater than 100 max"). */
export function logRangeHint(err: unknown): bigint | undefined {
  const m = /greater than (\d+) max|max(?:imum)?(?: block)? range(?: is| of)?:? (\d+)/i.exec(errorText(err));
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isInteger(n) && n > 0 ? BigInt(n) : undefined;
}

/**
 * Failures that retrying cannot fix: a revert, invalid parameters (which include a too-wide log range, handled by
 * splitting instead), an unknown method, or a batch larger than the endpoint accepts (lower RPC_BATCH_SIZE).
 */
export function isPermanentRpcError(err: unknown): boolean {
  const code = errorCode(err);
  if (code === -32602 || code === -32601 || code === -32014 || code === 3) return true;
  const text = errorText(err);
  if (/execution reverted|reverted with|ContractFunctionRevertedError|returned no data/i.test(text)) return true;
  return isLogRangeError(err);
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient failures up to `retries` times with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; retryDelayMs: number; sleep?: Sleep; isPermanent?: (err: unknown) => boolean },
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const isPermanent = opts.isPermanent ?? isPermanentRpcError;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || isPermanent(err)) throw err;
      const base = Math.min(MAX_RETRY_DELAY_MS, opts.retryDelayMs * 2 ** attempt);
      await sleep(Math.round(base * (0.5 + Math.random() * 0.5)));
    }
  }
}
