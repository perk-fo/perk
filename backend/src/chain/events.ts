import { decodeEventLog, parseAbiItem, type Address, type Hex, type Log } from "viem";
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
} from "../generated/abis";
import type { Deployment } from "../config";

/** ERC-20 Transfer (meme tokens). */
export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Uniswap v4 PoolManager Swap. amount0/amount1 are the swapper's deltas (negative = paid). */
export const POOL_SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

/** Contract → ABI, for the Perk contracts whose logs are decoded. */
export function perkContracts(d: Deployment): Array<{ name: PerkContract; address: Address; abi: readonly unknown[] }> {
  const list: Array<{ name: PerkContract; address: Address; abi: readonly unknown[] }> = [
    { name: "factory", address: d.factory, abi: launchFactoryAbi },
    { name: "curve", address: d.curve, abi: bondingCurveAbi },
    { name: "graduationManager", address: d.graduationManager, abi: graduationManagerAbi },
    { name: "feeRouter", address: d.feeRouter, abi: feeRouterAbi },
    { name: "distributor", address: d.distributor, abi: holderRewardDistributorAbi },
    { name: "lpGrantVault", address: d.lpGrantVault, abi: lpGrantVaultAbi },
    { name: "referralRegistry", address: d.referralRegistry, abi: referralRegistryAbi },
    { name: "templateRegistry", address: d.templateRegistry, abi: templateRegistryAbi },
  ];
  if (d.assetRegistry) list.push({ name: "assetRegistry", address: d.assetRegistry, abi: assetRegistryAbi });
  return list;
}

export type PerkContract =
  | "factory"
  | "curve"
  | "graduationManager"
  | "feeRouter"
  | "distributor"
  | "lpGrantVault"
  | "referralRegistry"
  | "templateRegistry"
  | "assetRegistry"
  | "memeToken"
  | "poolManager";

/** A raw log with the fields the indexer needs (viem Log with nulls removed). */
export interface RawLog {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
}

export interface DecodedLog<TArgs = Record<string, unknown>> extends RawLog {
  contract: PerkContract;
  eventName: string;
  args: TArgs;
}

export function toRawLog(log: Log): RawLog | null {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    return null;
  }
  return {
    address: log.address,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    topics: log.topics,
    data: log.data,
  };
}

/**
 * Decode a raw log against the ABI of the contract that emitted it. Returns null for events the ABI does
 * not know (e.g. OpenZeppelin OwnershipTransferred is decoded fine, unknown selectors are skipped).
 */
export function decodePerkLog(
  log: RawLog,
  contractsByAddress: Map<string, { name: PerkContract; abi: readonly unknown[] }>,
): DecodedLog | null {
  const entry = contractsByAddress.get(log.address.toLowerCase());
  if (!entry) return null;
  try {
    const decoded = decodeEventLog({ abi: entry.abi as never, data: log.data, topics: log.topics as never });
    return {
      ...log,
      contract: entry.name,
      eventName: String(decoded.eventName),
      args: (decoded.args ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function decodeTransferLog(log: RawLog): DecodedLog<{ from: Address; to: Address; value: bigint }> | null {
  try {
    const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics as never });
    return { ...log, contract: "memeToken", eventName: "Transfer", args: decoded.args as never };
  } catch {
    return null;
  }
}

export interface SwapArgs extends Record<string, unknown> {
  id: Hex;
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
}

export function decodeSwapLog(log: RawLog): DecodedLog<SwapArgs> | null {
  try {
    const decoded = decodeEventLog({ abi: [POOL_SWAP_EVENT], data: log.data, topics: log.topics as never });
    return { ...log, contract: "poolManager", eventName: "Swap", args: decoded.args as never };
  } catch {
    return null;
  }
}

/** Deterministic order in which logs are applied: by block, then log index. */
export function sortLogs<T extends RawLog>(logs: T[]): T[] {
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

/**
 * Apply order: by block and log index, except that within one transaction `factory.LaunchCreated` moves in
 * front of its siblings. createLaunch emits MemeRegistered / Transfer (mints) / CurveInitialized / a dev-buy
 * CurveBuy BEFORE LaunchCreated, and those handlers update the launches row that LaunchCreated inserts.
 */
export function orderForApply<T extends RawLog & { contract: string; eventName: string }>(logs: T[]): T[] {
  const firstIndex = new Map<string, number>();
  for (const l of logs) {
    const k = l.transactionHash.toLowerCase();
    const cur = firstIndex.get(k);
    if (cur === undefined || l.logIndex < cur) firstIndex.set(k, l.logIndex);
  }
  const key = (l: T) =>
    l.contract === "factory" && l.eventName === "LaunchCreated"
      ? firstIndex.get(l.transactionHash.toLowerCase())! - 0.5
      : l.logIndex;
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return key(a) - key(b);
  });
}
