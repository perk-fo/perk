/**
 * The on-chain actions the driver performs. Every one is written so that repeating it is either harmless or skipped,
 * because the driver may be restarted between sending a transaction and recording it.
 */
import {
  encodePacked,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
  type Account as ViemAccount,
  type Address,
  type Hex,
} from "viem";
import {
  bondingCurveAbi,
  templateRegistryAbi,
  graduationManagerAbi,
  launchFactoryAbi,
  lpGrantVaultAbi,
  perkMemeTokenAbi,
  poolSwapTestAbi,
  referralRegistryAbi,
} from "../../../backend/src/generated/abis";
import type { DriverConfig } from "./config";
import type { TokenSpec } from "./plan";

const MIN_SQRT_PRICE = 4295128739n + 1n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n - 1n;

/** Any locally-signing demo wallet: the deployer (private key) or one derived from the test mnemonic. */
export type Account = Extract<ViemAccount, { type: "local" }>;

export function templateId(name: string): Hex {
  return keccak256(new TextEncoder().encode(name));
}

/**
 * Quote-bound template id, mirroring PerkTemplates.templateIdFor: native keeps the base id, an ERC-20 quote gets its
 * own template with the curve numbers rescaled to that token's decimals.
 */
export function templateIdFor(baseId: Hex, quote: Address): Hex {
  if (quote === zeroAddress) return baseId;
  return keccak256(encodePacked(["bytes32", "address"], [baseId, quote]));
}

/** The graduation threshold for a quote, in that quote's own units. Used to size dev buys and trades. */
export async function templateThreshold(cfg: DriverConfig, quoteKey: string): Promise<bigint> {
  const quote = quoteAddress(cfg, quoteKey);
  const tmpl = await cfg.publicClient.readContract({
    address: cfg.deployment.templateRegistry,
    abi: templateRegistryAbi,
    functionName: "getTemplate",
    args: [templateIdFor(templateId(cfg.templateName), quote)],
  });
  return tmpl.curve.graduationQuoteThreshold;
}

/** Resolve a plan's quote key to an address: "native" is OKB, anything else indexes deployment.quoteAssets. */
export function quoteAddress(cfg: DriverConfig, key: string): Address {
  if (key === "native") return zeroAddress;
  const addr = cfg.deployment.quoteAssets?.[key];
  if (!addr) throw new Error(`quote asset ${key} is not in the deployment file`);
  return addr;
}

async function send(cfg: DriverConfig, account: Account, request: unknown): Promise<Hex> {
  const hash = await cfg.wallet(account).writeContract(request as never);
  await cfg.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  return hash;
}

/** Simulate then send, so a revert surfaces as a clear error instead of a burnt transaction. */
export async function call(
  cfg: DriverConfig,
  account: Account,
  args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
    /** Explicit gas limit. Needed where estimation is unreliable — see `graduate`. */
    gas?: bigint;
  },
): Promise<Hex> {
  const { request } = await cfg.publicClient.simulateContract({
    account,
    address: args.address,
    abi: args.abi as never,
    functionName: args.functionName as never,
    args: (args.args ?? []) as never,
    value: args.value,
    ...(args.gas === undefined ? {} : { gas: args.gas }),
  } as never);
  return send(cfg, account, request);
}

// ---------------------------------------------------------------------------
// funding and eligibility
// ---------------------------------------------------------------------------

/** Tops every demo wallet up to `target` OKB from the deployer. Skips wallets that already hold enough. */
export async function fundWallets(cfg: DriverConfig, target: bigint, log: (m: string) => void): Promise<void> {
  // the grant publisher needs gas too; it never needs the ERC-20 quote assets
  const wallets = [cfg.creator, ...cfg.traders, ...cfg.participants, cfg.publisher];
  for (const w of wallets) {
    const balance = await cfg.publicClient.getBalance({ address: w.address });
    if (balance >= target) continue;
    const topUp = target - balance;
    const hash = await cfg.wallet(cfg.deployer).sendTransaction({
      account: cfg.deployer,
      chain: cfg.chain,
      to: w.address,
      value: topUp,
    });
    await cfg.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    log(`funded ${w.address} with ${topUp} wei`);
  }
}

