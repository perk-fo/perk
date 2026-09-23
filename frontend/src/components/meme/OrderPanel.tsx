"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useAccount,
  useBalance,
  useConnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import { erc20Abi, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { bondingCurveAbi, poolSwapTestAbi } from "@/generated/abis";
import { useTabVisible, useTx } from "@/lib/hooks";
import { decodeErrorMessage } from "@/lib/errors";
import {
  MAX_SQRT_PRICE_MINUS_ONE,
  MIN_SQRT_PRICE_PLUS_ONE,
  TESTNET_SWAP_ROUTER,
} from "@/lib/deployments";
import type { QuoteInfo } from "@/lib/quotes";
import { unpackBalanceDelta } from "@/lib/trades";
import { formatAmount, fmtBps, signedPct } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Sparkle } from "@/components/art/Sparkle";
import { useT } from "@/i18n/provider";
import { usePauseFlags } from "@/lib/pause";

const NATIVE_GAS_HEADROOM = 1_000_000_000_000_000n; // 0.001 OKB
const SLIP_PRESETS = [50, 100, 200] as const;

export interface PoolKeyShape {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

function minOut(amount: bigint | undefined, slipBps: bigint): bigint {
  if (amount === undefined) return 0n;
  const bps = slipBps > 10_000n ? 10_000n : slipBps;
  return (amount * (10_000n - bps)) / 10_000n;
}

function impactBps(spotQ: bigint, spotM: bigint, execQ: bigint, execM: bigint): bigint {
  if (spotQ === 0n || spotM === 0n || execM === 0n) return 0n;
  const exec = execQ * spotM;
  const spot = execM * spotQ;
  if (spot === 0n) return 0n;
  return ((exec - spot) * 10_000n) / spot;
}

function formatInput(amount: bigint, decimals: number): string {
  const s = formatUnits(amount, decimals);
  if (!s.includes(".")) return s;
  return s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function OrderPanel({
  meme,
  memeSymbol,
  memeDecimals,
  quoteMeta,
  curve,
  status,
  chainId,
  poolKey,
  virtualQuote,
  virtualMeme,
  totalFeeBps,
  lastPriceQuote,
  lastPriceMeme,
}: {
  meme: Address;
  memeSymbol: string;
  memeDecimals: number;
  quoteMeta: QuoteInfo;
  curve: Address;
  status: number;
  chainId: number;
  poolKey?: PoolKeyShape;
  virtualQuote?: bigint;
  virtualMeme?: bigint;
  totalFeeBps: number;
  lastPriceQuote: bigint;
  lastPriceMeme: bigint;
}) {
  const { t, locale } = useT();
  const { address, isConnected, chainId: walletChainId } = useAccount(); // real wallet chain, see Header
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain } = useSwitchChain();
  const client = usePublicClient({ chainId });
  const visible = useTabVisible();

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [input, setInput] = useState("");
  const [slipBps, setSlipBps] = useState(100);
  const [customSlip, setCustomSlip] = useState("");
  const [slipCustom, setSlipCustom] = useState(false);
  const [flash, setFlash] = useState(false);
  const pause = usePauseFlags();

  const parsed = useMemo(() => {
    if (!input.trim()) return 0n;
    try {
      return parseUnits(input, mode === "buy" ? quoteMeta.decimals : memeDecimals);
    } catch {
      return null;
    }
  }, [input, mode, quoteMeta.decimals, memeDecimals]);

  const quoteBal = useBalance({
    address,
    token: quoteMeta.isNative ? undefined : quoteMeta.address,
    query: { enabled: !!address, refetchInterval: visible ? 12_000 : false },
  });
  const memeBal = useBalance({
    address,
    token: meme,
    query: { enabled: !!address, refetchInterval: visible ? 12_000 : false },
  });

  const spendBal = mode === "buy" ? quoteBal.data?.value : memeBal.data?.value;
  const spendDecimals = mode === "buy" ? quoteMeta.decimals : memeDecimals;
  const spendSymbol = mode === "buy" ? quoteMeta.symbol : memeSymbol;

  const quoteBuy = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: "quoteBuy",
    args: [meme, parsed ?? 0n],
    query: {
      enabled: status === 1 && mode === "buy" && !!parsed && parsed > 0n,
      refetchInterval: visible ? 12_000 : false,
    },
  });
  const quoteSell = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: "quoteSell",
    args: [meme, parsed ?? 0n],
    query: {
      enabled: status === 1 && mode === "sell" && !!parsed && parsed > 0n,
      refetchInterval: visible ? 12_000 : false,
    },
  });

  const quoteIsCurrency0 =
    poolKey !== undefined && quoteMeta.address.toLowerCase() === poolKey.currency0.toLowerCase();
  const zeroForOne = mode === "buy" ? quoteIsCurrency0 : !quoteIsCurrency0;

  const poolSim = useQuery({
    queryKey: [
      "pool-sim",
      chainId,
      meme,
      mode,
      parsed?.toString(),
      address,
      poolKey?.currency0,
      poolKey?.currency1,
    ],
    enabled:
      status === 3 &&
      chainId === 1952 &&
      !!TESTNET_SWAP_ROUTER &&
      !!client &&
      !!poolKey &&
      !!address &&
      !!parsed &&
      parsed > 0n,
    refetchInterval: visible ? 12_000 : false,
    retry: false,
    queryFn: async () => {
      if (!client || !poolKey || !parsed || !address) return null;
      const { result } = await client.simulateContract({
        address: TESTNET_SWAP_ROUTER,
        abi: poolSwapTestAbi,
        functionName: "swap",
        args: [
          poolKey,
          {
            zeroForOne,
            amountSpecified: -parsed,
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
          },
          { takeClaims: false, settleUsingBurn: false },
          "0x" as Hex,
        ],
        value: mode === "buy" && quoteMeta.isNative ? parsed : 0n,
        account: address,
      });
      return unpackBalanceDelta(result as bigint);
    },
  });

  const spender: Address = status === 3 ? TESTNET_SWAP_ROUTER : curve;
  const needToken: Address | undefined =
    mode === "buy" ? (quoteMeta.isNative ? undefined : quoteMeta.address) : meme;
  const allowance = useReadContract({
    address: needToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && needToken ? [address, spender] : undefined,
    query: { enabled: !!address && !!needToken && !!spender && parsed !== null && (parsed ?? 0n) > 0n },
  });

  const approveTx = useTx();
  const tradeTx = useTx();

  const refetchAllowance = allowance.refetch;
  const resetApprove = approveTx.reset;
  useEffect(() => {
    if (!approveTx.isSuccess) return;
    void refetchAllowance();
    resetApprove();
  }, [approveTx.isSuccess, refetchAllowance, resetApprove]);

  const resetTrade = tradeTx.reset;
  const refetchQuoteBal = quoteBal.refetch;
  const refetchMemeBal = memeBal.refetch;
  useEffect(() => {
    if (!tradeTx.isSuccess) return;
    // done: clear the amount, refresh both balances now, and pull the indexer-backed views (trades, chart,
    // holders, stats) once the indexer has had time to see the block, instead of waiting for the next poll
    setFlash(true);
    setInput("");
    void refetchQuoteBal();
    void refetchMemeBal();
    // Balances and the indexer-backed views are refreshed by useTx on a schedule that survives the reset below.
    // (The delayed refreshes that used to live here never ran: resetTrade() flipped isSuccess, and this effect's
    // own cleanup cancelled them.)
    const id = setTimeout(() => {
      setFlash(false);
      resetTrade();
    }, 1500);
    return () => clearTimeout(id);
  }, [tradeTx.isSuccess, resetTrade, refetchQuoteBal, refetchMemeBal]);

  const activeSlip = slipCustom
    ? Math.min(10_000, Math.max(0, Math.round(Number.parseFloat(customSlip || "0") * 100))) || 0
    : slipBps;
  const slipBig = BigInt(Number.isFinite(activeSlip) ? activeSlip : 0);

  const curveOut = mode === "buy" ? quoteBuy.data?.[0] : quoteSell.data?.[0];
  const curveFee = mode === "buy" ? quoteBuy.data?.[2] : quoteSell.data?.[1];

  const poolOut = useMemo(() => {
    const delta = poolSim.data;
    if (!delta || !poolKey) return undefined;
    const memeDelta = quoteIsCurrency0 ? delta.amount1 : delta.amount0;
    const quoteDelta = quoteIsCurrency0 ? delta.amount0 : delta.amount1;
    if (mode === "buy") return memeDelta < 0n ? -memeDelta : memeDelta;
    return quoteDelta < 0n ? -quoteDelta : quoteDelta;
  }, [poolSim.data, poolKey, quoteIsCurrency0, mode]);

  const expectedOut = status === 1 ? curveOut : poolOut;
  const expectedDecimals = mode === "buy" ? memeDecimals : quoteMeta.decimals;
  const expectedSymbol = mode === "buy" ? memeSymbol : quoteMeta.symbol;

  const feeAmount = useMemo(() => {
    if (status === 1 && curveFee !== undefined) return curveFee;
    if (parsed && parsed > 0n) {
      const feeBps = BigInt(totalFeeBps);
      if (mode === "buy") return (parsed * feeBps) / 10_000n;
      if (expectedOut !== undefined) return (expectedOut * feeBps) / 10_000n;
    }
    return undefined;
  }, [status, curveFee, parsed, totalFeeBps, mode, expectedOut]);

  const impact = useMemo(() => {
    if (!parsed || parsed <= 0n || expectedOut === undefined || expectedOut === 0n) return undefined;
    const spotQ = status === 1 ? (virtualQuote ?? 0n) : lastPriceQuote;
    const spotM = status === 1 ? (virtualMeme ?? 0n) : lastPriceMeme;
    if (spotQ === 0n || spotM === 0n) return undefined;
    const execQ = mode === "buy" ? parsed : expectedOut;
    const execM = mode === "buy" ? expectedOut : parsed;
    return impactBps(spotQ, spotM, execQ, execM);
  }, [parsed, expectedOut, status, virtualQuote, virtualMeme, lastPriceQuote, lastPriceMeme, mode]);

  const minReceived = expectedOut !== undefined ? minOut(expectedOut, slipBig) : undefined;

  const wrongChain = isConnected && walletChainId !== chainId;
  const needsApprove =
    !!needToken &&
    !!parsed &&
    parsed > 0n &&
    allowance.data !== undefined &&
    allowance.data < parsed;
  const insufficient = parsed !== null && parsed > 0n && spendBal !== undefined && parsed > spendBal;
  const pending = tradeTx.isPending || tradeTx.isConfirming || approveTx.isPending || approveTx.isConfirming || connecting;

  const onSubmit = () => {
    if (!isConnected) {
      const c = connectors[0];
      if (c) connect({ connector: c, chainId: 1952 });
      return;
    }
    if (wrongChain) {
      switchChain({ chainId });
      return;
    }
    if (!address || parsed === null || parsed <= 0n || insufficient) return;
    if (needsApprove && needToken) {
      approveTx.write({
        address: needToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, parsed],
      });
      return;
    }
    if (status === 1) {
      if (mode === "buy") {
        tradeTx.write({
          address: curve,
          abi: bondingCurveAbi,
          functionName: "buy",
          args: [meme, parsed, minOut(quoteBuy.data?.[0], slipBig), address],
          value: quoteMeta.isNative ? parsed : 0n,
        });
      } else {
        tradeTx.write({
          address: curve,
          abi: bondingCurveAbi,
          functionName: "sell",
          args: [meme, parsed, minOut(quoteSell.data?.[0], slipBig), address],
        });
      }
      return;
    }
    if (status === 3 && poolKey && TESTNET_SWAP_ROUTER) {
      tradeTx.write({
        address: TESTNET_SWAP_ROUTER,
        abi: poolSwapTestAbi,
        functionName: "swap",
        args: [
          poolKey,
          {
            zeroForOne,
            amountSpecified: -parsed,
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
          },
          { takeClaims: false, settleUsingBurn: false },
          "0x" as Hex,
        ],
        value: mode === "buy" && quoteMeta.isNative ? parsed : 0n,
      });
    }
  };

  let cta = mode === "buy" ? t("meme.trade.buy") : t("meme.trade.sell");
  let ctaDisabled = false;
  // an emergency pause can stop buying on the curve; selling (and trading in a graduated pool) always stays open
  const buyPaused = mode === "buy" && status === 1 && pause.isPaused("buy");
  if (flash) cta = t("meme.order.confirmed");
  else if (pending) cta = t("meme.order.pending");
  else if (buyPaused) {
    cta = t("pause.cta.buy");
    ctaDisabled = true;
  } else if (!isConnected) cta = t("meme.order.connect");
  else if (wrongChain) {
    cta = t("meme.order.wrongNetwork");
    ctaDisabled = true;
  } else if (parsed === null || parsed === 0n) {
    cta = t("meme.order.needAmount");
    ctaDisabled = true;
  } else if (insufficient) {
    cta = t("meme.order.insufficient");
    ctaDisabled = true;
  } else if (needsApprove) cta = t("meme.order.approve", { symbol: spendSymbol });

  const validTrade =
    isConnected &&
    !wrongChain &&
    parsed !== null &&
    parsed > 0n &&
    !insufficient &&
    !needsApprove &&
    !pending &&
    !flash &&
    !buyPaused;

  const setPct = (pct: bigint, isMax: boolean) => {
    if (spendBal === undefined) return;
    let raw = (spendBal * pct) / 100n;
    if (isMax && mode === "buy" && quoteMeta.isNative) {
      raw = spendBal > NATIVE_GAS_HEADROOM ? spendBal - NATIVE_GAS_HEADROOM : 0n;
    }
    setInput(formatInput(raw, spendDecimals));
  };

  const impactFmt = impact !== undefined ? signedPct(impact, locale) : undefined;
  // Impact is a cost in both directions (a buy fills above spot, a sell below), so its sign says nothing about
  // good or bad: colour it by size instead - quiet under 1%, amber from 1%, rose from 5%.
  const impactAbs = impact === undefined ? undefined : impact < 0n ? -impact : impact;
  const impactClass = impactAbs === undefined ? "" : impactAbs >= 500n ? "text-rose" : impactAbs >= 100n ? "text-amber" : "";
  const error = approveTx.error ?? tradeTx.error;

  if (status === 3 && chainId === 196) {
    return (
      <section className="panel p-6 lg:sticky lg:top-20">
        <h2 className="label mb-4">{t("meme.swap.title")}</h2>
        <Notice tone="amber">{t("meme.swap.mainnet")}</Notice>
      </section>
    );
  }

  return (
    <section className="panel flex h-full flex-col p-6 lg:sticky lg:top-20">
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-full bg-raised p-1">
        <button
          type="button"
          onClick={() => {
            setMode("buy");
            setInput("");
          }}
          aria-pressed={mode === "buy"}
          className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors duration-fast ${
            mode === "buy" ? "bg-knob text-verdigris shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-bone"
          }`}
        >
          {t("meme.trade.buy")}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("sell");
            setInput("");
          }}
          aria-pressed={mode === "sell"}
          className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors duration-fast ${
            mode === "sell" ? "bg-knob text-rose shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-bone"
          }`}
        >
          {t("meme.trade.sell")}
        </button>
      </div>

      <div className="relative">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && validTrade) onSubmit();
          }}
          inputMode="decimal"
          placeholder="0"
          className="num w-full rounded-full border border-line-strong bg-ink/50 py-3 pl-5 pr-20 text-[22px] outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-flare focus:ring-2 focus:ring-flare/20"
        />
        <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 num text-sm text-subtle">
          {spendSymbol}
        </span>
      </div>
      {parsed === null && <p className="mt-1 text-xs text-rose">{t("common.invalidAmount")}</p>}

      <div className="mt-2.5 flex gap-1.5">
        {([25n, 50n, 75n] as const).map((p) => (
          <button
            key={p.toString()}
            type="button"
            onClick={() => setPct(p, false)}
            className="num flex-1 rounded-full bg-raised py-1 text-xs text-muted transition-colors duration-fast hover:bg-knob hover:text-bone"
          >
            {p.toString()}%
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPct(100n, true)}
          className="num flex-1 rounded-full bg-raised py-1 text-xs text-muted transition-colors duration-fast hover:bg-knob hover:text-bone"
        >
          {t("meme.order.chipMax")}
        </button>
      </div>
      {/* both sides of the pair; the side being spent is brighter */}
      <div className="mt-3 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="label">{t("meme.order.wallet")}</span>
        <span className="num text-right text-subtle">
          <span className={mode === "buy" ? "text-bone" : undefined}>
            {formatAmount(quoteBal.data?.value, quoteMeta.decimals, { locale, maxFrac: 6 })} {quoteMeta.symbol}
          </span>
          <span className="mx-1.5 text-faint">·</span>
          <span className={mode === "sell" ? "text-bone" : undefined}>
            {formatAmount(memeBal.data?.value, memeDecimals, { locale, maxFrac: 2 })} {memeSymbol}
          </span>
        </span>
      </div>

      <dl className="mt-4 divide-y divide-line border-y border-line [&>div]:py-2">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="label">{t("meme.order.expect")}</dt>
          <dd className="num text-[13px]">
            {expectedOut !== undefined
              ? `${formatAmount(expectedOut, expectedDecimals, { locale })} ${expectedSymbol}`
              : "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="label">{t("meme.order.fee", { pct: fmtBps(totalFeeBps, locale) })}</dt>
          <dd className="num text-[13px]">
            {feeAmount !== undefined
              ? `${formatAmount(feeAmount, quoteMeta.decimals, { locale })} ${quoteMeta.symbol}`
              : "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="label">{t("meme.order.impact")}</dt>
          <dd
            className={`num text-[13px] ${impactClass}`}
          >
            {impactFmt?.text ?? "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="label">{t("meme.order.minOut")}</dt>
          <dd className="num text-[13px]">
            {minReceived !== undefined
              ? `${formatAmount(minReceived, expectedDecimals, { locale })} ${expectedSymbol}`
              : "—"}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">{t("meme.order.slippage")}</span>
        {SLIP_PRESETS.map((bps) => (
          <button
            key={bps}
            type="button"
            onClick={() => {
              setSlipCustom(false);
              setSlipBps(bps);
            }}
            aria-pressed={!slipCustom && slipBps === bps}
            className={`num h-6 rounded-full px-2.5 text-xs transition-colors duration-fast ${
              !slipCustom && slipBps === bps
                ? "bg-flare/10 font-medium text-flare"
                : "bg-raised text-muted hover:text-bone"
            }`}
          >
            {bps / 100}%
          </button>
        ))}
        {/* One control, two states: the Custom pill becomes the input in place, already focused, and picking a
            preset turns it back into the pill. The typed value is kept, so switching back to Custom restores it. */}
        {slipCustom ? (
          <label className="num inline-flex h-6 cursor-text items-stretch overflow-hidden rounded-full border border-flare/60 bg-ink/50 text-xs focus-within:border-flare focus-within:ring-2 focus-within:ring-flare/20">
            <input
              autoFocus
              value={customSlip}
              onChange={(e) => setCustomSlip(e.target.value.replace(/[^0-9.]/g, "").slice(0, 5))}
              inputMode="decimal"
              placeholder="1.5"
              aria-label={t("meme.order.slippageCustom")}
              className="w-12 bg-transparent pl-2.5 pr-1 text-left text-bone caret-flare outline-none placeholder:text-faint"
            />
            {/* the unit is an adornment in its own segment, not part of the editable text */}
            <span
              aria-hidden
              className="flex select-none items-center border-l border-line bg-raised px-2 text-subtle"
            >
              %
            </span>
          </label>
        ) : (
          <button
            type="button"
            onClick={() => setSlipCustom(true)}
            className="h-6 rounded-full bg-raised px-2.5 text-xs text-muted transition-colors duration-fast hover:text-bone"
          >
            {t("meme.order.slippageCustom")}
          </button>
        )}
      </div>

      {status === 3 && chainId === 1952 && (
        <Notice tone="amber" className="mt-3 text-xs">
          {t("meme.swap.notice")}
        </Notice>
      )}

      <div className="mt-auto pt-4">
        <Button
          // shows the phase of whichever write is running: the approval first, then the trade
          tx={approveTx.phase === "preparing" || approveTx.phase === "signing" || approveTx.phase === "confirming" ? approveTx : tradeTx}
          pending={connecting}
          disabled={ctaDisabled || pending || flash || (isConnected && !wrongChain && status === 3 && !TESTNET_SWAP_ROUTER)}
          onClick={onSubmit}
        >
          <span className="inline-flex items-center justify-center gap-1.5">
            {flash && <Sparkle size={12} tone="flare" twinkle />}
            {cta}
          </span>
        </Button>
        {error && (
          <Notice tone="rose" className="mt-3 break-all">
            {decodeErrorMessage(error, t)}
          </Notice>
        )}
      </div>
    </section>
  );
}
