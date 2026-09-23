"use client";

import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { graduationManagerAbi, launchFactoryAbi } from "@/generated/abis";
import type { LaunchSummary } from "@/lib/api-types";
import { useLaunchList } from "@/lib/api-hooks";
import { useNow, useTx } from "@/lib/hooks";
import { PAUSE_ALL, PAUSE_AREAS, PAUSE_ORDER, usePauseFlags } from "@/lib/pause";
import { fmtCountdown, fmtTime, formatAmount } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { TokenCell } from "@/components/admin/AdminKit";
import { useT } from "@/i18n/provider";

/** Emergency pause: entry points only (PAUSE_* bits on the factory); exits can never be paused. */
export function PausePanel({ factory, canWrite }: { factory: Address; canWrite: boolean }) {
  const { t } = useT();
  const pause = usePauseFlags();
  const tx = useTx();
  const busy = tx.isPending || tx.isConfirming;
  const set = (flags: bigint) =>
    tx.write({ address: factory, abi: launchFactoryAbi, functionName: "setPaused", args: [flags] });
  return (
    <Panel title={t("admin.pause.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.pause.body")}</p>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {PAUSE_ORDER.map((area) => {
          const paused = pause.isPaused(area);
          return (
            <li key={area} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-sm">{t(`admin.pause.area.${area}`)}</span>
              <span className="flex items-center gap-2">
                <Pill tone={paused ? "amber" : "verdigris"}>
                  {paused ? t("admin.pause.paused") : t("admin.pause.running")}
                </Pill>
                <button
                  type="button"
                  disabled={!canWrite || busy || !pause.loaded}
                  onClick={() => set(pause.flags ^ PAUSE_AREAS[area])}
                  className="btn-ghost h-7 px-3 text-xs"
                >
                  {paused ? t("admin.pause.resume") : t("admin.pause.pause")}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="danger" tx={tx} disabled={!canWrite || busy || pause.flags === PAUSE_ALL} onClick={() => set(PAUSE_ALL)}>
          {t("admin.pause.all")}
        </Button>
        <Button variant="ghost" disabled={!canWrite || busy || pause.flags === 0n} onClick={() => set(0n)}>
          {t("admin.pause.none")}
        </Button>
      </div>
      <TxStatus tx={tx} />
    </Panel>
  );
}

/** Launches stuck before liquidity reached their pool (propose, cancel or execute a rescue), and refunds under way. */
export function RescuePanel({ graduation, canWrite }: { graduation: Address; canWrite: boolean }) {
  const { t } = useT();
  const pending = useLaunchList({ status: "2", limit: 100 });
  const refunding = useLaunchList({ status: "4", limit: 100 });
  const delay = useReadContract({ address: graduation, abi: graduationManagerAbi, functionName: "rescueDelay" });
  const delayText = delay.data !== undefined ? fmtCountdown(Number(delay.data), t) : "—";
  const pendingList = pending.data?.launches ?? [];
  const refundingList = refunding.data?.launches ?? [];
  const states = useReadContracts({
    contracts: [...pendingList, ...refundingList].map((l) => ({
      address: graduation,
      abi: graduationManagerAbi,
      functionName: "graduationOf" as const,
      args: [l.meme] as const,
    })),
    query: { enabled: pendingList.length + refundingList.length > 0, refetchInterval: 15_000 },
  });
  const stateOf = (i: number) =>
    states.data?.[i]?.result as { stage: number; rescueExecutableAt: bigint; quoteHeld: bigint } | undefined;

  return (
    <Panel title={t("admin.rescue.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.rescue.body", { delay: delayText })}</p>
      {pendingList.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{t("admin.rescue.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {pendingList.map((l, i) => (
            <RescueRow key={l.meme} graduation={graduation} launch={l} state={stateOf(i)} canWrite={canWrite} />
          ))}
        </ul>
      )}
      <h3 className="label mt-8">{t("admin.refunding.title")}</h3>
      {refundingList.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">{t("admin.refunding.empty")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {refundingList.map((l, j) => {
            const s = stateOf(pendingList.length + j);
            return (
              <li key={l.meme} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <TokenCell meme={l.meme} launch={l} />
                <RefundLeft amount={s?.quoteHeld} launch={l} />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function RefundLeft({ amount, launch }: { amount: bigint | undefined; launch: LaunchSummary }) {
  const { t, locale } = useT();
  return (
    <span className="num text-[13px] text-muted">
      {amount === undefined
        ? "—"
        : t("admin.refunding.left", {
            amount: formatAmount(amount, launch.quoteDecimals, { locale, maxFrac: 6 }),
            symbol: launch.quoteSymbol,
          })}
    </span>
  );
}

function RescueRow({
  graduation,
  launch,
  state,
  canWrite,
}: {
  graduation: Address;
  launch: LaunchSummary;
  state: { stage: number; rescueExecutableAt: bigint } | undefined;
  canWrite: boolean;
}) {
  const { t, locale } = useT();
  const now = useNow();
  const tx = useTx();
  const busy = tx.isPending || tx.isConfirming;
  const stage = state ? Number(state.stage) : undefined;
  const at = state ? Number(state.rescueExecutableAt) : 0;
  const rescuable = stage !== undefined && stage <= 2; // NONE, FUNDED, POOL_INITIALIZED
  const write = (functionName: "proposeRescue" | "cancelRescue" | "executeRescue") =>
    tx.write({ address: graduation, abi: graduationManagerAbi, functionName, args: [launch.meme] });

  let note: string;
  let actions: React.ReactNode = null;
  if (stage === undefined) note = "—";
  else if (!rescuable) note = t("admin.rescue.live");
  else if (at === 0) {
    note = t("admin.rescue.stage", { stage: t(`admin.rescue.stage.${stage}`) });
    actions = (
      <Button variant="ghost" tx={tx} disabled={!canWrite || busy} onClick={() => write("proposeRescue")} className="py-1.5 text-[13px]">
        {t("admin.rescue.propose")}
      </Button>
    );
  } else if (now < at) {
    note = t("admin.rescue.waiting", { time: fmtTime(at, locale) });
    actions = (
      <Button variant="ghost" tx={tx} disabled={!canWrite || busy} onClick={() => write("cancelRescue")} className="py-1.5 text-[13px]">
        {t("admin.rescue.cancel")}
      </Button>
    );
  } else {
    note = t("admin.rescue.ready");
    // executing is open to anyone once the delay is over
    actions = (
      <Button variant="danger" tx={tx} disabled={busy} onClick={() => write("executeRescue")} className="py-1.5 text-[13px]">
        {t("admin.rescue.execute")}
      </Button>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <TokenCell meme={launch.meme} launch={launch} />
      <span className="text-[13px] text-muted">{note}</span>
      <span className="w-40">{actions}</span>
      <div className="basis-full">
        <TxStatus tx={tx} />
      </div>
    </li>
  );
}
