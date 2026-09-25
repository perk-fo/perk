import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  encodeAbiParameters,
  erc20Abi,
  ExecutionRevertedError,
  http,
  keccak256,
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
        // X Layer's public RPC rejects a JSON-RPC batch of more than 10 calls ("too many RPC calls in batch
        // request", as a single error object that viem cannot match to the calls); 10 is also fine for Alchemy.
        batch: { batchSize: 10, wait: 10 },
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
  parentHash: Hex;
  timestamp: bigint;
}

export async function getHeader(client: Client, blockNumber: bigint): Promise<BlockHeader> {
  const b = await client.getBlock({ blockNumber, includeTransactions: false });
  return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
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

/**
 * Whether a failed contract read is the contract's own answer (it reverted, has no code, or returned data that does
 * not decode), which asking again will not change, as opposed to the RPC being unavailable or slow.
 */
export function isDeterministicCallError(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof ExecutionRevertedError ||
        (e instanceof BaseError &&
          /^(AbiDecoding|PositionOutOfBounds|SliceOffsetOutOfBounds|InvalidBytesBoolean|InvalidAddress)/.test(e.name)),
    ) !== null
  );
}

/** Settle a contract read: null when the contract refused it, the RPC's error (thrown) when the RPC failed. */
async function answerOrNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isDeterministicCallError(err)) return null;
    throw err;
  }
}

export interface Erc20Meta {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  /** "" when the token has no tokenURI(). */
  tokenURI: string;
}

/**
 * ERC-20 metadata plus the Perk meme token's tokenURI(). A field the contract does not answer comes back null (or ""
 * for the URI). An RPC failure throws, so the caller tries again later instead of storing a guess as fact.
 */
export async function getErc20Meta(client: Client, token: Address): Promise<Erc20Meta> {
  const [name, symbol, decimals, totalSupply, tokenURI] = await Promise.all([
    answerOrNull(client.readContract({ address: token, abi: erc20Abi, functionName: "name" })),
    answerOrNull(client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
    answerOrNull(client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
    answerOrNull(client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" })),
    answerOrNull(client.readContract({ address: token, abi: TOKEN_URI_ABI, functionName: "tokenURI" })),
  ]);
  return { name, symbol, decimals: decimals === null ? null : Number(decimals), totalSupply, tokenURI: tokenURI ?? "" };
}

const POSITION_MANAGER_ABI = [
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "info", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

/**
 * The pool a PositionManager token belongs to, as a pool id matching `launches.pool_id`. v4 derives the id by
 * hashing the encoded PoolKey, which is what `PoolId.toId()` does on chain. Throws when either read fails; callers
 * tell a refused read from an unavailable RPC with `isDeterministicCallError`.
 */
export async function getPositionPool(
  client: Client,
  positionManager: Address,
  tokenId: bigint,
): Promise<[{ poolId: Hex; liquidity: bigint }]> {
  const [key, liquidity] = await Promise.all([
    client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "getPoolAndPositionInfo",
      args: [tokenId],
    }),
    answerOrNull(
      client.readContract({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: "getPositionLiquidity",
        args: [tokenId],
      }),
    ).then((l) => (l as bigint | null) ?? 0n),
  ]);
  const k = (key as readonly unknown[])[0] as {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
  return [{ poolId: poolId.toLowerCase() as Hex, liquidity }];
}
