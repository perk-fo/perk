"use client";

import { useEffect, useSyncExternalStore } from "react";
import { txActivity, type TxActivity } from "@/lib/tx-activity";
import { explorerTxUrl, DEFAULT_CHAIN } from "@/lib/chains";
import { decodeErrorMessage, isUserRejection } from "@/lib/errors";
import { shortHash } from "@/lib/format";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/provider";

const EMPTY: TxActivity[] = [];
const STEPS = ["preparing", "signing", "confirming", "success"] as const;

/**
 * Bottom-right stack of in-flight transactions, fed by every useTx write: what is happening (pre-check, waiting for
 * the wallet, confirming on chain), a step bar, the explorer link once there is a hash, then a check or the reason
 * it failed. Survives navigation because the store is module-level.
 */
export function TxToasts() {
  const { t } = useT();
  const items = useSyncExternalStore(txActivity.subscribe, txActivity.snapshot, () => EMPTY);

  useEffect(() => {
    const id = setInterval(() => txActivity.prune(), 1000);
    return () => clearInterval(id);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      {items.map((a) => {
        const step = STEPS.indexOf(a.phase as (typeof STEPS)[number]);
        const done = a.phase === "success";
        const failed = a.phase === "error";
        // cancelling in the wallet is a choice, not a failure: grey, not red
        const cancelled = failed && isUserRejection(a.error);
        return (
          <div key={a.id} className="panel pointer-events-auto fade-up p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 ${done ? "text-verdigris" : cancelled ? "text-bone/50" : failed ? "text-rose" : "text-flare"}`}>
                {done ? "✓" : failed ? "✕" : <Spinner size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-bone">{t(a.label.key, a.label.vars)}</p>
                <p className={`mt-0.5 text-[12px] ${failed && !cancelled ? "text-rose" : "text-bone/60"}`}>
                  {failed ? decodeErrorMessage(a.error, t) : t(`tx.phase.${a.phase}`)}
                </p>
                {a.hash && (
                  <a
                    href={explorerTxUrl(DEFAULT_CHAIN.id, a.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="num mt-1 inline-block text-[11px] text-bone/50 underline decoration-dotted underline-offset-4 hover:text-flare"
                  >
                    {shortHash(a.hash)} ↗
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => txActivity.dismiss(a.id)}
                className="text-bone/35 hover:text-bone"
                aria-label={t("tx.dismiss")}
              >
                ×
              </button>
            </div>
            {!failed && (
              <div className="mt-3 grid grid-cols-4 gap-1" aria-hidden>
                {STEPS.map((s, i) => (
                  <span
                    key={s}
                    className={`h-1 rounded-full ${
                      i < step || done ? "bg-verdigris/80" : i === step ? "tx-step-active bg-flare" : "bg-bone/10"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
