"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useWalletRoles } from "./api-hooks";

/**
 * Role tiers (ADR-010 §4). A wallet can hold several; `tier` is the highest for badges.
 *  guest   — not connected
 *  user    — connected
 *  creator — created ≥ 1 launch (per-launch: `isCreatorOf`)
 *  lp      — holds ≥ 1 grant position (per-launch: `isLpOf`)
 *  admin   — protocol owner / deployer / configured admin
 */
export type Role = "guest" | "user" | "creator" | "lp" | "admin";

export const ROLE_ORDER: Role[] = ["guest", "user", "lp", "creator", "admin"];

/**
 * Tiered display switch. While false every gated element renders for everyone (with a data-role attribute
 * so styling can still be reviewed); flip to true when the client asks for role-based visibility.
 */
export const ROLE_GATING_ENABLED = false;

export interface RoleState {
  address: Address | undefined;
  connected: boolean;
  roles: Set<Role>;
  tier: Role;
  isAdmin: boolean;
  creatorOf: Set<string>;
  lpOf: Set<string>;
  allocatedIn: Set<string>;
  isCreatorOf: (meme: Address | undefined) => boolean;
  isLpOf: (meme: Address | undefined) => boolean;
  /** true when `required` is satisfied, or gating is off. */
  can: (required: Role | Role[], meme?: Address) => boolean;
  isLoading: boolean;
}

function lowerSet(list: readonly string[] | undefined): Set<string> {
  return new Set((list ?? []).map((a) => a.toLowerCase()));
}

export function deriveRoles(input: {
  connected: boolean;
  isAdmin: boolean;
  creatorOf: Set<string>;
  lpOf: Set<string>;
}): { roles: Set<Role>; tier: Role } {
  const roles = new Set<Role>();
  if (!input.connected) roles.add("guest");
  else {
    roles.add("user");
    if (input.creatorOf.size > 0) roles.add("creator");
    if (input.lpOf.size > 0) roles.add("lp");
    if (input.isAdmin) roles.add("admin");
  }
  let tier: Role = "guest";
  for (const r of ROLE_ORDER) if (roles.has(r)) tier = r;
  return { roles, tier };
}

export function useRoles(): RoleState {
  const { address, isConnected } = useAccount();
  const q = useWalletRoles(isConnected ? address : undefined);
  return useMemo(() => {
    const data = q.data;
    const creatorOf = lowerSet(data?.creatorOf);
    const lpOf = lowerSet(data?.lpOf);
    const allocatedIn = lowerSet(data?.allocatedIn);
    const isAdmin = data?.isAdmin ?? false;
    const { roles, tier } = deriveRoles({ connected: isConnected, isAdmin, creatorOf, lpOf });
    const isCreatorOf = (meme: Address | undefined) => !!meme && creatorOf.has(meme.toLowerCase());
    const isLpOf = (meme: Address | undefined) => !!meme && lpOf.has(meme.toLowerCase());
    const can = (required: Role | Role[], meme?: Address) => {
      if (!ROLE_GATING_ENABLED) return true;
      const list = Array.isArray(required) ? required : [required];
      return list.some((r) => {
        if (r === "guest") return true;
        if (r === "user") return isConnected;
        if (r === "admin") return isAdmin;
        if (r === "creator") return meme ? isCreatorOf(meme) : roles.has("creator");
        if (r === "lp") return meme ? isLpOf(meme) : roles.has("lp");
        return false;
      });
    };
    return {
      address,
      connected: isConnected,
      roles,
      tier,
      isAdmin,
      creatorOf,
      lpOf,
      allocatedIn,
      isCreatorOf,
      isLpOf,
      can,
      isLoading: q.isLoading,
    };
  }, [address, isConnected, q.data, q.isLoading]);
}
