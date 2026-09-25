/**
 * What the CLIs share: connecting to the endpoint from the environment, and printing failures without the
 * endpoint or its key.
 */
import { viemChainReader, type ChainReader } from "../chain";
import { stringFlag } from "../config";
import {
  createRpcClient,
  redactSecrets,
  redactUrl,
  resolveRpcUrl,
  RPC_FLAG_WARNING,
  rpcSettingsFromEnv,
  secretsFromEnv,
  type RpcSettings,
} from "../rpc";

/** Secrets registered so far; `fail` scrubs them from whatever it prints. */
const secrets: string[] = secretsFromEnv();

export interface Connection {
  reader: ChainReader;
  settings: RpcSettings;
  /** Printable form of the endpoint (scheme and host only). */
  endpoint: string;
}

/**
 * Connect to the endpoint for `chainId` (RPC_URL, else ALCHEMY_API_KEY; `--rpc-url` still works but warns), or
 * return null when none is configured.
 */
export function connect(chainId: number, flags: Record<string, string | true>): Connection | null {
  const flagUrl = stringFlag(flags, "rpc-url");
  if (flagUrl) {
    secrets.push(flagUrl);
    console.error(RPC_FLAG_WARNING);
  }
  const rpc = resolveRpcUrl(chainId, { flagUrl });
  if (!rpc) return null;
  secrets.push(rpc.url);
  const settings = rpcSettingsFromEnv();
  const client = createRpcClient(rpc.url, chainId, settings);
  return {
    reader: viemChainReader(client, settings),
    settings,
    endpoint: `${redactUrl(rpc.url)} (from ${rpc.source})`,
  };
}

export const NO_RPC_MESSAGE =
  "no RPC endpoint: set RPC_URL (or ALCHEMY_API_KEY). The public X Layer endpoints need LOG_PAGE=100.";

/** Print an error with every URL and key removed, then exit non-zero. */
export function fail(err: unknown, code = 1): never {
  const text = err instanceof Error ? err.message : String(err);
  console.error(redactSecrets(text, secrets));
  process.exit(code);
}
