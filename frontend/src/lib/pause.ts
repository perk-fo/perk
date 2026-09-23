"use client";

import { useReadContract } from "wagmi";
import { launchFactoryAbi } from "@/generated/abis";
import { useDeployment, useTabVisible } from "@/lib/hooks";

/**
 * Emergency pause areas, mirroring PerkConstants.PAUSE_* in the contracts. Only entry points can be paused (new
 * launches, curve buys, graduation, joining LP Grant); selling, withdrawing, claiming and refunds have no pause at
 * all, so the UI never needs to disable them.
 */
export const PAUSE_AREAS = {
  launch: 1n,
  buy: 2n,
  graduation: 4n,
  grantJoin: 8n,
} as const;
export type PauseArea = keyof typeof PAUSE_AREAS;
export const PAUSE_ORDER: PauseArea[] = ["launch", "buy", "graduation", "grantJoin"];
export const PAUSE_ALL = 15n;

/** The factory's paused areas, refreshed every 30 s while the tab is visible. */
export function usePauseFlags() {
  const { deployment } = useDeployment();
  const visible = useTabVisible();
  const q = useReadContract({
    address: deployment?.factory,
    abi: launchFactoryAbi,
    functionName: "pausedFlags",
    query: { enabled: !!deployment, refetchInterval: visible ? 30_000 : false },
  });
  const flags = (q.data as bigint | undefined) ?? 0n;
  return {
    flags,
    loaded: q.data !== undefined,
    any: flags !== 0n,
    isPaused: (area: PauseArea) => (flags & PAUSE_AREAS[area]) !== 0n,
    refetch: q.refetch,
  };
}
