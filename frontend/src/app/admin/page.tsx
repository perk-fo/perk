"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReadContract, useReadContracts } from "wagmi";
import { isAddress, zeroAddress, type Address } from "viem";
import { graduationManagerAbi, launchFactoryAbi, lpGrantVaultAbi } from "@/generated/abis";
import { api } from "@/lib/api";
import type { LaunchSummary } from "@/lib/api-types";
import { useLaunchList } from "@/lib/api-hooks";
import { useCoreAdmin } from "@/lib/admin";
import { useDeployment, useNow, useTabVisible, useTx } from "@/lib/hooks";
import { PAUSE_ALL, PAUSE_AREAS, PAUSE_ORDER, usePauseFlags } from "@/lib/pause";
import { fmtCountdown, fmtTime, formatAmount, shortAddress } from "@/lib/format";
import { HashSeal } from "@/components/art/HashSeal";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { useT } from "@/i18n/provider";

/**
 * Core admin: the protocol controls held by the contracts' owner (emergency pause, grant publisher, cancelling a
 * grant list under review, rescuing a stuck graduation). Anyone can open the page and see the state; only the
 * owner's wallet gets working buttons, and the contracts reject anyone else regardless.
 */
export default function AdminPage() {
  const { t } = useT();
  const { deployment } = useDeployment();
  const admin = useCoreAdmin();

  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("home.network.body")}
      </Notice>
    );
  }

  return (
    <div className="space-y-6 pt-6">
      <header>
        <h1 className="font-display text-3xl sm:text-4xl">{t("admin.title")}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("admin.sub")}</p>
      </header>
      {!admin.isLoading && !admin.isCoreAdmin && admin.owner && (
        <Notice tone="amber">{t("admin.notOwner", { owner: shortAddress(admin.owner) })}</Notice>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <PausePanel factory={deployment.factory} canWrite={admin.isCoreAdmin} />
        <PublisherPanel vault={deployment.lpGrantVault} canWrite={admin.ownsVault} />
      </div>
      <ReviewPanel vault={deployment.lpGrantVault} canWrite={admin.ownsVault} />
      <RescuePanel graduation={deployment.graduationManager} canWrite={admin.ownsGraduation} />
      <RolesPanel owner={admin.owner} vault={deployment.lpGrantVault} />
    </div>
  );
}

// ------------------------------------------------------------------ emergency pause

