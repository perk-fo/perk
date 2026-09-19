import { parseAbiItem } from "viem";

/**
 * Minimal ABIs — only the events and views the indexer needs.
 * Sources: contracts/src/interfaces/IPerkReferralRegistry.sol, IPerkLPGrantVault.sol.
 */

export const OPTED_IN_EVENT = parseAbiItem("event OptedIn(address indexed account, uint64 blockNumber)");
export const INVITER_BOUND_EVENT = parseAbiItem(
  "event InviterBound(address indexed invitee, address indexed inviter, uint64 blockNumber)",
);
export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * LPGrantVault.campaign(meme) returns the full Campaign struct
 * (contracts/src/interfaces/IPerkLPGrantVault.sol `struct Campaign`).
 * The indexer only consumes status / quote / graduatedAtBlock / basePool / referralBudget,
 * but the ABI must describe the whole tuple to decode the response.
 */
export const CAMPAIGN_ABI = [
  {
    type: "function",
    name: "campaign",
    stateMutability: "view",
    inputs: [{ name: "meme", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "quote", type: "address" },
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "poolId", type: "bytes32" },
          { name: "memeIsCurrency0", type: "bool" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "graduatedAt", type: "uint64" },
          { name: "graduatedAtBlock", type: "uint64" },
          { name: "windowSeconds", type: "uint64" },
          { name: "minLpSeconds", type: "uint64" },
          { name: "startTime", type: "uint64" },
          { name: "endTime", type: "uint64" },
          { name: "reserve", type: "uint256" },
          { name: "basePool", type: "uint256" },
          { name: "referralBudget", type: "uint256" },
          { name: "referralBudgetUsed", type: "uint256" },
          { name: "totalActivated", type: "uint256" },
          { name: "burned", type: "uint256" },
          { name: "root", type: "bytes32" },
          { name: "rootUri", type: "string" },
          { name: "rootProposedAt", type: "uint64" },
          { name: "rootTotalBase", type: "uint256" },
          { name: "rootTotalInviteeBoost", type: "uint256" },
          { name: "incentiveBalance", type: "uint256" },
          { name: "activeLiquidity", type: "uint256" },
          { name: "accIncentivePerLiquidity", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** LPGrantVault.leafHash((address,uint256,uint256)) — mirrors the on-chain double-keccak leaf encoding. */
export const LEAF_HASH_ABI = [
  {
    type: "function",
    name: "leafHash",
    stateMutability: "pure",
    inputs: [
      {
        name: "leaf",
        type: "tuple",
        components: [
          { name: "account", type: "address" },
          { name: "baseAllocation", type: "uint256" },
          { name: "inviteeBoost", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/** Campaign status enum (contracts/src/libraries/PerkTypes.sol order). */
export enum CampaignStatus {
  NONE = 0,
  AWAITING_ROOT = 1,
  ROOT_PROPOSED = 2,
  ACTIVE = 3,
  EXPIRED = 4,
  CANCELLED = 5,
}
