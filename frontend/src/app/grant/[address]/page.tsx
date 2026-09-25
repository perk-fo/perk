"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi, getAddress, isAddress, type Address, type Hex } from "viem";
import { launchFactoryAbi, lpGrantVaultAbi, referralRegistryAbi } from "@/generated/abis";
import { useDeployment, useNow, useTx } from "@/lib/hooks";
import { useLaunchDetail } from "@/lib/api-hooks";
import { GrantJoin } from "@/components/grant/GrantJoin";
import { findQuote, hasKnownDecimals, useQuotes } from "@/lib/quotes";
import { formatAmount, formatCompact, formatNumber, fmtCountdown, fmtTime, shortAddress } from "@/lib/format";
import { DecayRing } from "@/components/art/DecayRing";
import { Panel } from "@/components/ui/Panel";
import { Pill, campaignStatusPill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Kv } from "@/components/ui/Kv";
import { Ticket } from "@/components/ui/Ticket";
import { Skeleton } from "@/components/ui/Skeleton";
import { TxStatus } from "@/components/TxStatus";
import { RoleGate } from "@/components/RoleGate";
import { useT, type TFn } from "@/i18n/provider";
import { PerkLoader } from "@/components/brand/PerkLoader";

/** PRD 11.3 risk-disclosure message keys, in order. */
const RISK_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `grant.risk.${i}`);

/** Output format of packages/indexer/src/cli/proof.ts */
interface ProofJson {
  meme: string;
  leaf: { account: string; baseAllocation: string; inviteeBoost: string };
  proof: string[];
}

function parseProofJson(raw: string): ProofJson {
  let parsed: ProofJson;
  try {
    parsed = JSON.parse(raw) as ProofJson;
  } catch {
    throw new Error("grant.proof.errJson");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("grant.proof.errJson");
  if (!parsed.meme || !isAddress(parsed.meme)) throw new Error("grant.proof.errMeme");
  if (!parsed.leaf || !isAddress(parsed.leaf.account)) throw new Error("grant.proof.errLeaf");
  if (!Array.isArray(parsed.proof)) throw new Error("grant.proof.errProof");
  BigInt(parsed.leaf.baseAllocation);
  BigInt(parsed.leaf.inviteeBoost);
  return parsed;
}

/** Render a caught proof error: i18n keys are translated, anything else shown raw. */
function proofErrorMessage(e: unknown, t: TFn): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.startsWith("grant.proof.") ? t(msg) : msg;
}

/** Graduation → Root proposed → effective → end, as a hairline with dots. */
function Timeline({
  points,
  now,
}: {
  points: ReadonlyArray<{ label: string; at: number }>;
  now: number;
}) {
  const { locale } = useT();
  return (
    <ol className="relative grid grid-cols-4 gap-2">
      <div className="absolute left-0 right-0 top-[5px] border-t border-line" aria-hidden />
      {points.map((p) => {
        const reached = p.at > 0 && now >= p.at;
        const set = p.at > 0;
        return (
          <li key={p.label} className="relative min-w-0 pt-4">
            <span
              className={`absolute left-0 top-0 h-[11px] w-[11px] rounded-full border-2 ${
                reached ? "border-verdigris bg-verdigris" : set ? "border-honey bg-ink" : "border-line-strong bg-ink"
              }`}
              aria-hidden
            />
            <div className="label">{p.label}</div>
            <div className="num mt-1 truncate text-xs text-subtle">{set ? fmtTime(p.at, locale) : "—"}</div>
          </li>
        );
      })}
    </ol>
  );
}

interface GrantPositionShape {
  beneficiary: Address;
  meme: Address;
  quote: Address;
  poolId: Hex;
  tokenId: bigint;
  grantMemeAmount: bigint;
  baseMemeActivated: bigint;
  inviteeBoostActivated: bigint;
  inviterCreditActivated: bigint;
  quoteDeposited: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  activatedAt: bigint;
  incentiveCheckpoint: bigint;
  incentiveTimeCheckpoint: bigint;
  exited: boolean;
}