function PausePanel({ factory, canWrite }: { factory: Address; canWrite: boolean }) {
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

// ------------------------------------------------------------------ grant publisher

function PublisherPanel({ vault, canWrite }: { vault: Address; canWrite: boolean }) {
  const { t } = useT();
  const tx = useTx();
  const [input, setInput] = useState("");
  const current = useReadContract({ address: vault, abi: lpGrantVaultAbi, functionName: "publisher" });
  const publisher = current.data as Address | undefined;
  const unset = !publisher || publisher === zeroAddress;
  const valid = isAddress(input.trim());
  const busy = tx.isPending || tx.isConfirming;
  const appoint = (addr: Address) =>
    tx.write({ address: vault, abi: lpGrantVaultAbi, functionName: "setPublisher", args: [addr] });
  return (
    <Panel title={t("admin.publisher.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.publisher.body")}</p>
      <div className="mt-4 flex items-baseline justify-between gap-3 border-y border-line py-2.5 text-sm">
        <span className="label">{t("admin.publisher.current")}</span>
        {unset ? (
          <span className="text-subtle">{t("admin.publisher.none")}</span>
        ) : (
          <span className="mono break-all text-[13px]">{publisher}</span>
        )}
      </div>
      <label className="mt-4 block">
        <span className="label">{t("admin.publisher.new")}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className="mono mt-1.5 block w-full rounded-full border border-line-strong bg-ink/50 px-4 py-2 text-[13px] outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-flare focus:ring-2 focus:ring-flare/20"
        />
        {input.trim() !== "" && !valid && <span className="mt-1 block text-xs text-rose">{t("admin.publisher.invalid")}</span>}
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button tx={tx} disabled={!canWrite || busy || !valid} onClick={() => appoint(input.trim() as Address)}>
          {t("admin.publisher.set")}
        </Button>
        <Button variant="ghost" disabled={!canWrite || busy || unset} onClick={() => appoint(zeroAddress)}>
          {t("admin.publisher.revoke")}
        </Button>
      </div>
      <TxStatus tx={tx} />
    </Panel>
  );
}

// ------------------------------------------------------------------ grant lists under review

function ReviewPanel({ vault, canWrite }: { vault: Address; canWrite: boolean }) {
  const { t } = useT();
  const visible = useTabVisible();
  const campaigns = useQuery({
    queryKey: ["api", "grants", "2"],
    queryFn: () => api.grants("2"),
    refetchInterval: visible ? 15_000 : false,
  });
  const launches = useLaunchList({ limit: 100 });
  const byMeme = new Map((launches.data?.launches ?? []).map((l) => [l.meme.toLowerCase(), l]));
  const list = campaigns.data?.campaigns ?? [];
  return (
    <Panel title={t("admin.review.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.review.body")}</p>
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{t("admin.review.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {list.map((c) => (
            <ReviewRow
              key={c.meme}
              vault={vault}
              meme={c.meme}
              launch={byMeme.get(c.meme.toLowerCase())}
              activatableAt={c.activatableAt}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ReviewRow({
  vault,
  meme,
  launch,
  activatableAt,
  canWrite,
}: {
  vault: Address;
  meme: Address;
  launch: LaunchSummary | undefined;
  activatableAt: number | null;
  canWrite: boolean;
}) {
  const { t, locale } = useT();
  const tx = useTx();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <TokenCell meme={meme} launch={launch} href={`/grant/${meme}`} />
      <span className="text-[13px] text-muted">
        {activatableAt ? t("admin.review.activatesAt", { time: fmtTime(activatableAt, locale) }) : "—"}
      </span>
      <span className="w-40">
        <Button
          variant="danger"
          tx={tx}
          disabled={!canWrite || tx.isPending || tx.isConfirming || tx.isSuccess}
          onClick={() => tx.write({ address: vault, abi: lpGrantVaultAbi, functionName: "cancelRoot", args: [meme] })}
          className="py-1.5 text-[13px]"
        >
          {t("admin.review.cancel")}
        </Button>
      </span>
      <div className="basis-full">
        <TxStatus tx={tx} />
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ stuck graduations and refunds

function RescuePanel({ graduation, canWrite }: { graduation: Address; canWrite: boolean }) {
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
                <TokenCell meme={l.meme} launch={l} href={`/meme/${l.meme}`} />
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
      <TokenCell meme={launch.meme} launch={launch} href={`/meme/${launch.meme}`} />
      <span className="text-[13px] text-muted">{note}</span>
      <span className="w-40">{actions}</span>
      <div className="basis-full">
        <TxStatus tx={tx} />
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ roles

function RolesPanel({ owner, vault }: { owner: Address | undefined; vault: Address }) {
  const { t } = useT();
  const publisher = useReadContract({ address: vault, abi: lpGrantVaultAbi, functionName: "publisher" });
  const pub = publisher.data as Address | undefined;
  return (
    <Panel title={t("admin.roles.title")}>
      <dl className="divide-y divide-line border-y border-line text-sm [&>div]:flex [&>div]:flex-wrap [&>div]:justify-between [&>div]:gap-3 [&>div]:py-2.5">
        <div>
          <dt className="label">{t("admin.roles.owner")}</dt>
          <dd className="mono break-all text-[13px]">{owner ?? "—"}</dd>
        </div>
        <div>
          <dt className="label">{t("admin.publisher.title")}</dt>
          <dd className="mono break-all text-[13px]">
            {pub && pub !== zeroAddress ? pub : <span className="font-sans text-subtle">{t("admin.publisher.none")}</span>}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[13px] text-subtle">{t("admin.roles.later")}</p>
    </Panel>
  );
}

function TokenCell({ meme, launch, href }: { meme: Address; launch: LaunchSummary | undefined; href: string }) {
  return (
    <Link href={href} className="flex min-w-0 items-center gap-3 hover:text-flare">
      {launch && <HashSeal hash={launch.configHash} moduleBitmap={BigInt(launch.moduleBitmap)} size={28} className="shrink-0" />}
      <span className="min-w-0">
        <span className="block truncate text-sm">{launch?.name ?? shortAddress(meme)}</span>
        <span className="num block text-xs text-subtle">{launch?.symbol ?? ""}</span>
      </span>
    </Link>
  );
}
