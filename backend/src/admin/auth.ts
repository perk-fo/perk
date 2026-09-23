import { createHash, randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Db } from "../db/client";
import type { Client } from "../chain/rpc";

/**
 * Admin sign-in (EIP-4361, "Sign-In with Ethereum"). The API writes the message, the wallet signs it, and the API
 * checks the signature and hands out a session token. Nothing here grants a role: roles are looked up on every
 * request (`selectAdminRoles`), so removing a General Admin or moving contract ownership takes effect at once.
 *
 *   nonce: single use, bound to the address and to the site that asked (the message names that site, so a wallet
 *          warns when another site shows it), valid for NONCE_TTL_MS.
 *   session: a random 32-byte token, stored only as its SHA-256; valid for SESSION_TTL_MS.
 */
export const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 12 * 3_600_000;

const STATEMENT = "Sign in to the Perk admin. This is not a transaction and costs no gas.";

export class AuthError extends Error {
  constructor(
    readonly code: "nonce_unknown" | "nonce_expired" | "bad_message" | "bad_signature",
    message: string,
  ) {
    super(message);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Write a sign-in message for `address`, to be signed on the site at `origin`. */
export async function issueNonce(
  db: Db,
  opts: { address: string; chainId: number; origin: string; now?: Date },
): Promise<{ message: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  const site = new URL(opts.origin);
  const nonce = generateSiweNonce();
  const message = createSiweMessage({
    address: getAddress(opts.address),
    chainId: opts.chainId,
    domain: site.host,
    uri: site.origin,
    nonce,
    version: "1",
    statement: STATEMENT,
    issuedAt: now,
    expirationTime: expiresAt,
  });
  await db`delete from admin_nonces where expires_at < now()`;
  await db`insert into admin_nonces (nonce, address, message, expires_at)
    values (${nonce}, ${opts.address.toLowerCase()}, ${message}, ${expiresAt})`;
  return { message, expiresAt };
}

/**
 * Check a signed sign-in message and open a session for its address. The nonce is consumed whatever the outcome.
 * Contract wallets (a Safe, say) are checked through EIP-1271 when `client` is given.
 */
export async function verifyLogin(
  db: Db,
  client: Client | undefined,
  opts: { message: string; signature: Hex; chainId: number; origin: string; now?: Date },
): Promise<{ address: Address }> {
  const now = opts.now ?? new Date();
  const parsed = parseSiweMessage(opts.message);
  if (!parsed.nonce || !parsed.address) throw new AuthError("bad_message", "not a sign-in message");
  const [row] = await db<{ address: string; message: string; expires_at: Date }[]>`
    delete from admin_nonces where nonce = ${parsed.nonce} returning address, message, expires_at`;
  if (!row) throw new AuthError("nonce_unknown", "this sign-in request is unknown or was already used");
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new AuthError("nonce_expired", "this sign-in request expired; start again");
  }
  const site = new URL(opts.origin);
  const valid =
    row.message === opts.message &&
    parsed.chainId === opts.chainId &&
    validateSiweMessage({ message: parsed, address: getAddress(row.address), domain: site.host, nonce: parsed.nonce, time: now });
  if (!valid) throw new AuthError("bad_message", "the signed message does not match this sign-in request");
  const address = getAddress(row.address);
  if (!(await signedBy(client, address, opts.message, opts.signature))) {
    throw new AuthError("bad_signature", "the signature is not from this wallet");
  }
  return { address };
}

async function signedBy(client: Client | undefined, address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() === address.toLowerCase()) return true;
  } catch {
    // not a plain wallet signature; a contract wallet's may still be valid
  }
  if (!client) return false;
  try {
    return await client.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

export async function createSession(db: Db, address: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db`delete from admin_sessions where expires_at < now()`;
  await db`insert into admin_sessions (token_hash, address, expires_at)
    values (${hashToken(token)}, ${address.toLowerCase()}, ${expiresAt})`;
  return { token, expiresAt };
}

/** The session behind an `Authorization: Bearer <token>` header, or null. */
export async function sessionFor(db: Db, authorization: string | undefined): Promise<{ address: Address; expiresAt: Date } | null> {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "");
  if (!m) return null;
  const [row] = await db<{ address: string; expires_at: Date }[]>`
    select address, expires_at from admin_sessions where token_hash = ${hashToken(m[1]!)} and expires_at > now()`;
  if (!row) return null;
  return { address: getAddress(row.address), expiresAt: new Date(row.expires_at) };
}

export async function endSession(db: Db, authorization: string | undefined): Promise<void> {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "");
  if (m) await db`delete from admin_sessions where token_hash = ${hashToken(m[1]!)}`;
}

export async function endSessionsOf(db: Db, address: string): Promise<void> {
  await db`delete from admin_sessions where address = ${address.toLowerCase()}`;
}
