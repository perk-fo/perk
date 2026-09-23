"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { parseUnits, zeroAddress, type Address } from "viem";

import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { TxStatus } from "@/components/TxStatus";
import { Permit2Approve, usePermit2Ready } from "@/components/Permit2Approve";
import { useT } from "@/i18n/provider";
import { useDeployment, useTx } from "@/lib/hooks";
import { useLpPositions } from "@/lib/api-hooks";
import { positionManagerAbi } from "@/generated/abis";
import {
  encodeBurn,
  encodeCollect,
  encodeMint,
  encodeUnlockData,
  fullRange,
  liquidityForAmounts,
  type PoolKey,
} from "@/lib/pool";
import { formatAmount } from "@/lib/format";

const DEADLINE_SECONDS = 600n;

/**
 * Add and manage liquidity in one graduated pool through the v4 PositionManager: mint a full-range position from
 * both assets, collect its fees, withdraw it. Positions are NFTs held by the wallet itself.
 */
export function LiquidityPanel({
  meme,
  poolKey,
  sqrtPriceX96,
  memeSymbol,
  quoteSymbol,
  quoteDecimals,
  memeDecimals,
}: {
  meme: Address;
  poolKey: PoolKey;
  sqrtPriceX96: bigint | null;
  memeSymbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  memeDecimals: number;
}) {
  const { t } = useT();
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const positionManager = deployment?.positionManager as Address | undefined;
  const permit2 = deployment?.permit2 as Address | undefined;

  const [memeAmount, setMemeAmount] = useState("");
  const [quoteAmount, setQuoteAmount] = useState("");
  const mintTx = useTx();
  const manageTx = useTx();
  const positions = useLpPositions(address);

  const memeIsCurrency0 = poolKey.currency0.toLowerCase() === meme.toLowerCase();
  const quoteIsNative = (memeIsCurrency0 ? poolKey.currency1 : poolKey.currency0) === zeroAddress;
  const quoteAddress = (memeIsCurrency0 ? poolKey.currency1 : poolKey.currency0) as Address;
  const range = useMemo(() => fullRange(poolKey.tickSpacing), [poolKey.tickSpacing]);

  const memeWei = safeParse(memeAmount, memeDecimals);
  const quoteWei = safeParse(quoteAmount, quoteDecimals);

  // What the pool will actually take, given the price and both maxima. Whichever side binds decides it.
  const liquidity = useMemo(() => {
    if (!sqrtPriceX96 || memeWei === null || quoteWei === null || (memeWei === 0n && quoteWei === 0n)) return 0n;
    const { tickLower, tickUpper } = range;
    return liquidityForAmounts({
      sqrtPriceX96,
      sqrtPriceAX96: tickToSqrtPrice(tickLower),
      sqrtPriceBX96: tickToSqrtPrice(tickUpper),
      amount0: memeIsCurrency0 ? memeWei : quoteWei,
      amount1: memeIsCurrency0 ? quoteWei : memeWei,
    });
  }, [sqrtPriceX96, memeWei, quoteWei, range, memeIsCurrency0]);

  const mine = (positions.data?.positions ?? []).filter(
    (p) => p.meme && p.meme.toLowerCase() === meme.toLowerCase(),
  );

  // both sides must be spendable through Permit2 before the mint can succeed (the native side needs nothing)
  const memeReady = usePermit2Ready(meme, permit2, positionManager, memeWei ?? 0n);
  const quoteReady = usePermit2Ready(quoteIsNative ? undefined : quoteAddress, permit2, positionManager, quoteIsNative ? 0n : (quoteWei ?? 0n));
  // The indexed figure is the liquidity at mint; increases and decreases emit no Transfer, so read it live.
  const liveLiquidity = useReadContracts({
    contracts: mine.map((p) => ({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "getPositionLiquidity" as const,
      args: [BigInt(p.tokenId)] as const,
    })),
    query: { enabled: !!positionManager && mine.length > 0 },
  });
  const ready = !!positionManager && !!address && liquidity > 0n && memeReady && quoteReady;

  function mint() {
    if (!positionManager || !address || memeWei === null || quoteWei === null) return;
    const { actions, params } = encodeMint({
      key: poolKey,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidity,
      amount0Max: memeIsCurrency0 ? memeWei : quoteWei,
      amount1Max: memeIsCurrency0 ? quoteWei : memeWei,
      owner: address,
    });
    mintTx.write(
      {
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "modifyLiquidities",
        args: [encodeUnlockData(actions, params), deadline()],
        value: quoteIsNative ? quoteWei : 0n,
      },
    );
  }

  function collect(tokenId: bigint) {
    if (!positionManager || !address) return;
    const { actions, params } = encodeCollect({ tokenId, key: poolKey, recipient: address });
    manageTx.write({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "modifyLiquidities",
        args: [encodeUnlockData(actions, params), deadline()],
    });
  }

  function withdraw(tokenId: bigint) {
    if (!positionManager || !address) return;
    // Burning takes principal and accrued fees together and closes the position.
    const { actions, params } = encodeBurn({ tokenId, key: poolKey, amount0Min: 0n, amount1Min: 0n, recipient: address });
    manageTx.write({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: "modifyLiquidities",
        args: [encodeUnlockData(actions, params), deadline()],
    });
  }

  // a mined, non-reverted mint clears the form and refreshes the list; the same for manage actions
  useEffect(() => {
    if (!mintTx.isSuccess) return;
    setMemeAmount("");
    setQuoteAmount("");
    void positions.refetch();
  }, [mintTx.isSuccess]);
  useEffect(() => {
    if (manageTx.isSuccess) void positions.refetch();
  }, [manageTx.isSuccess]);

  return (
    <Panel title={t("pool.lp.title")}>
      <p className="mb-4 text-sm text-muted">{t("pool.lp.intro")}</p>

      {!sqrtPriceX96 ? (
        <Notice tone="amber" title={t("pool.lp.noPriceTitle")}>
          {t("pool.lp.noPriceBody")}
        </Notice>
      ) : (
        <div className="space-y-4">
          <Field
            label={memeSymbol}
            value={memeAmount}
            onChange={(e) => setMemeAmount(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            numeric
          />
          <Field
            label={quoteSymbol}
            value={quoteAmount}
            onChange={(e) => setQuoteAmount(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            numeric
            hint={t("pool.lp.rangeHint")}
          />

          <div className="flex flex-wrap items-center gap-2">
            {!quoteIsNative && positionManager && permit2 && quoteWei !== null && quoteWei > 0n ? (
              <Permit2Approve token={quoteAddress} permit2={permit2} spender={positionManager} needed={quoteWei} symbol={quoteSymbol} />
            ) : null}
            {positionManager && permit2 && memeWei !== null && memeWei > 0n ? (
              <Permit2Approve token={meme} permit2={permit2} spender={positionManager} needed={memeWei} symbol={memeSymbol} />
            ) : null}
            <Button onClick={mint} disabled={!ready || mintTx.isPending || mintTx.isConfirming} tx={mintTx}>
              {t("pool.lp.add")}
            </Button>
          </div>
          <TxStatus tx={mintTx} successText={t("pool.lp.added")} />
        </div>
      )}

      <div className="mt-6 border-t border-line pt-4">
        <h3 className="mb-3 text-sm text-bone">{t("pool.lp.mine")}</h3>
        {!address ? (
          <p className="text-sm text-subtle">{t("pool.lp.connect")}</p>
        ) : mine.length === 0 ? (
          <p className="text-sm text-subtle">{t("pool.lp.none")}</p>
        ) : (
          <ul className="space-y-2">
            {mine.map((p, i) => (
              <li
                key={p.tokenId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line px-3 py-2"
              >
                <span className="num text-xs text-muted">
                  #{p.tokenId} · {t("pool.lp.liquidity")}{" "}
                  {formatAmount((liveLiquidity.data?.[i]?.result as bigint | undefined) ?? BigInt(p.liquidity), 0, { maxFrac: 0 })}
                </span>
                <span className="flex gap-2">
                  <Button variant="ghost" onClick={() => collect(BigInt(p.tokenId))} disabled={manageTx.isPending}>
                    {t("pool.lp.collect")}
                  </Button>
                  <Button variant="ghost" onClick={() => withdraw(BigInt(p.tokenId))} disabled={manageTx.isPending}>
                    {t("pool.lp.withdraw")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <TxStatus tx={manageTx} successText={t("pool.lp.done")} />
      </div>
    </Panel>
  );
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;
}

function safeParse(v: string, decimals: number): bigint | null {
  const s = v.trim();
  if (!s) return 0n;
  try {
    return parseUnits(s, decimals);
  } catch {
    return null;
  }
}

/** sqrt(1.0001^tick) * 2^96, by the same halving expansion Uniswap's TickMath uses. */
function tickToSqrtPrice(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  let ratio =
    (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const factors: Array<[bigint, bigint]> = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of factors) {
    if ((abs & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = (1n << 256n) / ratio - 1n;
  // Q128.128 -> Q64.96, rounding up so the result never understates the price.
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}
