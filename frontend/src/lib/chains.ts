import { defineChain } from "viem";

/**
 * Browser RPC: the public X Layer endpoints (ADR-010). Only cheap per-user eth_calls go here; every list,
 * chart and history comes from @perk/api. No API key ever ships to the client bundle.
 */
export const PUBLIC_RPC = {
  mainnet: process.env.NEXT_PUBLIC_RPC_MAINNET ?? "https://rpc.xlayer.tech",
  testnet: process.env.NEXT_PUBLIC_RPC_TESTNET ?? "https://testrpc.xlayer.tech",
} as const;

export const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC.mainnet] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/xlayer" },
  },
});

export const xlayerTestnet = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC.testnet] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/xlayer-test" },
  },
  testnet: true,
});

export const SUPPORTED_CHAINS = [xlayerTestnet, xlayer] as const;

/** Testnet first: the scaffold defaults to X Layer testnet. */
export const DEFAULT_CHAIN = xlayerTestnet;

export function explorerTxUrl(chainId: number, hash: string): string {
  const base = chainId === xlayer.id ? xlayer.blockExplorers.default.url : xlayerTestnet.blockExplorers.default.url;
  return `${base}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  const base = chainId === xlayer.id ? xlayer.blockExplorers.default.url : xlayerTestnet.blockExplorers.default.url;
  return `${base}/address/${address}`;
}