function PositionTicket({
  id,
  position,
  memeDecimals,
  quoteDecimals,
  quoteSymbol,
  minLpSeconds,
  vault,
  now,
}: {
  id: bigint;
  position: GrantPositionShape;
  memeDecimals: number;
  /** Null while unknown: amounts then show as a dash rather than being read with guessed decimals. */
  quoteDecimals: number | null;
  quoteSymbol: string;
  minLpSeconds: number;
  vault: Address;
  now: number;
}) {
  const pending = useReadContract({
    address: vault,
    abi: lpGrantVaultAbi,
    functionName: "pendingIncentive",
    args: [id],
    query: { refetchInterval: 15_000 },
  });
  const collectTx = useTx();
  const exitTx = useTx();
  const { t, locale } = useT();
  const { address: account } = useAccount();
  // collect/exit pay the beneficiary; anyone else pressing them would only spend gas
  const isOwner = !!account && account.toLowerCase() === position.beneficiary.toLowerCase();

  const exitableAt = Number(position.activatedAt) + minLpSeconds;
  const canExit = !position.exited && now >= exitableAt;

  return (
    <Ticket
      stub={
        <>
          <span className="num font-display text-2xl leading-none">#{id.toString()}</span>
          {position.exited ? (
            <Pill tone="muted">{t("grant.position.exited")}</Pill>
          ) : canExit ? (
            <Pill tone="verdigris">{t("grant.position.exitable")}</Pill>
          ) : (
            <>
              <Pill tone="amber">{t("grant.position.locked")}</Pill>
              <span className="num text-xs text-amber">{fmtCountdown(exitableAt - now, t)}</span>
            </>
          )}
        </>
      }
    >
      <div className="divide-y divide-line">
        <Kv label={t("grant.position.grantMeme")} value={formatAmount(position.grantMemeAmount, memeDecimals, { locale })} />
        <Kv label={t("grant.position.principal")} value={`${formatAmount(position.quoteDeposited, quoteDecimals, { locale })} ${quoteSymbol}`} />
        <Kv label={t("common.liquidity")}>
          <span title={position.liquidity.toString()}>{formatCompact(position.liquidity)}</span>
        </Kv>
        <Kv label={t("grant.position.pending")} value={`${formatAmount(pending.data, quoteDecimals, { locale })} ${quoteSymbol}`} />
      </div>
      {!position.exited && (
        <RoleGate roles="lp" meme={position.meme}>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <Button
              variant="ghost"
              tx={collectTx}
              disabled={!isOwner || collectTx.isPending || collectTx.isConfirming}
              title={isOwner ? undefined : t("grant.guard.notOwner")}
              onClick={() =>
                collectTx.write(
                  {
                    address: vault,
                    abi: lpGrantVaultAbi,
                    functionName: "collectGrantFees",
                    args: [id],
                  },
                  {
                    // (quoteFeesPaid, memeFeesBurned, incentivePaid) all zero → the call succeeds but does nothing
                    check: (r) =>
                      (r as readonly bigint[]).every((x) => x === 0n) ? "errors.precheck.nothingToCollect" : null,
                  },
                )
              }
            >
              {t("grant.position.collect")}
            </Button>
            <TxStatus tx={collectTx} successText={t("common.claimed")} />
          </div>
          <div>
            <Button
              variant="danger"
              tx={exitTx}
              disabled={!isOwner || !canExit || exitTx.isPending || exitTx.isConfirming || exitTx.isSuccess}
              title={
                !isOwner
                  ? t("grant.guard.notOwner")
                  : canExit
                    ? undefined
                    : t("grant.position.waitUntil", { time: fmtTime(exitableAt, locale) })
              }
              onClick={() =>
                exitTx.write({
                  address: vault,
                  abi: lpGrantVaultAbi,
                  functionName: "exitGrantPosition",
                  args: [id, 0n, 0n],
                })
              }
            >
              {t("grant.position.exit")}
            </Button>
            <TxStatus tx={exitTx} successText={t("grant.position.exited")} />
          </div>
        </div>
        </RoleGate>
      )}
    </Ticket>
  );
}

