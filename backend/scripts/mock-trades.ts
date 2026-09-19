/**
 * Testnet-only market simulator: role wallets (TEST_MNEMONIC in .env.dev) trade a set of launches at a steady pace so
 * charts have realistic history. Refuses chainId 196. Keys are never printed.
 *
 *   bun scripts/mock-trades.ts [--memes 0x..,0x..] [--rounds 150] [--every 15]
 *
 * Each round picks one target at random. Curve launches (status 1) trade on the bonding curve in their quote token
 * (ERC-20 or native) and are kept between ~35% and ~85% of the graduation threshold, so they never graduate.
 * Graduated launches (status 3, native quote) trade through the v4 PoolSwapTest router in both directions. Launches
 * in any other state are skipped. Each target has its own slowly drifting buy pressure so charts trend and reverse.
 * Sells are sized like buys (by quote value), never as a fraction of a bag: a creator's dev-buy bag can be larger than
 * the whole pool, and dumping part of it crashes the price 90% in one trade.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, erc20Abi, http, maxUint256, parseEther,
  type Address, type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { bondingCurveAbi, graduationManagerAbi, poolSwapTestAbi } from "../src/generated/abis";

const repo = join(import.meta.dir, "..", "..");
const env = Object.fromEntries(
  readFileSync(join(repo, ".env.dev"), "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\n]*)"?/)).filter(Boolean).map((m) => [m![1], m![2].trim()]),
);
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

const RPC = arg("rpc", "https://testrpc.xlayer.tech")!;
const dep = JSON.parse(readFileSync(join(repo, "contracts/deployments/1952.json"), "utf8"));
const chain = defineChain({ id: 1952, name: "X Layer Testnet", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

const DEFAULT_MEMES = "0x006c6cF4d63c5176187651f3CfEfF75a1a59D5c7,0x22e17b83eec31787fdcac93bba5ab54edb3290be"; // Quiet Whale (curve), Stone Duck (pool)
const MEMES = arg("memes", DEFAULT_MEMES)!.split(",").map((m) => m.trim() as Address);
const ROUNDS = Number(arg("rounds", "150"));
const EVERY = Number(arg("every", "15")) * 1000;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const MINT_ABI = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;

type Target =
  | { kind: "curve"; meme: Address; quote: Address; native: boolean; threshold: bigint; regime: number }
  | { kind: "pool"; meme: Address; key: any; memePerQuote: number; regime: number };

if (!env.TEST_MNEMONIC || !env.DEPLOYER_PRIVATE_KEY) throw new Error(".env.dev needs TEST_MNEMONIC and DEPLOYER_PRIVATE_KEY");
const wallets = [0, 1, 4, 5].map((i) => createWalletClient({ chain, transport: http(RPC), account: mnemonicToAccount(env.TEST_MNEMONIC, { addressIndex: i }) }));
const deployer = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex) });

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pct = (x: bigint, p: number) => (x * BigInt(Math.round(p * 10_000))) / 10_000n;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), ...o }));

async function send(w: (typeof wallets)[number], req: any): Promise<Hex> {
  const hash = await w.writeContract({ ...req, chain, account: w.account });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return hash;
}
async function ensureAllowance(w: (typeof wallets)[number], token: Address, spender: Address) {
  const a = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [w.account.address, spender] });
  if (a < maxUint256 / 2n) await send(w, { address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
}

async function main() {
  if ((await pub.getChainId()) === 196) throw new Error("refusing to run against mainnet");
  const curve = dep.curve as Address, router = env.V4_TESTNET_SWAP_ROUTER as Address;

  const targets: Target[] = [];
  for (const meme of MEMES) {
    const g = (await pub.readContract({ address: dep.graduationManager, abi: graduationManagerAbi, functionName: "graduationOf", args: [meme] })) as any;
    const cfg = (await pub.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveConfig", args: [meme] })) as any;
    const st = (await pub.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveState", args: [meme] })) as any;
    if (g.key.hooks !== ZERO && Number(g.stage) > 0) {
      if (g.key.currency0 !== ZERO) { log({ skip: meme, why: "pool quote is not native" }); continue; }
      targets.push({ kind: "pool", meme, key: g.key, memePerQuote: 0, regime: 0.55 });
    } else if (!st.graduated) {
      targets.push({ kind: "curve", meme, quote: cfg.quote, native: cfg.quote === ZERO, threshold: cfg.graduationQuoteThreshold, regime: 0.55 });
    } else {
      log({ skip: meme, why: "curve closed, not graduated yet" });
    }
  }
  if (targets.length === 0) throw new Error("nothing to trade");
  log({ targets: targets.map((t) => `${t.kind}:${t.meme}`) });

  // funding: OKB for gas + native buys, quote tokens for curve buys (testnet mocks have public mint), approvals
  const erc20Quotes = [...new Set(targets.flatMap((t) => (t.kind === "curve" && !t.native ? [t.quote] : [])))];
  for (const w of wallets) {
    const bal = await pub.getBalance({ address: w.account.address });
    if (bal < parseEther("0.01")) {
      const hash = await deployer.sendTransaction({ to: w.account.address, value: parseEther("0.02"), chain, account: deployer.account });
      await pub.waitForTransactionReceipt({ hash });
    }
    for (const q of erc20Quotes) {
      const dec = await pub.readContract({ address: q, abi: erc20Abi, functionName: "decimals" });
      const qb = await pub.readContract({ address: q, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] });
      if (qb < 10n ** BigInt(dec)) await send(deployer as any, { address: q, abi: MINT_ABI, functionName: "mint", args: [w.account.address, 10n * 10n ** BigInt(dec)] });
      await ensureAllowance(w, q, curve);
    }
    for (const t of targets) await ensureAllowance(w, t.meme, t.kind === "curve" ? curve : router);
  }

  for (let r = 0; r < ROUNDS; r++) {
    const tg = targets[Math.floor(Math.random() * targets.length)];
    tg.regime = Math.min(0.8, Math.max(0.25, tg.regime + rnd(-0.08, 0.08)));
    const w = wallets[Math.floor(Math.random() * wallets.length)];
    try {
      const held = await pub.readContract({ address: tg.meme, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] });
      if (tg.kind === "curve") {
        const st = (await pub.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveState", args: [tg.meme] })) as any;
        if (st.graduated) { log({ r, skip: tg.meme, why: "curve closed" }); continue; }
        const progress = Number((st.realQuote * 10_000n) / tg.threshold) / 10_000;
        const buy = progress < 0.35 || held === 0n || (progress < 0.85 && Math.random() < tg.regime);
        const q = pct(tg.threshold, rnd(0.005, 0.03));
        if (buy) {
          const hash = await send(w, { address: curve, abi: bondingCurveAbi, functionName: "buy", args: [tg.meme, q, 0n, w.account.address], value: tg.native ? q : 0n });
          log({ r, meme: tg.meme, where: "curve", side: "buy", quote: q.toString(), progress, hash });
        } else {
          const [perQ] = (await pub.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [tg.meme, q] })) as readonly [bigint, bigint, bigint];
          const m = held < perQ ? held : perQ;
          const hash = await send(w, { address: curve, abi: bondingCurveAbi, functionName: "sell", args: [tg.meme, m, 0n, w.account.address] });
          log({ r, meme: tg.meme, where: "curve", side: "sell", meme_in: m.toString(), progress, hash });
        }
      } else {
        const buy = held === 0n || tg.memePerQuote === 0 || Math.random() < tg.regime;
        const q = parseEther(rnd(0.00005, 0.0004).toFixed(6));
        const sized = BigInt(Math.floor(Number(q) * tg.memePerQuote));
        const amt = buy ? q : held < sized ? held : sized;
        const zeroForOne = buy; // currency0 is native: spend it to buy, spend meme (currency1) to sell
        const hash = await send(w, {
          address: router, abi: poolSwapTestAbi, functionName: "swap",
          args: [tg.key, { zeroForOne, amountSpecified: -amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x"],
          value: buy ? amt : 0n,
        });
        if (buy) {
          const after = await pub.readContract({ address: tg.meme, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] });
          tg.memePerQuote = Number(after - held) / Number(amt);
        }
        log({ r, meme: tg.meme, where: "pool", side: buy ? "buy" : "sell", amount: amt.toString(), hash });
      }
    } catch (e) {
      log({ r, meme: tg.meme, error: (e as Error).message.split("\n")[0] });
    }
    await new Promise((res) => setTimeout(res, EVERY * rnd(0.5, 1.5)));
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
