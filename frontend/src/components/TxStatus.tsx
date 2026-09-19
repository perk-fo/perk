"use client";

import { useChainId } from "wagmi";
import { explorerTxUrl } from "@/lib/chains";
import { decodeErrorMessage } from "@/lib/errors";
import type { Tx } from "@/lib/hooks";
import { shortHash } from "@/lib/format";
import { Notice } from "@/components/ui/Notice";
import { useT } from "@/i18n/provider";

/** Renders the status of one write flow: pending / confirming / success link / decoded error. */
export function TxStatus({ tx, successText }: { tx: Tx; successText?: string }) {
  const chainId = useChainId();
  const { t } = useT();
  if (tx.error) {
    return (
      <Notice tone="rose" className="mt-3 break-all">
        {decodeErrorMessage(tx.error, t)}
      </Notice>
    );
  }
  if (!tx.hash) return null;
  return (
    <p className="num mt-3 text-[13px]">
      {tx.isConfirming && <span className="text-bone/60">{t("tx.confirming")} </span>}
      {tx.isSuccess && <span className="text-verdigris">{successText ?? t("tx.confirmed")} </span>}
      {!tx.isConfirming && !tx.isSuccess && <span className="text-bone/60">{t("tx.submitted")} </span>}
      <a
        className="text-flare underline decoration-flare/40 hover:decoration-flare"
        href={explorerTxUrl(chainId, tx.hash)}
        target="_blank"
        rel="noreferrer"
      >
        {shortHash(tx.hash)}
      </a>
    </p>
  );
}
