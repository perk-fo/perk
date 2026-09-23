"use client";

import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { graduationManagerAbi, launchFactoryAbi, lpGrantVaultAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/hooks";

/**
 * Who the core admin is, read from the chain rather than from any list the site keeps: the owner of each contract
 * the admin page writes to (all the same address unless an ownership transfer is half done). The contracts enforce
 * this themselves; the site only uses it to decide what to show and which buttons to enable.
 */
export function useCoreAdmin() {
  const { deployment } = useDeployment();
  const { address } = useAccount();
  const q = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: launchFactoryAbi, functionName: "owner" },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "owner" },
      { address: deployment?.graduationManager, abi: graduationManagerAbi, functionName: "owner" },
    ],
    query: { enabled: !!deployment, refetchInterval: 60_000 },
  });
  const [factory, vault, graduation] = (q.data ?? []).map((r) => r?.result as Address | undefined);
  const me = address?.toLowerCase();
  const is = (owner: Address | undefined) => !!me && !!owner && owner.toLowerCase() === me;
  return {
    owner: factory,
    isCoreAdmin: is(factory),
    ownsVault: is(vault),
    ownsGraduation: is(graduation),
    isLoading: q.isLoading,
  };
}