const MOCK_ERC20_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Tops every demo wallet up with each ERC-20 quote asset. The testnet mocks expose a public `mint`, so no faucet is
 * needed; on a network where they did not, this would become a transfer from a funded treasury wallet instead.
 */
export async function fundQuoteAssets(cfg: DriverConfig, log: (m: string) => void): Promise<void> {
  const assets = Object.entries(cfg.deployment.quoteAssets ?? {});
  if (assets.length === 0) return;
  const wallets = [cfg.creator, ...cfg.traders, ...cfg.participants];
  for (const [name, token] of assets) {
    const decimals = await cfg.publicClient.readContract({ address: token, abi: MOCK_ERC20_ABI, functionName: "decimals" });
    const target = 10_000n * 10n ** BigInt(decimals);
    for (const w of wallets) {
      const bal = await cfg.publicClient.readContract({
        address: token,
        abi: MOCK_ERC20_ABI,
        functionName: "balanceOf",
        args: [w.address],
      });
      if (bal >= target / 4n) continue;
      await call(cfg, w, { address: token, abi: MOCK_ERC20_ABI, functionName: "mint", args: [w.address, target] });
      log(`minted ${name} to ${w.address}`);
    }
  }
}

/**
 * Grant eligibility for a native-OKB quote comes from the opt-in registry, and only counts when the opt-in block is
 * at or before the campaign's graduation block — so this has to happen before any token graduates.
 */
