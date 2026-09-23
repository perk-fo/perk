"use client";

import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { zeroAddress, type Address } from "viem";
import {
  assetRegistryAbi,
  graduationManagerAbi,
  launchFactoryAbi,
  lpGrantVaultAbi,
  moduleRegistryAbi,
  templateRegistryAbi,
} from "@/generated/abis";
import type { AdminRole } from "@/lib/api-types";
import { useWalletRoles } from "@/lib/api-hooks";
import { useDeployment } from "@/lib/hooks";

/**
 * The admin sections and who sees them. The Core Admin sees everything a General Admin or the Grant Admin can do,
 * because the contracts let the owner act as publisher and the API lets it curate.
 */
export type AdminSection = "protocol" | "roles" | "assets" | "grants" | "moderation" | "featured";

export const ADMIN_SECTIONS: ReadonlyArray<{ key: AdminSection; roles: readonly AdminRole[] }> = [
  { key: "protocol", roles: ["core"] },
  { key: "roles", roles: ["core"] },
  { key: "assets", roles: ["core", "operator"] },
  { key: "grants", roles: ["core", "grant"] },
  { key: "moderation", roles: ["core", "operator"] },
  { key: "featured", roles: ["core", "operator"] },
];

export interface AdminRoles {
  address: Address | undefined;
  roles: AdminRole[];
  isAdmin: boolean;
  isCore: boolean;
  isGrant: boolean;
  isOperator: boolean;
  /** Owner of the factory: the Core Admin. */
  owner: Address | undefined;
  /** The grant vault's publisher (the Grant Admin), or undefined while vacant. */
  publisher: Address | undefined;
  /**
   * Whether the connected wallet owns each contract the admin pages write to. They are all the same wallet unless an
   * ownership transfer is half done; each button checks the contract it calls.
   */
  owns: { vault: boolean; graduation: boolean; assets: boolean; modules: boolean; templates: boolean };
  can: (section: AdminSection) => boolean;
  /** Still finding out; render nothing role-dependent yet. */
  isLoading: boolean;
}

/**
 * The connected wallet's admin roles. The Core Admin and Grant Admin are read from the chain (so the emergency pause
 * works even while the API is down); General Admins come from the API, which is the only place they exist.
 */
export function useAdminRoles(): AdminRoles {
  const { deployment } = useDeployment();
  const { address, status } = useAccount();
  const chain = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: launchFactoryAbi, functionName: "owner" },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "owner" },
      { address: deployment?.graduationManager, abi: graduationManagerAbi, functionName: "owner" },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "publisher" },
      { address: deployment?.assetRegistry, abi: assetRegistryAbi, functionName: "owner" },
      { address: deployment?.moduleRegistry, abi: moduleRegistryAbi, functionName: "owner" },
      { address: deployment?.templateRegistry, abi: templateRegistryAbi, functionName: "owner" },
    ],
    // nobody without a wallet holds a role, so visitors cost no reads
    query: { enabled: !!deployment && !!address, refetchInterval: 60_000 },
  });
  const api = useWalletRoles(address);

  return useMemo(() => {
    const [factory, vault, graduation, publisherRaw, assets, modules, templates] = (chain.data ?? []).map(
      (r) => r?.result as Address | undefined,
    );
    const me = address?.toLowerCase();
    const is = (a: Address | undefined) => !!me && !!a && a.toLowerCase() === me;
    const publisher = publisherRaw && publisherRaw !== zeroAddress ? publisherRaw : undefined;
    const isCore = is(factory);
    const isGrant = is(publisher);
    const isOperator = !!api.data?.adminRoles.includes("operator");
    const roles: AdminRole[] = [];
    if (isCore) roles.push("core");
    if (isGrant) roles.push("grant");
    if (isOperator) roles.push("operator");
    const connecting = status === "connecting" || status === "reconnecting";
    return {
      address,
      roles,
      isAdmin: roles.length > 0,
      isCore,
      isGrant,
      isOperator,
      owner: factory,
      publisher,
      owns: { vault: is(vault), graduation: is(graduation), assets: is(assets), modules: is(modules), templates: is(templates) },
      can: (section) => ADMIN_SECTIONS.find((s) => s.key === section)!.roles.some((r) => roles.includes(r)),
      isLoading: connecting || (!!address && (chain.isLoading || api.isLoading)),
    };
  }, [address, status, chain.data, chain.isLoading, api.data, api.isLoading]);
}
