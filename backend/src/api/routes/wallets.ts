import { Hono } from "hono";
import { addressParam, intParam, type AppEnv } from "../server";
import type { WalletRoles,
  LpPosition, WalletSummary, WalletTradesPage } from "../types";
import { mapGrantPosition, mapLaunchSummary, mapTrade, mapWalletRoles,
  mapLpPosition, mapWalletTrade } from "../mappers";
import { addr, num, uint } from "../serialize";
import { displayRoleHolders, selectAdminRoles } from "../../admin/roles";
import {
  parseTradeCursor,
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
 *   adminRoles: "core" / "grant" from the contracts' owner and grant publisher (read from the chain, or from the index
 *   while the chain cannot be read), "operator" from the General Admins the Core Admin appointed; isAdmin = any of them.
 *   What it shows only decides what the web app displays: every admin action checks the roles again on the chain.
 *   creatorOf from launches.creator; lpOf from grant_positions; allocatedIn from grant_allocations;
 *   inviter/optInBlock from referrals/opt_ins.
 * GET /v1/wallets/:address → WalletSummary (roles + launches + positions + last 20 trades + claims + holdings) — max-age 5.
 * GET /v1/wallets/:address/trades?limit=50&before=<block>:<logIndex> → WalletTradesPage: the wallet's trades across
 *   every meme, newest first, with the launch of each meme traded on the page — max-age 5.
 */
export function walletRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/:address/roles", async (c) => {
    const { db, config, roles: reader } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const [bits, adminRoles] = await Promise.all([
      selectWalletRoleBits(db, config.chainId, address),
      displayRoleHolders(db, config.chainId, reader).then((h) => selectAdminRoles(db, config.chainId, address, h)),
    ]);
    c.header("Cache-Control", "public, max-age=5");
    return c.json<WalletRoles>(
      mapWalletRoles(address, adminRoles, bits.creatorOf, bits.lpOf, bits.allocatedIn, bits.inviter, bits.optInBlock),
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

  r.get("/:address/trades", async (c) => {
    const { db, config } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const limit = intParam(c.req.query("limit"), 50, 1, 200, "limit");
    const cursor = parseTradeCursor(c.req.query("before"));
    const now = Math.floor(Date.now() / 1000);
    const rows = await selectWalletTrades(db, config.chainId, address, limit, cursor);
    const memes = [...new Set(rows.map((t) => t.meme.toLowerCase()))];
    const launchRows = await selectLaunchesByMemes(db, config.chainId, memes, now);
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last ? `${Number(last.block_number)}:${Number(last.log_index)}` : null;
    c.header("Cache-Control", "public, max-age=5");
    return c.json<WalletTradesPage>({
      trades: rows.map(mapWalletTrade),
      launches: launchRows.map(mapLaunchSummary),
      nextCursor,
    });
  });

  r.get("/:address", async (c) => {
    const { db, config, roles: reader } = c.get("deps");
    const address = addressParam(c.req.param("address"));
    const now = Math.floor(Date.now() / 1000);
    const [bits, adminRoles] = await Promise.all([
      selectWalletRoleBits(db, config.chainId, address),
      displayRoleHolders(db, config.chainId, reader).then((h) => selectAdminRoles(db, config.chainId, address, h)),
    ]);
    const roles = mapWalletRoles(
      address,
      adminRoles,
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

export type { WalletRoles, WalletSummary, WalletTradesPage };