export default function GrantPage() {
  const params = useParams<{ address: string }>();
  const meme = params.address as Address;
  const validAddress = isAddress(meme);

  const { deployment } = useDeployment();
  const { address: account } = useAccount();
  const now = useNow();
  const { quotes } = useQuotes();
  const { t, locale } = useT();

  const { data } = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: launchFactoryAbi, functionName: "getLaunch", args: [meme] },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "campaign", args: [meme] },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "config" },
      { address: deployment?.lpGrantVault, abi: lpGrantVaultAbi, functionName: "decayFactorX18", args: [meme] },
      { address: meme, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: !!deployment && validAddress, refetchInterval: 15_000 },
  });
  const launch = data?.[0]?.result;
  const detail = useLaunchDetail(validAddress ? (meme as Address) : undefined);
  const campaign = data?.[1]?.result;
  const vaultConfig = data?.[2]?.result;
  const decayFactorX18 = data?.[3]?.result;
  const memeDecimals = Number(data?.[4]?.result ?? 18);

  const quoteMeta = findQuote(quotes, launch?.quote as Address | undefined);

  // ---- referral / opt-in ----
  const optInBlock = useReadContract({
    address: deployment?.referralRegistry,
    abi: referralRegistryAbi,
    functionName: "optInBlock",
    args: account ? [account] : undefined,
    query: { enabled: !!deployment && !!account },
  });
  const inviter = useReadContract({
    address: deployment?.referralRegistry,
    abi: referralRegistryAbi,
    functionName: "inviterOf",
    args: account ? [account] : undefined,
    query: { enabled: !!deployment && !!account },
  });

  // ---- allocation / proof ----

  const allocation = useReadContract({
    address: deployment?.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "allocation",
    args: account ? [meme, account] : undefined,
    query: { enabled: !!deployment && !!account && validAddress, refetchInterval: 15_000 },
  });
  const breakdown = useReadContract({
    address: deployment?.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "grantBreakdown",
    args: account ? [meme, account] : undefined,
    query: { enabled: !!deployment && !!account && validAddress, refetchInterval: 15_000 },
  });
  const allocationRefetch = allocation.refetch;
  const breakdownRefetch = breakdown.refetch;
  /** after register / activate: re-read what the chain now says about me */
  const refreshMine = useCallback(() => {
    void allocationRefetch();
    void breakdownRefetch();
  }, [allocationRefetch, breakdownRefetch]);

  const [proofText, setProofText] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [proofError, setProofError] = useState("");
  const [proofJson, setProofJson] = useState<ProofJson | null>(null);
  const registerTx = useTx();

  function acceptProof(raw: string) {
    try {
      const parsed = parseProofJson(raw);
      if (getAddress(parsed.meme) !== getAddress(meme)) throw new Error("grant.proof.errMismatch");
      setProofError("");
      setProofJson(parsed);
    } catch (e) {
      setProofJson(null);
      setProofError(proofErrorMessage(e, t));
    }
  }

  // ---- activate: see components/grant/GrantJoin ----
  const proofIsMine =
    !!proofJson && !!account && proofJson.leaf.account.toLowerCase() === account.toLowerCase();

  // ---- positions ----
  const positionsOf = useReadContract({
    address: deployment?.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "positionsOf",
    args: account ? [account] : undefined,
    query: { enabled: !!deployment && !!account, refetchInterval: 15_000 },
  });
  const positionIds = useMemo(() => positionsOf.data ?? [], [positionsOf.data]);
  const positionsData = useReadContracts({
    contracts: positionIds.map((id) => ({
      address: deployment!.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "position" as const,
      args: [id] as const,
    })),
    query: { enabled: !!deployment && positionIds.length > 0, refetchInterval: 15_000 },
  });
  const myPositions = useMemo(
    () =>
      positionIds
        .map((id, i) => ({ id, position: positionsData.data?.[i]?.result }))
        .filter(
          (p): p is { id: bigint; position: NonNullable<typeof p.position> } =>
            !!p.position && p.position.meme.toLowerCase() === meme.toLowerCase(),
        ),
    [positionIds, positionsData.data, meme],
  );

  if (!validAddress) {
    return (
      <Notice tone="rose" title={t("common.addressTitle")}>
        {t("common.invalidAddress")}
      </Notice>
    );
  }
  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("common.noDeployment")}
      </Notice>
    );
  }
  if (!launch) {
    return <PerkLoader minHeight={520} />;
  }
  if (!launch.lpGrantEnabled) {
    return (
      <Panel>
        <p className="text-sm text-muted">{t("grant.disabled")}</p>
        <Link href={`/meme/${meme}`} className="mt-3 inline-block text-sm text-flare underline decoration-flare/40">
          {t("grant.back")}
        </Link>
      </Panel>
    );
  }

  const minLpSeconds = campaign ? Number(campaign.minLpSeconds) : 0;
  const activatableAt =
    campaign && vaultConfig && campaign.rootProposedAt > 0n
      ? Number(campaign.rootProposedAt) + Number(vaultConfig.rootDelaySeconds)
      : 0;
  const endTime = campaign ? Number(campaign.endTime) : 0;
  const startTime = campaign ? Number(campaign.startTime) : 0;

  const statusPill = campaignStatusPill(campaign?.status, t);
  const claimableTotal =
    breakdown.data !== undefined ? breakdown.data[0] + breakdown.data[1] + breakdown.data[2] : undefined;

  // Decay ring: only ACTIVE draws the real remaining share (on-chain decay factor, else a time-based
  // estimate). Every other status is an empty ring with a status phrase in the centre.
  const campaignStatus = campaign?.status;
  const remaining =
    campaignStatus === 3
      ? decayFactorX18 !== undefined
        ? Number(decayFactorX18) / 1e18
        : startTime > 0 && endTime > startTime && now > startTime
          ? Math.max(0, Math.min(1, (endTime - now) / (endTime - startTime)))
          : 1
      : 0;
  // a cancelled campaign is the one red state; an expired one simply finished (its ring is empty anyway)
  const ringTone: "amber" | "rose" = campaignStatus === 5 ? "rose" : "amber";
  const ringCentre =
    campaignStatus === 3
      ? null
      : campaignStatus === 1
        ? t("status.campaign.awaitingRoot")
        : campaignStatus === 2
          ? t("grant.ring.tallyWindow")
          : campaignStatus === 4
            ? t("status.campaign.ended")
            : campaignStatus === 5
              ? t("status.campaign.cancelled")
              : "—";

  return (
    <div className="space-y-6 pt-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/grant" className="label hover:text-bone">
            ← LP Grant
          </Link>
          <h1 className="mt-2 font-display text-3xl sm:text-4xl">
            {detail.data ? `${detail.data.name}` : "LP Grant"}
            {detail.data && <span className="num ml-3 text-lg text-subtle">{detail.data.symbol}</span>}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <Pill tone={statusPill.tone}>{statusPill.label}</Pill>
            <span className="mono break-all text-xs text-subtle">{meme}</span>
          </div>
        </div>
        <Link href={`/meme/${meme}`} className="btn-ghost px-3.5 py-1.5 text-sm">
          {t("grant.back")}
        </Link>
      </header>

      {/* hero: decay ring as the main number */}
      <Panel>
        <div className="flex flex-wrap items-center gap-10">
          <DecayRing remaining={remaining} size={220} tone={ringTone}>
            {ringCentre === null ? (
              <>
                <span className="font-display text-4xl leading-none">
                  {formatAmount(claimableTotal, memeDecimals, { locale })}
                </span>
                <span className="label mt-2">{t("grant.hero.remaining")}</span>
                {endTime > 0 && <span className="num mt-1 text-xs text-amber">{fmtCountdown(endTime - now, t)}</span>}
              </>
            ) : (
              <span className="font-display text-3xl leading-none">{ringCentre}</span>
            )}
          </DecayRing>
          <div className="min-w-0 flex-1 basis-60 divide-y divide-line">
            <Kv label={t("grant.kv.status")} >{statusPill.label}</Kv>
            <Kv label={t("grant.kv.reserve")} value={formatAmount(campaign?.reserve, memeDecimals, { locale })} />
            <Kv label={t("grant.kv.activated")} value={formatAmount(campaign?.totalActivated, memeDecimals, { locale })} />
            <Kv label={t("grant.kv.burned")} value={formatAmount(campaign?.burned, memeDecimals, { locale })} />
            <Kv
              label={t("grant.kv.decay")}
              value={
                decayFactorX18 !== undefined
                  ? `${formatNumber(Number(decayFactorX18) / 1e16, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
                  : "—"
              }
            />
          </div>
        </div>
      </Panel>

      {/* timeline */}
      <Panel title={t("grant.timeline.title")}>
        <Timeline
          now={now}
          points={[
            { label: t("grant.timeline.graduation"), at: campaign ? Number(campaign.graduatedAt) : 0 },
            { label: t("grant.timeline.rootProposed"), at: campaign ? Number(campaign.rootProposedAt) : 0 },
            { label: t("grant.timeline.effective"), at: activatableAt },
            { label: t("grant.timeline.end"), at: endTime },
          ]}
        />
      </Panel>

      {/* join: on the list? how much? one button (register + activate) */}
      <GrantJoin
        meme={meme}
        memeSymbol={detail.data?.symbol ?? ""}
        memeDecimals={memeDecimals}
        quote={hasKnownDecimals(quoteMeta) ? quoteMeta : undefined}
        status={campaign ? Number(campaign.status) : undefined}
        opensAt={activatableAt}
        now={now}
        decayX18={decayFactorX18}
        registered={account ? allocation.data?.registered : undefined}
        breakdown={breakdown.data}
        onChanged={refreshMine}
      />

      {/* participation is global and lives on /grant; here only its status, with a way there */}
      <Link href="/grant" className="panel flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <span className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="text-muted">
            {t("grant.optin.status")}{" "}
            <span className={optInBlock.data && optInBlock.data > 0n ? "text-verdigris" : "text-amber"}>
              {optInBlock.data && optInBlock.data > 0n ? t("grant.hub.optedShort") : t("grant.optin.none")}
            </span>
          </span>
          <span className="text-muted">
            {t("grant.inviter.label")}{" "}
            {inviter.data && inviter.data !== "0x0000000000000000000000000000000000000000" ? (
              <span className="mono text-bone">{shortAddress(inviter.data)}</span>
            ) : (
              <span className="text-bone">{t("grant.inviter.unbound")}</span>
            )}
          </span>
        </span>
        <span className="text-sm text-muted">{t("grant.hub.manage")} →</span>
      </Link>

      {/* for the curious: verify the list yourself / supply a proof by hand. Collapsed; nobody needs it to join. */}
      {!allocation.data?.registered && (
        <details className="panel group p-6">
          <summary className="cursor-pointer list-none text-sm text-muted hover:text-bone">
            <span className="mr-2 inline-block transition-transform duration-fast group-open:rotate-90">›</span>
            {t("join.verifyTitle")}
          </summary>
          <div className="mt-4">
          <p className="mb-4 text-xs leading-relaxed text-subtle">{t("join.verifyBody")}</p>
          <Field
            label="Proof JSON"
            hint={t("grant.register.proofHint")}
            textarea
            mono
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
            placeholder='{"meme":"0x…","leaf":{...},"proof":[...]}'
          />
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" className="w-auto px-4" onClick={() => acceptProof(proofText)}>
              {t("grant.register.parse")}
            </Button>
          </div>
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <Field
              label={t("grant.register.urlLabel")}
              className="min-w-0 flex-1"
              mono
              value={proofUrl}
              onChange={(e) => setProofUrl(e.target.value)}
              placeholder="https://…/proof.json"
            />
            <Button
              variant="ghost"
              className="w-auto shrink-0 px-4"
              onClick={async () => {
                try {
                  const res = await fetch(proofUrl);
                  acceptProof(await res.text());
                } catch (e) {
                  setProofError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {t("grant.register.load")}
            </Button>
          </div>
          {proofError && (
            <Notice tone="rose" className="mt-3">
              {proofError}
            </Notice>
          )}
          {proofJson && (
            <div className="mt-4">
              <p className="num text-xs text-muted">
                leaf: {proofJson.leaf.account.slice(0, 6)}…{proofJson.leaf.account.slice(-4)} · base{" "}
                {formatAmount(BigInt(proofJson.leaf.baseAllocation), memeDecimals, { locale })} · boost{" "}
                {formatAmount(BigInt(proofJson.leaf.inviteeBoost), memeDecimals, { locale })}
              </p>
              <div className="mt-2">
                {campaign && Number(campaign.status) !== 3 && (
                  <p className="mb-2 text-[13px] text-muted">{t("grant.register.afterActivation")}</p>
                )}
                <Button
                  tx={registerTx}
                  disabled={
                    !account ||
                    !proofIsMine ||
                    !campaign ||
                    Number(campaign.status) !== 3 /* ACTIVE: registrations are tied to the active root */ ||
                    registerTx.isPending ||
                    registerTx.isConfirming
                  }
                  onClick={() =>
                    registerTx.write({
                      address: deployment.lpGrantVault,
                      abi: lpGrantVaultAbi,
                      functionName: "registerAllocation",
                      args: [
                        meme,
                        {
                          account: getAddress(proofJson.leaf.account),
                          baseAllocation: BigInt(proofJson.leaf.baseAllocation),
                          inviteeBoost: BigInt(proofJson.leaf.inviteeBoost),
                        },
                        proofJson.proof as Hex[],
                      ],
                    })
                  }
                >
                  {t("grant.register.cta")}
                </Button>
                {account && !proofIsMine && <p className="mt-2 text-xs text-amber">{t("grant.guard.proofNotYours")}</p>}
                <TxStatus tx={registerTx} successText={t("grant.alloc.registered")} />
              </div>
            </div>
          )}
          </div>
        </details>
      )}

      {/* positions */}
      {account && positionsOf.data !== undefined && (
        <RoleGate roles="lp" meme={meme}>
        <Panel title={t("grant.positions.title")}>
          {myPositions.length === 0 ? (
            <div className="flex flex-col items-center py-6 text-center">
              <Skeleton size={48} lines={0} />
              <p className="mt-3 text-sm text-subtle">{t("grant.positions.empty")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {myPositions.map(({ id, position }) => (
                <PositionTicket
                  key={id.toString()}
                  id={id}
                  position={position}
                  memeDecimals={memeDecimals}
                  quoteDecimals={quoteMeta?.decimals ?? null}
                  quoteSymbol={quoteMeta?.symbol ?? "Quote"}
                  minLpSeconds={minLpSeconds}
                  vault={deployment.lpGrantVault}
                  now={now}
                />
              ))}
            </div>
          )}
        </Panel>
        </RoleGate>
      )}

      {/* PRD 11.3 verbatim */}
      <Notice tone="amber" title={t("grant.risk.title")}>
        <p className="mb-2 text-sm text-muted">{t("grant.risk.intro")}</p>
        <ul className="divide-y divide-line">
          {RISK_KEYS.map((key) => (
            <li key={key} className="flex items-baseline gap-2 py-1.5 text-sm text-muted">
              <span aria-hidden className="shrink-0 text-subtle">
                ·
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}
