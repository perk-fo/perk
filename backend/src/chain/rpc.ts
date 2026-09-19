import {
  createPublicClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  toEventSelector,
} from "viem";
import { POOL_SWAP_EVENT, TRANSFER_EVENT, toRawLog, type RawLog } from "./events";

export type Client = PublicClient;

/** viem client over the server-side RPC URL. `transport` override is for tests (custom/mock transports). */
export function createClient(rpcUrl: string, transport?: Transport): Client {
  return createPublicClient({
    // viem caches eth_blockNumber for `cacheTime` (default 4 s): a 1.5 s poll would keep seeing a stale head
    cacheTime: 0,
    transport:
      transport ??
      http(rpcUrl, {
        batch: { batchSize: 50, wait: 10 },
        retryCount: 3,
        retryDelay: 500,
        timeout: 30_000,
      }),
  });
}

/**
 * eth_getLogs for a block range that may exceed the provider's page cap: split into ≤ `page` block windows,
 * run sequentially (providers rate-limit bursts), concatenate. `address` may be a list.
 */
export async function getLogsPaged(
  client: Client,
  params: { address: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint },
  page: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const step = BigInt(page);
  for (let from = params.fromBlock; from <= params.toBlock; from += step) {
    const to = from + step - 1n > params.toBlock ? params.toBlock : from + step - 1n;
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: params.address,
          topics: params.topics as never,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        },
      ],
    });
    for (const log of logs as never[]) {
      const raw = toRawLog(formatRpcLog(log));
      if (raw) out.push(raw);
    }
  }
  return out;
}

/** Minimal RPC log → viem Log shape (only the fields RawLog keeps). */
function formatRpcLog(log: {
  address: Address;
  blockNumber: Hex | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  topics: Hex[];
  data: Hex;
}) {
  return {
    address: log.address,
    blockNumber: log.blockNumber === null ? null : BigInt(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex === null ? null : Number(log.logIndex),
    topics: log.topics as [Hex, ...Hex[]] | [],
    data: log.data,
    transactionIndex: null,
    removed: false,
  } as never;
}

export const TRANSFER_TOPIC: Hex = toEventSelector(TRANSFER_EVENT);
export const SWAP_TOPIC: Hex = toEventSelector(POOL_SWAP_EVENT);

export { TRANSFER_EVENT, POOL_SWAP_EVENT };

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export async function getHeader(client: Client, blockNumber: bigint): Promise<BlockHeader> {
  const b = await client.getBlock({ blockNumber, includeTransactions: false });
  return { number: b.number, hash: b.hash, timestamp: b.timestamp };
}

/** Fetch headers for distinct block numbers, `concurrency` at a time. */
export async function getHeaders(client: Client, blocks: bigint[], concurrency = 8): Promise<Map<bigint, BlockHeader>> {
  const unique = [...new Set(blocks.map(String))].map(BigInt);
  const out = new Map<bigint, BlockHeader>();
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const headers = await Promise.all(batch.map((n) => getHeader(client, n)));
    headers.forEach((h) => out.set(h.number, h));
  }
  return out;
}

/** tx.from for a set of hashes (pool swaps report the router as sender). */
export async function getTxOrigins(client: Client, hashes: Hex[], concurrency = 8): Promise<Map<Hex, Address>> {
  const unique = [...new Set(hashes)];
  const out = new Map<Hex, Address>();
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const txs = await Promise.all(batch.map((hash) => client.getTransaction({ hash })));
    txs.forEach((tx, idx) => out.set(batch[idx], tx.from));
  }
  return out;
}

const TOKEN_URI_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface Erc20Meta {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  tokenURI: string;
}

export async function getErc20Meta(client: Client, token: Address): Promise<Erc20Meta> {
  const [name, symbol, decimals, totalSupply, tokenURI] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    client
      .readContract({ address: token, abi: TOKEN_URI_ABI, functionName: "tokenURI" })
      .then((s) => s, () => ""),
  ]);
  return { name, symbol, decimals: Number(decimals), totalSupply, tokenURI };
}
