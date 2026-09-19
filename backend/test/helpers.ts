/**
 * Shared test helpers. Tests run against a REAL local Postgres (createdb perk_test); every test file gets a
 * fresh schema via resetDb(). Chain access is a mock viem transport with canned responses so tests are
 * deterministic and need no network.
 */
import {
  custom,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { createDb, type Db } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { type Client } from "../src/chain/rpc";
import { loadConfig, type AppConfig, type Deployment } from "../src/config";
import {
  bondingCurveAbi,
  feeRouterAbi,
  graduationManagerAbi,
  holderRewardDistributorAbi,
  launchFactoryAbi,
  lpGrantVaultAbi,
  referralRegistryAbi,
  templateRegistryAbi,
  assetRegistryAbi,
  positionManagerAbi,
} from "../src/generated/abis";
import { POOL_SWAP_EVENT, TRANSFER_EVENT } from "../src/chain/events";

export const TEST_DATABASE_URL = process.env.PERK_TEST_DATABASE_URL ?? "postgres://localhost:5432/perk_test";

/** Drop and recreate every table (schema public) then migrate. */
export async function resetDb(): Promise<Db> {
  const db = createDb(TEST_DATABASE_URL, { max: 1 });
  await db`select pg_advisory_lock(87231019)`;
  await db.unsafe("drop schema public cascade; create schema public;");
  await migrate(db);
  return db;
}

export const TEST_DEPLOYMENT: Deployment = {
  chainId: 1952,
  blockNumber: 1000,
  deployer: "0x00000000000000000000000000000000000000d1",
  protocolOwner: "0x00000000000000000000000000000000000000a1",
  factory: "0x00000000000000000000000000000000000000f1",
  curve: "0x00000000000000000000000000000000000000c1",
  hook: "0x0000000000000000000000000000000000000041",
  graduationManager: "0x0000000000000000000000000000000000000061",
  feeRouter: "0x00000000000000000000000000000000000000e1",
  distributor: "0x0000000000000000000000000000000000000071",
  lpGrantVault: "0x0000000000000000000000000000000000000081",
  referralRegistry: "0x0000000000000000000000000000000000000091",
  templateRegistry: "0x00000000000000000000000000000000000000b1",
  assetRegistry: "0x00000000000000000000000000000000000000b2",
  poolManager: "0x00000000000000000000000000000000000000d4",
    positionManager: "0x00000000000000000000000000000000000000d5",
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig({
    chainId: 1952,
    deployment: TEST_DEPLOYMENT,
    rpcUrl: "http://mock",
    databaseUrl: TEST_DATABASE_URL,
    confirmations: 0,
    pollMs: 0,
    logPage: 1000,
    port: 0,
    corsOrigins: ["http://localhost:3000"],
    mediaDriver: "local",
    ...overrides,
  });
}

export type RpcHandler = (method: string, params: unknown[]) => unknown | Promise<unknown>;

/**
 * viem client whose transport answers from `handler`. Throw inside the handler to simulate RPC errors.
 * Unknown methods throw so a test fails loudly instead of hanging.
 */
export function mockClient(handler: RpcHandler): Client {
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        return handler(method, params ?? []);
      },
    },
    { retryCount: 0 },
  );
  return createPublicClient({ transport, cacheTime: 0 });
}

export interface MockLog {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  topics: Hex[];
  data: Hex;
}

export interface MockChain {
  head: bigint;
  /** block number → { hash, timestamp } */
  blocks: Map<bigint, { hash: Hex; timestamp: bigint }>;
  /** all logs on the chain; eth_getLogs filters by address / topics / range */
  logs: MockLog[];
  /** tx hash → from */
  txFrom: Map<Hex, Address>;
  /** ERC-20 meta by token address (lowercase) */
  erc20: Map<string, { name: string; symbol: string; decimals: number; totalSupply: bigint; tokenURI?: string }>;
}

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ZERO20 = `0x${"00".repeat(20)}` as Hex;
const ZERO_BLOOM = `0x${"00".repeat(256)}` as Hex;
const EMPTY_UNCLE = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347" as Hex;

const ERC20_NAME = "0x06fdde03";
const ERC20_SYMBOL = "0x95d89b41";
const ERC20_DECIMALS = "0x313ce567";
const ERC20_SUPPLY = "0x18160ddd";
const ERC20_TOKEN_URI = toFunctionSelector("tokenURI()");

function headerOf(chain: MockChain, n: bigint): { hash: Hex; timestamp: bigint } {
  return chain.blocks.get(n) ?? { hash: blockHash(n), timestamp: 1_700_000_000n + n };
}

