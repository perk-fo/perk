import deploymentsJson from "@/generated/deployments.json";
import type { Address } from "viem";

/** Subset of contracts/deployments/<chainId>.json used by the app. */
export interface Deployment {
  chainId: number;
  blockNumber: number;
  factory: Address;
  curve: Address;
  hook: Address;
  graduationManager: Address;
  feeRouter: Address;
  distributor: Address;
  lpGrantVault: Address;
  referralRegistry: Address;
  templateRegistry: Address;
  poolManager: Address;
  xdogToken: Address;
  assetRegistry?: Address;
  /** symbol -> token address for every registered ERC-20 quote asset. */
  quoteAssets?: Record<string, Address>;
}

const deployments = deploymentsJson as unknown as Record<string, Deployment | null>;

/** null when the chain has no synced deployment (e.g. mainnet 196 before launch). */
export function getDeployment(chainId: number): Deployment | null {
  return deployments[String(chainId)] ?? null;
}

/** Native quote is the zero address Currency. */
export const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000" as Address;

/** Module bitmap bits (PerkConstants). bit index -> module id label. */
export const MODULE_BITS: Array<[bigint, string]> = [
  [1n << 0n, "OFFICIAL_POOL_GUARD_V1"],
  [1n << 1n, "QUOTE_FEE_ROUTER_V1"],
  [1n << 2n, "HOLDER_QUOTE_REWARD_V1"],
  [1n << 3n, "LP_GRANT_V1"],
  [1n << 4n, "REFERRAL_GRANT_BOOST_V1"],
];

/** FlapVenue PoolSwapTest router on X Layer testnet (the only supported swap route in this scaffold). */
export const TESTNET_SWAP_ROUTER = (process.env.NEXT_PUBLIC_TESTNET_SWAP_ROUTER ?? "") as Address;

/** v4 TickMath bounds for exact-input swaps. */
export const MIN_SQRT_PRICE_PLUS_ONE = 4295128739n + 1n;
export const MAX_SQRT_PRICE_MINUS_ONE =
  1461446703485210103287273052203988822378723970342n - 1n;