export async function optInParticipants(cfg: DriverConfig, log: (m: string) => void): Promise<string[]> {
  const done: string[] = [];
  for (const [i, p] of cfg.participants.entries()) {
    const block = await cfg.publicClient.readContract({
      address: cfg.deployment.referralRegistry,
      abi: referralRegistryAbi,
      functionName: "optInBlock",
      args: [p.address],
    });
    if (block === 0n) {
      // the first participant is nobody's invitee; the rest are invited by the first, which exercises the boost
      if (i === 0) {
        await call(cfg, p, {
          address: cfg.deployment.referralRegistry,
          abi: referralRegistryAbi,
          functionName: "optIn",
        });
      } else {
        await call(cfg, p, {
          address: cfg.deployment.referralRegistry,
          abi: referralRegistryAbi,
          functionName: "optInWithInviter",
          args: [cfg.participants[0]!.address],
        });
      }
      log(`opted in ${p.address}`);
    }
    done.push(p.address);
  }
  return done;
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

export interface LaunchResult {
  meme: Address;
  tx: Hex;
}

export async function launchToken(
  cfg: DriverConfig,
  spec: TokenSpec,
  uri: string,
  devBuy: bigint,
): Promise<LaunchResult> {
  const quote = quoteAddress(cfg, spec.quote);
  const base = {
    // an ERC-20 quote has its own template, with the curve numbers rescaled to that token's decimals
    templateId: templateIdFor(templateId(cfg.templateName), quote),
    quote,
    moduleParams: "0x" as Hex,
    expectedConfigHash: `0x${"00".repeat(32)}` as Hex,
    metadata: { name: spec.name, symbol: spec.symbol, uri },
    devBuyQuote: devBuy,
    salt: spec.salt as Hex,
  };
  const [predictedMeme, , , configHash] = await cfg.publicClient.readContract({
    address: cfg.deployment.factory,
    abi: launchFactoryAbi,
    functionName: "previewLaunch",
    args: [base],
    account: cfg.creator,
  });
  const params = { ...base, expectedConfigHash: configHash };
  if (quote !== zeroAddress && devBuy > 0n) {
    await call(cfg, cfg.creator, {
      address: quote,
      abi: perkMemeTokenAbi,
      functionName: "approve",
      args: [cfg.deployment.factory, devBuy],
    });
  }
  const tx = await call(cfg, cfg.creator, {
    address: cfg.deployment.factory,
    abi: launchFactoryAbi,
    functionName: "createLaunch",
    args: [params],
    value: quote === zeroAddress ? devBuy : 0n,
  });
  return { meme: predictedMeme, tx };
}

// ---------------------------------------------------------------------------
// curve trading
// ---------------------------------------------------------------------------

/**
 * The launch's own status (1 CURVE_ACTIVE, 2 GRADUATION_PENDING, 3 GRADUATED). This, not `progressBps`, is the
 * authoritative signal: the curve zeroes its progress the moment it graduates, so a driver that waits for
 * `progressBps >= 10000` can miss the transition and never see it again.
 */
export async function launchStatus(cfg: DriverConfig, meme: Address): Promise<number> {
  const rec = await cfg.publicClient.readContract({
    address: cfg.deployment.factory,
    abi: launchFactoryAbi,
    functionName: "getLaunch",
    args: [meme],
  });
  return Number(rec.status);
}

export async function memeBalance(cfg: DriverConfig, meme: Address, holder: Address): Promise<bigint> {
  return cfg.publicClient.readContract({
    address: meme,
    abi: perkMemeTokenAbi,
    functionName: "balanceOf",
    args: [holder],
  });
}

export async function progressBps(cfg: DriverConfig, meme: Address): Promise<number> {
  const bps = await cfg.publicClient.readContract({
    address: cfg.deployment.curve,
    abi: bondingCurveAbi,
    functionName: "progressBps",
    args: [meme],
  });
  return Number(bps);
}

export async function curveThresholdQuote(cfg: DriverConfig, meme: Address): Promise<bigint> {
  const cfgTuple = (await cfg.publicClient.readContract({
    address: cfg.deployment.curve,
    abi: bondingCurveAbi,
    functionName: "curveConfig",
    args: [meme],
  })) as { graduationQuoteThreshold: bigint };
  return cfgTuple.graduationQuoteThreshold;
}

/**
 * One curve trade, sized so the launch tracks `targetBps` of the way to graduation. Buying when behind and selling a
 * little when ahead keeps the chart two-sided while still guaranteeing the token graduates near the end of its window.
 */
export async function curveTrade(
  cfg: DriverConfig,
  meme: Address,
  quoteKey: string,
  trader: Account,
  targetBps: number,
  rand: () => number,
  log: (m: string) => void,
): Promise<void> {
  const quote = quoteAddress(cfg, quoteKey);
  const current = await progressBps(cfg, meme);
  const threshold = await curveThresholdQuote(cfg, meme);
  const behind = targetBps - current;

  if (behind <= 0 && rand() < 0.55) {
    // ahead of schedule: take a little back off the table so the chart is not a straight line up
    const balance = await cfg.publicClient.readContract({
      address: meme,
      abi: perkMemeTokenAbi,
      functionName: "balanceOf",
      args: [trader.address],
    });
    if (balance > 0n) {
      const amount = (balance * BigInt(5 + Math.floor(rand() * 20))) / 100n;
      if (amount > 0n) {
        await call(cfg, trader, {
          address: meme,
          abi: perkMemeTokenAbi,
          functionName: "approve",
          args: [cfg.deployment.curve, amount],
        });
        await call(cfg, trader, {
          address: cfg.deployment.curve,
          abi: bondingCurveAbi,
          functionName: "sell",
          args: [meme, amount, 0n, trader.address],
        });
        log(`sell ${meme} ${amount} meme (progress ${current}bps, target ${targetBps})`);
        return;
      }
    }
  }

  // buy enough to reach the target, with a little noise and headroom for the curve fee
  const deficit = Math.max(behind, 40);
  const spend = (threshold * BigInt(Math.round(deficit * (0.9 + 0.35 * rand()) * 100))) / 1_000_000n;
  const amount = spend > 0n ? spend : threshold / 200n;
  if (quote !== zeroAddress) {
    await call(cfg, trader, {
      address: quote,
      abi: perkMemeTokenAbi,
      functionName: "approve",
      args: [cfg.deployment.curve, amount],
    });
  }
  await call(cfg, trader, {
    address: cfg.deployment.curve,
    abi: bondingCurveAbi,
    functionName: "buy",
    args: [meme, amount, 0n, trader.address],
    value: quote === zeroAddress ? amount : 0n,
  });
  log(`buy ${meme} ${amount} quote (progress ${current}bps, target ${targetBps})`);
}

// ---------------------------------------------------------------------------
// graduation and pool trading
// ---------------------------------------------------------------------------

/**
 * Drives a launch all the way through graduation.
 *
 * `graduate` runs the stages in a loop of self-calls and *swallows* a stage that fails (`if (!ok) break`). That makes
 * `eth_estimateGas` useless here: estimation takes the break, so the figure it returns — around 430k — is only enough
 * to reach the failure, never enough to run the last stage, which mints the position NFT and opens the grant
 * campaign. A caller that trusts the estimate leaves the launch stuck at LIQUIDITY_ADDED with no pool and no
 * campaign, which is exactly what happened the first time this ran. So the gas limit is set explicitly.
 */
const GRADUATE_GAS = 6_000_000n;

export async function graduate(cfg: DriverConfig, meme: Address, log: (m: string) => void = () => {}): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const g = await graduationOf(cfg, meme);
    if (Number(g.stage) === 4 /* DONE */) return;
    await call(cfg, cfg.deployer, {
      address: cfg.deployment.graduationManager,
      abi: graduationManagerAbi,
      functionName: "graduate",
      args: [meme],
      gas: GRADUATE_GAS,
    });
    log(`graduation step ${i + 1} for ${meme} (stage was ${Number(g.stage)})`);
  }
  const final = await graduationOf(cfg, meme);
  if (Number(final.stage) !== 4) throw new Error(`graduation stalled at stage ${Number(final.stage)} for ${meme}`);
}

