"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { keccak256, type Address } from "viem";
import { referralRegistryAbi } from "@/generated/abis";
import { useDeployment, useTx } from "@/lib/hooks";
import { useInvite } from "@/lib/use-referral";
import { forgetInviter } from "@/lib/referral";
import { HashSeal } from "@/components/art/HashSeal";
import { Sparkle } from "@/components/art/Sparkle";
import { Spinner } from "@/components/ui/Spinner";
import { InviteLinkRow } from "@/components/InviteLinkRow";
import { TxStatus } from "@/components/TxStatus";
import { formatNumber, shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The LP Grant pass — opt-in presented as what it is: the ticket to LP Grant. Anyone can provide normal liquidity;
 * opting in (ReferralRegistry.optIn, once per address, global) is what makes a wallet count in graduation snapshots
 * of OKB-paired launches, i.e. eligible for granted memes. The inviter is printed on the pass and bound only from an
 * invite link; a newcomer with an invite claims with one action (bind, then opt in).
 * TODO(contract): ReferralRegistry.optInWithInviter makes that a single transaction.
 */
export function PerkPass() {
  const { t, locale } = useT();
  const { address, status: walletStatus } = useAccount();
  const { deployment } = useDeployment();
  const invite = useInvite();
  const reads = useReadContracts({
    contracts: [
      { address: deployment?.referralRegistry, abi: referralRegistryAbi, functionName: "optInBlock", args: address ? [address] : undefined },
      { address: deployment?.referralRegistry, abi: referralRegistryAbi, functionName: "inviterOf", args: address ? [address] : undefined },
    ],
    query: { enabled: !!deployment && !!address, refetchInterval: 15_000 },
  });
  const optInBlock = reads.data?.[0]?.result as bigint | undefined;
  const inviter = reads.data?.[1]?.result as Address | undefined;
  const loaded = optInBlock !== undefined && inviter !== undefined;
  const issued = !!optInBlock && optInBlock > 0n;
  const hasInviter = !!inviter && inviter !== ZERO;
  const invitedBy = hasInviter ? inviter : invite.canBind ? invite.pending : null;

  const bindTx = useTx();
  const optInTx = useTx();
  const [chain, setChain] = useState(false);
  /** The current claim was started as bind + opt-in; drives the "step n/2" label until the opt-in settles. */
  const [twoStepClaim, setTwoStepClaim] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  const refetch = reads.refetch;
  const inviteRefetch = invite.refetch;
  useEffect(() => {
    if (!bindTx.isSuccess) return;
    forgetInviter();
    inviteRefetch();
    void refetch();
    if (chain && deployment) {
      setChain(false);
      optInTx.write({ address: deployment.referralRegistry, abi: referralRegistryAbi, functionName: "optIn" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindTx.isSuccess]);
  useEffect(() => {
    if (!optInTx.isSuccess) return;
    setTwoStepClaim(false);
    setCelebrate(true);
    void refetch();
    const id = setTimeout(() => setCelebrate(false), 2400);
    return () => clearTimeout(id);
  }, [optInTx.isSuccess, refetch]);

  useEffect(() => {
    if (bindTx.phase === "error" || optInTx.phase === "error") {
      setChain(false);
      setTwoStepClaim(false);
    }
  }, [bindTx.phase, optInTx.phase]);

  if (!deployment) return null;
  // Never show a state we are not sure of: while the wallet is reconnecting, or connected but the pass has not been
  // read yet, show a loading ticket — not "unclaimed" first and "issued" a moment later.
  const resolving = walletStatus === "reconnecting" || walletStatus === "connecting" || (!!address && !loaded);
  if (resolving) return <PassLoading label={t("pass.loading")} />;
  const inFlight = (tx: typeof bindTx) => tx.phase === "preparing" || tx.phase === "signing" || tx.phase === "confirming";
  const busy = inFlight(bindTx) || inFlight(optInTx) || chain;
  const active = inFlight(bindTx) ? bindTx : optInTx;
  // bind + opt-in: say which transaction the user is on
  const step = !twoStepClaim ? "" : t("pass.step", { n: active === bindTx ? 1 : 2, of: 2 });
  const busyLabel = inFlight(active) ? `${step}${t(`tx.phase.${active.phase}`)}` : t("tx.phase.preparing");
  const claim = () => {
    if (invite.canBind && !hasInviter) {
      setChain(true);
      setTwoStepClaim(true);
      bindTx.write({ address: deployment.referralRegistry, abi: referralRegistryAbi, functionName: "bindInviter", args: [invite.pending!] });
    } else {
      optInTx.write({ address: deployment.referralRegistry, abi: referralRegistryAbi, functionName: "optIn" });
    }
  };
  const bindOnly = () =>
    bindTx.write({ address: deployment.referralRegistry, abi: referralRegistryAbi, functionName: "bindInviter", args: [invite.pending!] });

  // the stub's seal is generated from the holder's address: every pass is one of a kind
  const sealHash = address ? keccak256(address) : undefined;

  return (
    <section className={`pass ${issued ? "pass-issued" : ""} ${celebrate ? "pass-celebrate" : ""}`} aria-label={t("pass.aria")}>
      <div className="pass-body">
        <div className="min-w-0 flex-1 p-6 sm:p-8">
          <p className="label-en flex items-center gap-2 text-flare">
            <Sparkle size={9} tone="flare" />
            {t("pass.kicker")}
          </p>
          <h2 className="mt-3 font-display text-3xl leading-[1.05] sm:text-[40px]">
            {issued ? t("pass.titleIssued") : t("pass.title")}
          </h2>

          <ul className="mt-5 grid gap-2.5 sm:grid-cols-3">
            {(["snapshot", "grant", "invite"] as const).map((k) => (
              <li key={k} className="pass-perk">
                <span className="num text-[11px] text-flare">{t(`pass.perk.${k}.tag`)}</span>
                <span className="mt-1 block text-[13px] leading-snug text-bone/85">{t(`pass.perk.${k}`)}</span>
              </li>
            ))}
          </ul>

          {invitedBy && (
            <p className="pass-ribbon mt-5">
              <Sparkle size={8} tone="amber" />
              {t(hasInviter ? "pass.invitedBy" : "pass.inviteWaiting", { who: shortAddress(invitedBy) })}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!address ? (
              <p className="text-sm text-bone/60">{t("pass.connect")}</p>
            ) : !loaded ? (
              <span className="text-sm text-bone/40">…</span>
            ) : !issued ? (
              <button type="button" onClick={claim} disabled={busy} className="btn-primary pass-cta px-7 py-3 text-[15px]">
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size={15} />
                    {busyLabel}
                  </span>
                ) : invite.canBind && !hasInviter ? (
                  t("pass.claimWithInvite")
                ) : (
                  t("pass.claim")
                )}
              </button>
            ) : invite.canBind && !hasInviter ? (
              <button type="button" onClick={bindOnly} disabled={busy} className="btn-ghost px-5 py-2 text-sm">
                {t("invite.bar.cta")} · {shortAddress(invite.pending!)}
              </button>
            ) : null}
            {address && loaded && !issued && (
              <span className="text-[11px] text-bone/45">
                {invite.canBind && !hasInviter ? t("pass.twoTx") : t("pass.gasOnly")}
              </span>
            )}
          </div>
          <TxStatus tx={bindTx} successText={t("grant.inviter.success")} />
          <TxStatus tx={optInTx} successText={t("pass.issuedToast")} />
          <p className="mt-5 text-[11px] leading-relaxed text-bone/40">{t("pass.fine")}</p>
        </div>

        {/* stub */}
        <div className="pass-stub">
          <div className={`relative ${issued ? "" : "opacity-45 grayscale"}`}>
            <HashSeal hash={sealHash} size={92} hover={issued} />
            {issued && <span className="pass-stamp">{t("pass.stamp")}</span>}
          </div>
          <div className="mt-4 text-center">
            <p className="label">{t("pass.no")}</p>
            <p className="num mt-1 text-lg text-bone">{issued ? `#${formatNumber(optInBlock!, locale)}` : "— — —"}</p>
            <p className="label mt-3">{t("pass.holder")}</p>
            <p className="num mt-1 text-[12px] text-bone/75">{address ? shortAddress(address) : "0x……"}</p>
          </div>
        </div>
      </div>

      {address && issued && (
        <div className="border-t border-dashed border-bone/15 px-6 py-4 sm:px-8">
          <InviteLinkRow address={address} />
        </div>
      )}

      {/* claim celebration: a ring of sparkles bursting out of the stub */}
      {celebrate && (
        <div className="pass-burst" aria-hidden>
          {Array.from({ length: 10 }, (_, i) => (
            <span key={i} style={{ ["--a" as string]: `${i * 36}deg` }}>
              <Sparkle size={i % 2 ? 10 : 14} tone={i % 3 ? "flare" : "amber"} />
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Placeholder ticket while the pass state resolves: same frame, shimmering lines, a slowly turning seal. */
function PassLoading({ label }: { label: string }) {
  return (
    <section className="pass pass-loading" aria-busy="true" aria-label={label}>
      <div className="pass-body">
        <div className="min-w-0 flex-1 p-6 sm:p-8">
          <div className="skel h-3 w-32" />
          <div className="skel mt-5 h-9 w-3/4 max-w-[460px]" />
          <div className="mt-6 grid gap-2.5 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel h-[68px]" />
            ))}
          </div>
          <p className="mt-6 flex items-center gap-2 text-sm text-bone/50">
            <Spinner size={14} /> {label}
          </p>
        </div>
        <div className="pass-stub">
          <div className="pass-seal-spin opacity-40">
            <HashSeal size={92} />
          </div>
          <div className="skel mt-5 h-3 w-16" />
          <div className="skel mt-2 h-5 w-24" />
        </div>
      </div>
    </section>
  );
}
