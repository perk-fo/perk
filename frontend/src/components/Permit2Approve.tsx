"use client";

import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi, maxUint160, maxUint256, type Address } from "viem";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { useTx } from "@/lib/hooks";
import { useT } from "@/i18n/provider";

const PERMIT2_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const THIRTY_DAYS = 30 * 24 * 60 * 60;

/**
 * The v4 PositionManager does not pull tokens with a plain ERC-20 allowance: it settles through Permit2. Spending a
 * token therefore takes two approvals, each needed only once — the token to Permit2, then Permit2 to the
 * PositionManager. This renders whichever step is still outstanding and nothing once both are in place.
 * `onReady` reports whether the spender can already pull `needed`.
 */
export function Permit2Approve({
  token,
  permit2,
  spender,
  needed,
  symbol,
}: {
  token: Address;
  permit2: Address;
  spender: Address;
  needed: bigint;
  symbol: string;
}) {
  const { t } = useT();
  const { address } = useAccount();
  const tx = useTx();
  const reads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "allowance", args: address ? [address, permit2] : undefined },
      { address: permit2, abi: PERMIT2_ABI, functionName: "allowance", args: address ? [address, token, spender] : undefined },
    ],
    query: { enabled: !!address && needed > 0n },
  });
  if (!address || needed === 0n || !reads.data) return null;

  const erc20Allowance = (reads.data[0]?.result as bigint | undefined) ?? 0n;
  const p2 = reads.data[1]?.result as readonly [bigint, number, number] | undefined;
  const p2Live = !!p2 && p2[0] >= needed && p2[1] > Math.floor(Date.now() / 1000);
  const step = erc20Allowance < needed ? 1 : !p2Live ? 2 : 0;
  if (step === 0) return null;

  const busy = tx.isPending || tx.isConfirming;
  return (
    <span className="inline-flex flex-col">
      <Button
        variant="ghost"
        tx={tx}
        disabled={busy}
        onClick={() =>
          step === 1
            ? tx.write({ address: token, abi: erc20Abi, functionName: "approve", args: [permit2, maxUint256] })
            : tx.write({
                address: permit2,
                abi: PERMIT2_ABI,
                functionName: "approve",
                args: [token, spender, maxUint160, Math.floor(Date.now() / 1000) + THIRTY_DAYS],
              })
        }
      >
        {t("pool.lp.approveStep", { symbol, n: step, of: 2 })}
      </Button>
      <TxStatus tx={tx} />
    </span>
  );
}

/** Whether `spender` can pull `needed` of `token` through Permit2 right now. */
export function usePermit2Ready(token: Address | undefined, permit2: Address | undefined, spender: Address | undefined, needed: bigint) {
  const { address } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "allowance", args: address && permit2 ? [address, permit2] : undefined },
      { address: permit2, abi: PERMIT2_ABI, functionName: "allowance", args: address && token && spender ? [address, token, spender] : undefined },
    ],
    query: { enabled: !!address && !!token && !!permit2 && !!spender && needed > 0n },
  });
  if (needed === 0n) return true;
  const erc20Allowance = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const p2 = reads.data?.[1]?.result as readonly [bigint, number, number] | undefined;
  return erc20Allowance >= needed && !!p2 && p2[0] >= needed && p2[1] > Math.floor(Date.now() / 1000);
}