export async function graduationOf(cfg: DriverConfig, meme: Address) {
  return cfg.publicClient.readContract({
    address: cfg.deployment.graduationManager,
    abi: graduationManagerAbi,
    functionName: "graduationOf",
    args: [meme],
  });
}

/** A swap against the graduated v4 pool, so the post-graduation chart keeps moving. */
export async function poolSwap(
  cfg: DriverConfig,
  meme: Address,
  trader: Account,
  buy: boolean,
  /** quote-denominated when buying, meme-denominated when selling: the two sides have different decimals */
  amount: bigint,
  log: (m: string) => void,
): Promise<void> {
  const router = process.env.V4_TESTNET_SWAP_ROUTER as Address | undefined;
  if (!router) return;
  const g = await graduationOf(cfg, meme);
  const key = g.key;
  const quoteIsCurrency0 = key.currency0 !== meme;
  const zeroForOne = buy ? quoteIsCurrency0 : !quoteIsCurrency0;
  // Whichever token is being paid in has to be approved to the router first. Only the sell side was covered here,
  // so every buy against an ERC-20-quoted pool reverted inside the PoolManager and those pools simply stopped
  // producing trades.
  const payingWith = buy ? (quoteIsCurrency0 ? key.currency0 : key.currency1) : meme;
  if (payingWith !== zeroAddress) {
    await call(cfg, trader, {
      address: payingWith as Address,
      abi: perkMemeTokenAbi,
      functionName: "approve",
      args: [router, amount],
    });
  }
  await call(cfg, trader, {
    address: router,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      key,
      { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
    value: buy && payingWith === zeroAddress ? amount : 0n,
  });
  log(`pool ${buy ? "buy" : "sell"} ${meme} ${amount}`);
}

// ---------------------------------------------------------------------------
// grant cadence
// ---------------------------------------------------------------------------

export async function campaign(cfg: DriverConfig, meme: Address) {
  return cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "campaign",
    args: [meme],
  });
}

export async function proposeRoot(
  cfg: DriverConfig,
  meme: Address,
  root: Hex,
  uri: string,
  totalBase: bigint,
  totalBoost: bigint,
): Promise<Hex> {
  return call(cfg, cfg.publisher, {
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "proposeRoot",
    args: [meme, root, uri, totalBase, totalBoost],
  });
}

export async function activateRoot(cfg: DriverConfig, meme: Address): Promise<Hex> {
  return call(cfg, cfg.publisher, {
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "activateRoot",
    args: [meme],
  });
}

export async function finalizeGrant(cfg: DriverConfig, meme: Address): Promise<Hex> {
  return call(cfg, cfg.publisher, {
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "finalizeGrant",
    args: [meme],
  });
}

export { parseEther, toHex };
