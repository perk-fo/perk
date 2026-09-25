import { erc20Abi, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { CAMPAIGN_ABI } from "./abi";
import type { RawLog } from "./optin";
import { withRetry, type RpcSettings } from "./rpc";

/** The campaign fields the tooling reads (IPerkLPGrantVault.Campaign). */
export interface CampaignView {
  status: number;
  quote: Address;
  hooks: Address;
  graduatedAtBlock: bigint;
  basePool: bigint;
  referralBudget: bigint;
  root: Hex;
  rootUri: string;
  rootTotalBase: bigint;
  rootTotalInviteeBoost: bigint;
}

/**
 * Everything the snapshot, verify and propose tools read from the chain. Every historical read names its block, so
 * a run is reproducible. The viem adapter below is the production implementation; tests use in-memory fakes.
 */
export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<Hex>;
  getCode(address: Address, blockNumber: bigint): Promise<Hex | undefined>;
  getBalance(address: Address, blockNumber: bigint): Promise<bigint>;
  getLogs(address: Address, topic0: Hex, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  readCampaign(vault: Address, meme: Address, blockNumber: bigint): Promise<CampaignView>;
  readTotalSupply(token: Address, blockNumber: bigint): Promise<bigint>;
  readBalanceOf(token: Address, account: Address, blockNumber: bigint): Promise<bigint>;
}

/** ChainReader over a viem client; every call is retried with backoff (see rpc.withRetry). */
export function viemChainReader(client: PublicClient, settings: Pick<RpcSettings, "retries" | "retryDelayMs">): ChainReader {
  const retry = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, settings);
  return {
    getChainId: () => retry(() => client.getChainId()),
    getBlockNumber: () => retry(() => client.getBlockNumber({ cacheTime: 0 })),
    getBlockTimestamp: (blockNumber) => retry(async () => (await client.getBlock({ blockNumber })).timestamp),
    getBlockHash: (blockNumber) =>
      retry(async () => {
        const block = await client.getBlock({ blockNumber });
        if (!block.hash) throw new Error(`block ${blockNumber} has no hash`);
        return block.hash;
      }),
    getCode: (address, blockNumber) => retry(() => client.getCode({ address, blockNumber })),
    getBalance: (address, blockNumber) => retry(() => client.getBalance({ address, blockNumber })),
    getLogs: (address, topic0, fromBlock, toBlock) =>
      retry(async () => {
        const logs = await client.getLogs({ address, fromBlock, toBlock, topics: [topic0] } as never);
        return (logs as { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number }[]).map(
          (l): RawLog => ({
            address: l.address,
            topics: [...l.topics],
            data: l.data,
            blockNumber: l.blockNumber,
            logIndex: l.logIndex,
          }),
        );
      }),
    readCampaign: (vault, meme, blockNumber) =>
      retry(async () => {
        const c = await client.readContract({
          address: vault,
          abi: CAMPAIGN_ABI,
          functionName: "campaign",
          args: [meme],
          blockNumber,
        });
        return {
          status: Number(c.status),
          quote: getAddress(c.quote),
          hooks: getAddress(c.key.hooks),
          graduatedAtBlock: c.graduatedAtBlock,
          basePool: c.basePool,
          referralBudget: c.referralBudget,
          root: c.root,
          rootUri: c.rootUri,
          rootTotalBase: c.rootTotalBase,
          rootTotalInviteeBoost: c.rootTotalInviteeBoost,
        };
      }),
    readTotalSupply: (token, blockNumber) =>
      retry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber })),
    readBalanceOf: (token, account, blockNumber) =>
      retry(() =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber }),
      ),
  };
}