function addrMatch(filter: unknown, address: string): boolean {
  if (filter === undefined || filter === null) return true;
  const needle = address.toLowerCase();
  if (typeof filter === "string") return filter.toLowerCase() === needle;
  if (Array.isArray(filter)) {
    if (filter.length === 0) return true;
    return filter.some((a) => String(a).toLowerCase() === needle);
  }
  return true;
}

function topicMatch(filter: unknown[] | undefined, topics: Hex[]): boolean {
  if (!filter) return true;
  for (let i = 0; i < filter.length; i++) {
    const f = filter[i];
    if (f === null || f === undefined) continue;
    const t = topics[i];
    if (t === undefined) return false;
    if (Array.isArray(f)) {
      if (!f.some((x) => String(x).toLowerCase() === t.toLowerCase())) return false;
    } else if (String(f).toLowerCase() !== t.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function parseBlockTag(tag: unknown): bigint | "latest" {
  if (tag === "latest" || tag === undefined || tag === null) return "latest";
  return BigInt(tag as string);
}

/**
 * Handler over an in-memory chain supporting eth_blockNumber, eth_getBlockByNumber, eth_getLogs (address
 * list + topic filters incl. OR arrays), eth_getTransactionByHash, eth_call for name/symbol/decimals/totalSupply.
 * Records every method call in `calls` so tests can assert on paging behaviour.
 */
export function chainHandler(chain: MockChain, calls: string[] = []): RpcHandler {
  return async (method, params) => {
    calls.push(method);
    if (method === "eth_blockNumber") {
      return toHex(chain.head);
    }
    if (method === "eth_getBlockByNumber") {
      const tag = parseBlockTag(params[0]);
      const n = tag === "latest" ? chain.head : tag;
      const header = headerOf(chain, n);
      const parent = n === 0n ? ZERO32 : headerOf(chain, n - 1n).hash;
      return {
        number: toHex(n),
        hash: header.hash,
        parentHash: parent,
        timestamp: toHex(header.timestamp),
        nonce: "0x0000000000000000",
        difficulty: "0x0",
        totalDifficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        miner: ZERO20,
        extraData: "0x",
        mixHash: ZERO32,
        stateRoot: ZERO32,
        transactionsRoot: ZERO32,
        receiptsRoot: ZERO32,
        sha3Uncles: EMPTY_UNCLE,
        logsBloom: ZERO_BLOOM,
        size: "0x0",
        transactions: [],
        uncles: [],
        baseFeePerGas: "0x0",
      };
    }
    if (method === "eth_getLogs") {
      const q = (params[0] ?? {}) as {
        address?: Address | Address[];
        topics?: unknown[];
        fromBlock?: string;
        toBlock?: string;
      };
      const from = q.fromBlock !== undefined ? BigInt(q.fromBlock) : 0n;
      const to = q.toBlock !== undefined ? BigInt(q.toBlock) : chain.head;
      return chain.logs
        .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
        .filter((log) => addrMatch(q.address, log.address))
        .filter((log) => topicMatch(q.topics, log.topics))
        .map((log) => {
          const header = headerOf(chain, log.blockNumber);
          return {
            address: log.address,
            blockNumber: toHex(log.blockNumber),
            blockHash: header.hash,
            transactionHash: log.transactionHash,
            transactionIndex: "0x0",
            logIndex: toHex(log.logIndex),
            topics: log.topics,
            data: log.data,
            removed: false,
          };
        });
    }
    if (method === "eth_getTransactionByHash") {
      const hash = String(params[0]).toLowerCase() as Hex;
      let from: Address | undefined;
      for (const [k, v] of chain.txFrom) {
        if (k.toLowerCase() === hash) {
          from = v;
          break;
        }
      }
      const log = chain.logs.find((l) => l.transactionHash.toLowerCase() === hash);
      const blockNumber = log?.blockNumber ?? 0n;
      const header = headerOf(chain, blockNumber);
      return {
        hash,
        type: "0x0",
        nonce: "0x0",
        from: from ?? "0x00000000000000000000000000000000000000aa",
        to: ZERO20,
        input: "0x",
        value: "0x0",
        gas: "0x5208",
        gasPrice: "0x0",
        blockHash: header.hash,
        blockNumber: toHex(blockNumber),
        transactionIndex: "0x0",
        chainId: "0x7a0",
        v: "0x1b",
        r: ZERO32,
        s: ZERO32,
      };
    }
    if (method === "eth_call") {
      const call = (params[0] ?? {}) as { to?: string; data?: string };
      const to = (call.to ?? "").toLowerCase();
      const data = (call.data ?? "0x").toLowerCase();
      const selector = data.slice(0, 10);
      const meta = chain.erc20.get(to);
      if (!meta) throw new Error(`eth_call: no erc20 meta for ${to}`);
      if (selector === ERC20_NAME) return encodeAbiParameters([{ type: "string" }], [meta.name]);
      if (selector === ERC20_SYMBOL) return encodeAbiParameters([{ type: "string" }], [meta.symbol]);
      if (selector === ERC20_DECIMALS) return encodeAbiParameters([{ type: "uint256" }], [BigInt(meta.decimals)]);
      if (selector === ERC20_SUPPLY) return encodeAbiParameters([{ type: "uint256" }], [meta.totalSupply]);
      if (selector === ERC20_TOKEN_URI) return encodeAbiParameters([{ type: "string" }], [meta.tokenURI ?? ""]);
      throw new Error(`eth_call: unsupported selector ${selector}`);
    }
    throw new Error(`unsupported rpc method ${method} ${JSON.stringify(params)}`);
  };
}

export function blockHash(n: bigint, fork = 0): Hex {
  return `0x${(n * 1_000_003n + BigInt(fork)).toString(16).padStart(64, "0")}` as Hex;
}

export function txHash(block: bigint, logIndex: number, salt = 0): Hex {
  return `0x${(block * 1_000_007n + BigInt(logIndex) * 17n + BigInt(salt) * 1_000_000_009n).toString(16).padStart(64, "0")}` as Hex;
}

export const ABI_BY_CONTRACT = {
  factory: launchFactoryAbi,
  curve: bondingCurveAbi,
  graduationManager: graduationManagerAbi,
  feeRouter: feeRouterAbi,
  distributor: holderRewardDistributorAbi,
  lpGrantVault: lpGrantVaultAbi,
  referralRegistry: referralRegistryAbi,
  templateRegistry: templateRegistryAbi,
  assetRegistry: assetRegistryAbi,
  positionManager: positionManagerAbi,
} as const;

export interface MakeLogInput {
  address: Address;
  abi: Abi | readonly unknown[];
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex?: number;
  transactionHash?: Hex;
}

/** Encode a real event via viem encodeEventTopics + encodeAbiParameters for the non-indexed inputs. */
export function makeLog(input: MakeLogInput): MockLog {
  const event = getAbiItem({ abi: input.abi as Abi, name: input.eventName }) as AbiEvent;
  if (!event || event.type !== "event") {
    throw new Error(`makeLog: event ${input.eventName} not found`);
  }
  const topics = encodeEventTopics({
    abi: [event],
    eventName: input.eventName,
    args: input.args as never,
  }) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const values = nonIndexed.map((i) => {
    if (i.name && i.name in input.args) return input.args[i.name];
    throw new Error(`makeLog: missing arg ${i.name} for ${input.eventName}`);
  });
  const data = (nonIndexed.length ? encodeAbiParameters(nonIndexed as never, values as never) : "0x") as Hex;
  return {
    address: input.address,
    blockNumber: input.blockNumber,
    logIndex: input.logIndex ?? 0,
    transactionHash: input.transactionHash ?? txHash(input.blockNumber, input.logIndex ?? 0),
    topics,
    data,
  };
}

export function makeTransferLog(input: {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  logIndex?: number;
  transactionHash?: Hex;
}): MockLog {
  return makeLog({
    address: input.token,
    abi: [TRANSFER_EVENT],
    eventName: "Transfer",
    args: { from: input.from, to: input.to, value: input.value },
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: input.transactionHash,
  });
}

export function makeSwapLog(input: {
  poolManager: Address;
  id: Hex;
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  blockNumber: bigint;
  logIndex?: number;
  transactionHash?: Hex;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
  fee?: number;
}): MockLog {
  return makeLog({
    address: input.poolManager,
    abi: [POOL_SWAP_EVENT],
    eventName: "Swap",
    args: {
      id: input.id,
      sender: input.sender,
      amount0: input.amount0,
      amount1: input.amount1,
      sqrtPriceX96: input.sqrtPriceX96 ?? 1n << 96n,
      liquidity: input.liquidity ?? 0n,
      tick: input.tick ?? 0,
      fee: input.fee ?? 0,
    },
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: input.transactionHash,
  });
}

export function emptyChain(head = 0n): MockChain {
  return {
    head,
    blocks: new Map(),
    logs: [],
    txFrom: new Map(),
    erc20: new Map(),
  };
}
