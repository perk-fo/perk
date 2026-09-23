"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { getAddress, type Address, type Hex } from "viem";
import { lpGrantVaultAbi } from "@/generated/abis";
import { api, ApiRequestError } from "@/lib/api";
import { useDeployment, useTx, type QuoteMeta } from "@/lib/hooks";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApproveButton } from "@/components/ApproveButton";
import { TxStatus } from "@/components/TxStatus";
import { Spinner } from "@/components/ui/Spinner";
import { fmtCountdown, formatAmount } from "@/lib/format";
import { useT } from "@/i18n/provider";

type Proof = { leaf: { account: Address; baseAllocation: string; inviteeBoost: string }; proof: Hex[] };

/**
 * "Join this campaign" for a non-technical user, three plain steps:
 *   1. Are you on the list? — looked up automatically (the API serves each wallet's Merkle proof, verified against the
 *      on-chain root). No JSON, no "leaf".
 *   2. How much to take — one slider (share of what you can claim now), and the pairing asset it needs.
 *   3. One button — registers the allocation first if needed, then activates (two transactions, labelled step 1/2).
 * Base / invite boost / inviter credit are shown as one number with a small breakdown underneath.
 */
export function GrantJoin(props: {
  meme: Address;
  memeSymbol: string;
  memeDecimals: number;
  quote: QuoteMeta | undefined;
  /** on-chain campaign status: 1 awaiting root, 2 root proposed, 3 active, 4 finalized, 5 cancelled */
  status: number | undefined;
  opensAt: number | null;
  now: number;
  decayX18: bigint | undefined;
  registered: boolean | undefined;
  /** grantBreakdown(meme, me): claimable now, after decay */
  breakdown: readonly [bigint, bigint, bigint] | undefined;
  onChanged: () => void;
}) {
  const { t, locale } = useT();
  const { address, status: walletStatus } = useAccount();
  const { deployment } = useDeployment();
  const { meme, memeSymbol, memeDecimals, quote, status, registered, breakdown } = props;
  const [pct, setPct] = useState(99);
  const [chainActivate, setChainActivate] = useState(false);
  const registerTx = useTx();
  // activateRoot is permissionless once the review window is over: let whoever is here start the campaign
  const openTx = useTx();
  const activateTx = useTx();

  const proofQ = useQuery({
    queryKey: ["api", "grantProof", meme.toLowerCase(), address?.toLowerCase()],
    enabled: !!address && registered === false,
    queryFn: () => api.grantProof(meme, address!),
    retry: false,
    staleTime: 60_000,
  });
  const proof = proofQ.data as Proof | undefined;
  // by error code, not HTTP status: a 404 "route not found" (older API) must not read as "you're not on the list"
  const notListed = proofQ.error instanceof ApiRequestError && proofQ.error.code === "not_listed";
  const unverified = proofQ.error instanceof ApiRequestError && proofQ.error.code === "dataset_unverified";

  // what you can take now: on-chain breakdown once registered; before that the listed amounts × current decay
  // the vault reports decay 0 until the campaign is ACTIVE; before that nothing has decayed, so show the full amount
  const decay = status === 3 ? (props.decayX18 ?? 10n ** 18n) : 10n ** 18n;
  const avail: readonly [bigint, bigint, bigint] | undefined = registered
    ? breakdown
    : proof
      ? [
          (BigInt(proof.leaf.baseAllocation) * decay) / 10n ** 18n,
          (BigInt(proof.leaf.inviteeBoost) * decay) / 10n ** 18n,
          0n,
        ]
      : undefined;
  const scale = (x: bigint) => (x * BigInt(pct)) / 100n;
  const amounts = avail ? { base: scale(avail[0]), boost: scale(avail[1]), credit: scale(avail[2]) } : undefined;
  const total = amounts ? amounts.base + amounts.boost + amounts.credit : 0n;

  const required = useReadContract({
    address: deployment?.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "quoteRequired",
    args: [meme, total],
    query: { enabled: !!deployment && total > 0n, refetchInterval: 15_000 },
  });
  const requiredQuote = required.data?.[0];
  // the contract refunds what is unused; 2% headroom covers the price moving between quote and inclusion
  const quoteMax = requiredQuote !== undefined ? (requiredQuote * 102n) / 100n + 1n : undefined;
  const bal = useBalance({
    address,
    token: quote && !quote.isNative ? quote.address : undefined,
    query: { enabled: !!address && !!quote, refetchInterval: 15_000 },
  });
  const short = quoteMax !== undefined && bal.data !== undefined && bal.data.value < quoteMax;

  const activate = () => {
    if (!deployment || !amounts || quoteMax === undefined) return;
    activateTx.write({
      address: deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "activateGrant",
      args: [meme, amounts.base, amounts.boost, amounts.credit, quoteMax, 0n],
      value: quote?.isNative ? quoteMax : 0n,
    });
  };
  const start = () => {
    if (!deployment) return;
    if (registered) return activate();
    if (!proof) return;
    setChainActivate(true);
    registerTx.write({
      address: deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "registerAllocation",
      args: [
        meme,
        {
          account: getAddress(proof.leaf.account),
          baseAllocation: BigInt(proof.leaf.baseAllocation),
          inviteeBoost: BigInt(proof.leaf.inviteeBoost),
        },
        proof.proof,
      ],
    });
  };

  // step 2 of "start": once the registration is mined and the page has re-read the on-chain breakdown
  const { onChanged } = props;
  useEffect(() => {
    if (registerTx.isSuccess) onChanged();
  }, [registerTx.isSuccess, onChanged]);
  useEffect(() => {
    if (!chainActivate || !registered || !breakdown || quoteMax === undefined || short) return;
    setChainActivate(false);
    activate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainActivate, registered, breakdown, quoteMax, short]);
  useEffect(() => {
    if (registerTx.phase === "error" || activateTx.phase === "error") setChainActivate(false);
  }, [registerTx.phase, activateTx.phase]);
  useEffect(() => {
    if (activateTx.isSuccess || openTx.isSuccess) onChanged();
  }, [activateTx.isSuccess, openTx.isSuccess, onChanged]);

  const inFlight = (tx: typeof registerTx) => tx.phase === "preparing" || tx.phase === "signing" || tx.phase === "confirming";
  const busy = inFlight(registerTx) || inFlight(activateTx) || chainActivate;
  const activeTx = inFlight(registerTx) || (chainActivate && !inFlight(activateTx)) ? registerTx : activateTx;
  const twoStep = !registered || chainActivate;
  const busyLabel =
    (twoStep ? t("pass.step", { n: activeTx === registerTx ? 1 : 2, of: 2 }) : "") +
    t(`tx.phase.${inFlight(activeTx) ? activeTx.phase : "preparing"}`);

  const fmtMeme = (x: bigint | undefined) => formatAmount(x, memeDecimals, { locale, maxFrac: 0 });
  const open = status === 3;

  let body: React.ReactNode;
  if (walletStatus === "reconnecting" || walletStatus === "connecting") {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> {t("join.checking")}
      </p>
    );
  } else if (!address) {
    body = <p className="text-sm text-muted">{t("join.connect")}</p>;
  } else if (status === 1) {
    body = <p className="text-sm text-muted">{t("join.awaitingList")}</p>;
  } else if (status === 4 || status === 5) {
    body = <p className="text-sm text-muted">{t("join.ended")}</p>;
  } else if (registered === undefined || (registered === false && proofQ.isLoading)) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> {t("join.checking")}
      </p>
    );
  } else if (!registered && notListed) {
    body = (
      <div className="space-y-2">
        <p className="text-base text-bone">{t("join.notListed")}</p>
        <p className="text-sm leading-relaxed text-subtle">{t("join.notListedWhy")}</p>
        <Link href="/grant" className="inline-block text-sm text-flare underline decoration-flare/40">
          {t("join.getPass")} →
        </Link>
      </div>
    );
  } else if (!registered && (unverified || proofQ.isError)) {
    body = <p className="text-sm text-amber">{t("join.listUnavailable")}</p>;
  } else {
    const all = avail ? avail[0] + avail[1] + avail[2] : 0n;
    body = (
      <div className="space-y-6">
        {/* step 1: you are on the list */}
        <div>
          <p className="label">{t("join.youCanGet")}</p>
          <p className="mt-2 font-display text-4xl leading-none text-verdigris">
            {fmtMeme(all)} <span className="num text-base text-subtle">{memeSymbol}</span>
          </p>
          {avail && (
            <p className="num mt-2 text-[13px] text-subtle">
              {t("join.breakdown", { base: fmtMeme(avail[0]), boost: fmtMeme(avail[1]), credit: fmtMeme(avail[2]) })}
            </p>
          )}
          <p className="mt-2 text-xs text-subtle">{t("join.decayNote")}</p>
        </div>

        {/* step 2: how much */}
        <div>
          <div className="flex items-baseline justify-between">
            <p className="label">{t("join.take")}</p>
            <span className="num text-sm text-bone">{pct}%</span>
          </div>
          <input
            type="range"
            min={10}
            max={99}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            className="mt-3 w-full accent-[rgb(var(--c-flare))]"
            disabled={busy}
          />
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <p className="text-muted">
              {t("join.getMeme")} <span className="num text-bone">{fmtMeme(total)} {memeSymbol}</span>
            </p>
            <p className="text-muted sm:text-right">
              {t("join.youPut")}{" "}
              <span className="num text-bone">
                {requiredQuote !== undefined ? formatAmount(requiredQuote, quote?.decimals, { locale }) : "…"} {quote?.symbol}
              </span>
            </p>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("join.terms")}</p>
        </div>

        {/* step 3: one button */}
        <div className="space-y-2">
          {!open && status === 2 && props.opensAt && props.opensAt > props.now && (
            <p className="text-sm text-amber">{t("join.opensIn", { time: fmtCountdown(props.opensAt - props.now, t) })}</p>
          )}
          {!open && status === 2 && props.opensAt && props.opensAt <= props.now && deployment && (
            <div className="rounded-[14px] border border-amber/30 bg-amber/5 p-4">
              <p className="text-sm text-amber">{t("join.reviewOver")}</p>
              <div className="mt-3">
                <Button
                  variant="ghost"
                  tx={openTx}
                  onClick={() =>
                    openTx.write({
                      address: deployment.lpGrantVault,
                      abi: lpGrantVaultAbi,
                      functionName: "activateRoot",
                      args: [meme],
                    })
                  }
                >
                  {t("join.openNow")}
                </Button>
              </div>
              <TxStatus tx={openTx} successText={t("join.opened")} />
            </div>
          )}
          {open && quote && !quote.isNative && quoteMax !== undefined && deployment && (
            <ApproveButton token={quote.address} spender={deployment.lpGrantVault} needed={quoteMax} symbol={quote.symbol} />
          )}
          <button
            type="button"
            onClick={start}
            disabled={!open || busy || total === 0n || quoteMax === undefined || short || (!registered && !proof)}
            className="btn-primary w-full px-6 py-3 text-[15px]"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size={15} /> {busyLabel}
              </span>
            ) : (
              t("join.start")
            )}
          </button>
          {short && <p className="text-xs text-amber">{t("grant.guard.quoteShort", { symbol: quote?.symbol ?? "" })}</p>}
          {!registered && open && !busy && <p className="text-xs text-subtle">{t("join.twoTx")}</p>}
          <TxStatus tx={registerTx} />
          <TxStatus tx={activateTx} successText={t("join.done")} />
        </div>
      </div>
    );
  }

  return <Panel title={t("join.title")}>{body}</Panel>;
}
