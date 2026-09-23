"use client";

import { useAccount, useBalance, useReadContracts } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { graduationManagerAbi } from "@/generated/abis";
import { useTabVisible, useTx } from "@/lib/hooks";
import { formatAmount } from "@/lib/format";
import type { QuoteInfo } from "@/lib/quotes";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { useT } from "@/i18n/provider";

/**
 * A rescued launch (status REFUNDING): the holder hands in their tokens and receives their pro-rata share of the
 * quote the launch raised. Two steps at most: approve the graduation manager, then redeem everything.
 */
export function RefundPanel({
  meme,
  memeSymbol,
  memeDecimals,
  quoteMeta,
  graduationManager,
}: {
  meme: Address;
  memeSymbol: string;
  memeDecimals: number;
  quoteMeta: QuoteInfo;
  graduationManager: Address;
}) {
  const { t, locale } = useT();
  const { address } = useAccount();
  const visible = useTabVisible();
  const approveTx = useTx();
  const redeemTx = useTx();

  const balance = useBalance({
    address,
    token: meme,
    query: { enabled: !!address, refetchInterval: visible ? 12_000 : false },
  });
  const held = balance.data?.value ?? 0n;
  const reads = useReadContracts({
    contracts: [
      { address: graduationManager, abi: graduationManagerAbi, functionName: "graduationOf", args: [meme] },
      { address: graduationManager, abi: graduationManagerAbi, functionName: "previewRedeem", args: [meme, held] },
      {
        address: meme,
        abi: erc20Abi,
        functionName: "allowance",
        args: address ? [address, graduationManager] : undefined,
      },
    ],
    query: { refetchInterval: visible ? 12_000 : false },
  });
  const left = (reads.data?.[0]?.result as { quoteHeld?: bigint } | undefined)?.quoteHeld;
  const youGet = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;
  const allowance = (reads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const needsApprove = held > 0n && allowance < held;
  const busy = approveTx.isPending || approveTx.isConfirming || redeemTx.isPending || redeemTx.isConfirming;
  const fmtQuote = (v: bigint | undefined) =>
    v === undefined ? "—" : `${formatAmount(v, quoteMeta.decimals, { locale, maxFrac: 6 })} ${quoteMeta.symbol}`;

  return (
    <Panel title={t("meme.refund.title")} className="lg:sticky lg:top-20">
      <p className="text-sm leading-relaxed text-muted">{t("meme.refund.body")}</p>
      <dl className="mt-4 divide-y divide-line border-y border-line text-sm [&>div]:flex [&>div]:justify-between [&>div]:gap-3 [&>div]:py-2">
        <div>
          <dt className="label">{t("meme.refund.holding")}</dt>
          <dd className="num">
            {formatAmount(held, memeDecimals, { locale, maxFrac: 2 })} {memeSymbol}
          </dd>
        </div>
        <div>
          <dt className="label">{t("meme.refund.youGet")}</dt>
          <dd className="num font-medium text-verdigris">{fmtQuote(youGet)}</dd>
        </div>
        <div>
          <dt className="label">{t("meme.refund.pool")}</dt>
          <dd className="num">{fmtQuote(left)}</dd>
        </div>
      </dl>
      <div className="mt-4">
        {!address ? null : held === 0n ? (
          <p className="text-sm text-subtle">{redeemTx.isSuccess ? t("meme.refund.done") : t("meme.refund.none")}</p>
        ) : needsApprove ? (
          <>
            <Button
              tx={approveTx}
              disabled={busy}
              onClick={() =>
                approveTx.write({ address: meme, abi: erc20Abi, functionName: "approve", args: [graduationManager, held] })
              }
            >
              {t("tx.approve", { symbol: memeSymbol })}
            </Button>
            <TxStatus tx={approveTx} successText={t("tx.approveSuccess")} />
          </>
        ) : (
          <>
            <Button
              tx={redeemTx}
              disabled={busy || youGet === 0n}
              onClick={() =>
                redeemTx.write({
                  address: graduationManager,
                  abi: graduationManagerAbi,
                  functionName: "redeem",
                  args: [meme, held],
                })
              }
            >
              {t("meme.refund.cta")}
            </Button>
            <TxStatus tx={redeemTx} successText={t("meme.refund.done")} />
          </>
        )}
      </div>
    </Panel>
  );
}
