import { Hono } from "hono";
import { addressParam, type AppEnv } from "../server";
import type { WalletRoles,
  LpPosition, WalletSummary } from "../types";
import { mapGrantPosition, mapLaunchSummary, mapTrade, mapWalletRoles,
  mapLpPosition } from "../mappers";
import { addr, num, uint } from "../serialize";
import {
  selectLaunchesByMemes,
  selectPositionsForWallet,
  selectLpPositionsForWallet,
  selectWalletClaims,
  selectWalletHoldings,
  selectWalletRoleBits,
  selectWalletTrades,
} from "../queries";

/**
 * GET /v1/wallets/:address/roles → WalletRoles — max-age 5.
 *   isAdmin = address ∈ config.adminAddresses; creatorOf from launches.creator; lpOf from grant_positions;
 *   allocatedIn from grant_allocations; inviter/optInBlock from referrals/opt_ins.
 * GET /v1/wallets/:address → WalletSummary (roles + launches + positions + last 20 trades + claims + holdings) — max-age 5.
 */
export function walletRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/:address/roles", async (c) => {
    const { db, config } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const bits = await selectWalletRoleBits(db, config.chainId, address);
    const isAdmin = config.adminAddresses.some((a) => a.toLowerCase() === address);
    c.header("Cache-Control", "public, max-age=5");
    return c.json<WalletRoles>(
      mapWalletRoles(address, isAdmin, bits.creatorOf, bits.lpOf, bits.allocatedIn, bits.inviter, bits.optInBlock),
    );
  });
  // Ordinary LP positions, kept on their own path so a client can ask for them without the whole wallet payload.
  r.get("/:address/lp-positions", async (c) => {
    const { db, config } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const rows = await selectLpPositionsForWallet(db, config.chainId, address);
    c.header("Cache-Control", "public, max-age=5");
    return c.json<{ positions: LpPosition[] }>({ positions: rows.map(mapLpPosition) });
  });

  r.get("/:address", async (c) => {
    const { db, config } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const now = Math.floor(Date.now() / 1000);
    const bits = await selectWalletRoleBits(db, config.chainId, address);
    const isAdmin = config.adminAddresses.some((a) => a.toLowerCase() === address);
    const roles = mapWalletRoles(
      address,
      isAdmin,
      bits.creatorOf,
      bits.lpOf,
      bits.allocatedIn,
      bits.inviter,
      bits.optInBlock,
    );
    const [launchRows, positions, recentTrades, claims, holdingRows] = await Promise.all([
      selectLaunchesByMemes(db, config.chainId, bits.creatorOf, now),
      selectPositionsForWallet(db, config.chainId, address),
      selectWalletTrades(db, config.chainId, address, 20),
      selectWalletClaims(db, config.chainId, address),
      selectWalletHoldings(db, config.chainId, address, now),
    ]);
    c.header("Cache-Control", "public, max-age=5");
    return c.json<WalletSummary>({
      ...roles,
      tradeCount: bits.tradeCount,
      launches: launchRows.map(mapLaunchSummary),
      positions: positions.map(mapGrantPosition),
      recentTrades: recentTrades.map(mapTrade),
      claims: claims.map((cl) => ({
        meme: addr(cl.meme),
        kind: cl.kind === "dev_fees" ? "dev_fees" : "quote_rewards",
        amount: uint(cl.amount),
        timestamp: num(cl.ts),
        txHash: cl.tx_hash.toLowerCase() as `0x${string}`,
      })),
      inviteeCount: bits.inviteeCount,
      referralCreditsEarned: bits.referralCreditsEarned,
      holdings: holdingRows.map((r) => ({ launch: mapLaunchSummary(r), balance: uint(r.balance) })),
    });
  });
  return r;
}

export type { WalletRoles, WalletSummary };
