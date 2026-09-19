"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { referralRegistryAbi } from "@/generated/abis";
import { useDeployment } from "./hooks";
import { bindBlock, forgetInviter, isFresh, onStoredRefChange, readStoredRef, type BindBlock } from "./referral";

/** The inviter remembered from an invite link (null when none / expired). */
export function usePendingInviter(): Address | null {
  const [inviter, setInviter] = useState<Address | null>(null);
  useEffect(() => {
    const load = () => {
      const r = readStoredRef();
      setInviter(isFresh(r, Date.now()) ? r.inviter : null);
    };
    load();
    return onStoredRefChange(load);
  }, []);
  return inviter;
}

export interface InviteState {
  pending: Address | null;
  /** inviterOf(connected wallet); undefined while loading or disconnected. */
  myInviter: Address | undefined;
  /** Why binding `pending` would fail; null when it can be bound (or nothing is known yet). */
  block: BindBlock | null;
  /** Connected, pending link, on-chain state loaded and bindable. */
  canBind: boolean;
  refetch: () => void;
}

/**
 * Invite-link state for the connected wallet. Once the wallet has any inviter on-chain, or the link is its own
 * address, the remembered link is dropped: it can never be used.
 */
export function useInvite(): InviteState {
  const pending = usePendingInviter();
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const reads = useReadContracts({
    contracts: [
      { address: deployment?.referralRegistry, abi: referralRegistryAbi, functionName: "inviterOf", args: address ? [address] : undefined },
      { address: deployment?.referralRegistry, abi: referralRegistryAbi, functionName: "inviterOf", args: pending ? [pending] : undefined },
    ],
    query: { enabled: !!deployment && !!address },
  });
  const myInviter = reads.data?.[0]?.result as Address | undefined;
  const pendingsInviter = reads.data?.[1]?.result as Address | undefined;
  const loaded = reads.isSuccess && myInviter !== undefined;
  const block = address && pending && loaded ? bindBlock(address, pending, myInviter, pendingsInviter) : null;

  useEffect(() => {
    if (block === "self" || block === "alreadyBound") forgetInviter();
  }, [block]);

  return {
    pending,
    myInviter,
    block,
    canBind: !!address && !!pending && loaded && block === null,
    refetch: () => void reads.refetch(),
  };
}
