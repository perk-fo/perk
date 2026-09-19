"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, erc20Abi, type Abi, type Address, type Hex } from "viem";
import { getDeployment, NATIVE_QUOTE, type Deployment } from "./deployments";
import { txActivity, type TxPhase } from "./tx-activity";

/** Deployment for the currently connected chain (defaults to testnet when disconnected). */
export function useDeployment(): { chainId: number; deployment: Deployment | null } {
  const walletChainId = useChainId();
  const chainId = walletChainId === 196 ? 196 : 1952;
  return { chainId, deployment: getDeployment(chainId) };
}

/** What a button passes to write(): one contract call. (Typed loosely on purpose: callers use many ABIs.) */
export interface WriteParams {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface WriteOptions {
  /** Name shown in the progress toast; defaults to the i18n key `tx.fn.<functionName>`. */
  label?: { key: string; vars?: Record<string, string | number> };
  /**
   * Inspect the simulated return value and return an i18n key to stop the send (e.g. a claim that would pay 0 —
   * those do not revert on-chain, they just burn the user's gas). Return null to go ahead.
   */
  check?: (result: unknown) => string | null;
}

/** A send stopped before the wallet opened. `key` is an i18n key rendered by decodeErrorMessage. */
export class PrecheckError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = "PrecheckError";
  }
}

export interface Tx {
  write: (params: WriteParams, opts?: WriteOptions) => void;
  /** Where the write is: see lib/tx-activity. Buttons render their label from it. */
  phase: TxPhase;
  hash: `0x${string}` | undefined;
  isPending: boolean;
  isConfirming: boolean;
  isSuccess: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * One write flow: useWriteContract + useWaitForTransactionReceipt. Before the wallet opens, every write:
 *   1. is pinned to the app's chain: the wallet's current chain is read fresh from the provider (cached wagmi state
 *      can be stale), switched if needed, and `chainId` is passed so wagmi refuses to send on any other network;
 *   2. is simulated (eth_call from the user's address, through the public RPC). A revert stops it with the contract's
 *      decoded reason, so the user never pays gas for a transaction that cannot succeed; `opts.check` can also stop
 *      it on the simulated result. If the simulation itself cannot run (RPC down), the send goes ahead and the
 *      wallet's own estimate is the fallback.
 */
export function useTx(): Tx {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const isConfirming = receipt.isLoading;
  // a mined transaction can still have reverted: that is a failure, not a success
  const reverted = receipt.data?.status === "reverted";
  const isSuccess = receipt.isSuccess && !reverted;
  const [activityId, setActivityId] = useState<number | null>(null);
  const { connector, address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<Error | null>(null);

  const write = useCallback<Tx["write"]>(
    (params, opts) => {
      setPrepError(null);
      reset();
      setActivityId(txActivity.start(opts?.label ?? { key: `tx.fn.${params.functionName}` }));
      void (async () => {
        setPreparing(true);
        try {
          const actual = connector ? await connector.getChainId() : chainId;
          if (actual !== chainId) await switchChainAsync({ chainId });
          if (client && address) {
            let result: unknown;
            try {
              ({ result } = await client.simulateContract({ ...(params as object), account: address } as Parameters<
                typeof client.simulateContract
              >[0]));
            } catch (e) {
              if (isRevert(e)) throw Object.assign(e as Error, { precheck: true }); // shown as "pre-check failed"
              result = undefined; // simulation unavailable: let the wallet estimate
            }
            const blocked = result !== undefined ? opts?.check?.(result) : null;
            if (blocked) throw new PrecheckError(blocked);
          }
        } catch (e) {
          setPrepError(e as Error);
          return;
        } finally {
          setPreparing(false);
        }
        (writeContract as (p: unknown) => void)({ ...params, chainId });
      })();
    },
    [connector, chainId, switchChainAsync, writeContract, client, address, reset],
  );

  const failure: Error | null =
    prepError ?? error ?? receipt.error ?? (reverted ? new Error("reverted") : null);
  const phase: TxPhase =
    activityId === null
      ? "idle"
      : failure
        ? "error"
        : isSuccess
          ? "success"
          : hash
            ? "confirming"
            : isPending
              ? "signing"
              : preparing
                ? "preparing"
                : "idle";
  useEffect(() => {
    if (activityId === null) return;
    if (phase === "idle") return;
    txActivity.update(activityId, { phase, hash, error: failure ?? undefined });
  }, [activityId, phase, hash, failure]);

  return {
    write,
    phase,
    hash,
    isPending: isPending || preparing,
    isConfirming,
    isSuccess,
    error: failure,
    reset: () => {
      setPrepError(null);
      setActivityId(null);
      reset();
    },
  };
}

/** Simulation outcomes that mean "this send cannot succeed": a contract revert, or not enough native balance. */
function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof InsufficientFundsError);
}

export interface QuoteMeta {
  address: Address;
  isNative: boolean;
  symbol: string;
  decimals: number;
}

/** Symbol/decimals for a quote currency. Native OKB is 18 decimals; ERC-20 reads `decimals()` on-chain. */
export function useQuoteMeta(quote: Address | undefined, xdogToken: Address | undefined): QuoteMeta | undefined {
  const isNative = !quote || quote.toLowerCase() === NATIVE_QUOTE.toLowerCase();
  const { data: decimals } = useReadContract({
    address: quote,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: !isNative },
  });
  if (isNative) {
    return { address: NATIVE_QUOTE, isNative: true, symbol: "OKB", decimals: 18 };
  }
  const symbol = xdogToken && quote.toLowerCase() === xdogToken.toLowerCase() ? "XDOG" : undefined;
  if (decimals === undefined) return undefined;
  return {
    address: quote,
    isNative: false,
    symbol: symbol ?? "ERC20",
    decimals: Number(decimals),
  };
}

/** Current unix time in seconds, ticking every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Connected address or undefined. */
export function useAccountAddress(): Address | undefined {
  const { address } = useAccount();
  return address;
}

/** True while the document is visible; drives the 12s live-refresh pause. */
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

