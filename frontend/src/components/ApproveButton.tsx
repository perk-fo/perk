"use client";

import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { useTx } from "@/lib/hooks";
import { TxStatus } from "./TxStatus";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n/provider";

/** Renders an approve button for `spender` when the current allowance is below `needed`; otherwise nothing. */
export function ApproveButton({
  token,
  spender,
  needed,
  symbol,
}: {
  token: Address;
  spender: Address;
  needed: bigint;
  symbol: string;
}) {
  const { address } = useAccount();
  const { t } = useT();
  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, spender] : undefined,
    query: { enabled: !!address },
  });
  const tx = useTx();
  if (allowance.data !== undefined && allowance.data >= needed) return null;
  return (
    <div>
      <Button
        variant="ghost"
        tx={tx}
        disabled={tx.isPending || tx.isConfirming || needed === 0n}
        onClick={() => tx.write({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, needed] })}
      >
        {t("tx.approve", { symbol })}
      </Button>
      <TxStatus tx={tx} successText={t("tx.approveSuccess")} />
    </div>
  );
}
