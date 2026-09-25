import { parseAbi, type Address } from "viem";
import type { Db } from "../db/client";
import type { Deployment } from "../config";
import type { Client } from "../chain/rpc";
import type { AdminRole } from "../api/types";

const ZERO = "0x0000000000000000000000000000000000000000";

const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);
const PUBLISHER_ABI = parseAbi(["function publisher() view returns (address)"]);

export interface RoleHolders {
  /** Owner of the contracts (the factory's owner), or null when unknown. */
  core: string | null;
  /** The grant vault's publisher, or null while the role is vacant. */
  grant: string | null;
}

function held(a: string | null | undefined): string | null {
  const lc = a?.toLowerCase();
  return lc && lc !== ZERO ? lc : null;
}

/**
 * Holders of the two on-chain roles as the index last recorded them (the latest chain_role_events row of each). The
 * index lags the chain, and while it is rebuilt it replays old owners, so this is for display only, when the chain
 * cannot be read: authorisation uses ChainRoleReader.
 */
export async function selectRoleHolders(db: Db, chainId: number): Promise<RoleHolders> {
  const [row] = await db<{ core: string | null; grant: string | null }[]>`
    select
      (select address from chain_role_events where chain_id = ${chainId} and role = 'core'
        order by block_number desc, log_index desc limit 1) as core,
      (select address from chain_role_events where chain_id = ${chainId} and role = 'grant'
        order by block_number desc, log_index desc limit 1) as grant`;
  return { core: held(row?.core), grant: held(row?.grant) };
}

/**
 * The on-chain roles as the chain has them now: the factory's owner() is the Core Admin (every Perk contract has the
 * same owner) and the grant vault's publisher() is the Grant Admin. The answer is kept for `ttlMs` and one read serves
 * every caller waiting on it, so however busy the routes are, this costs at most two eth_calls per `ttlMs`.
 */
export class ChainRoleReader {
  private cached: { at: number; holders: RoleHolders } | null = null;
  private inflight: Promise<RoleHolders> | null = null;

  constructor(
    private readonly client: Client,
    private readonly deployment: Pick<Deployment, "factory" | "lpGrantVault">,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  holders(): Promise<RoleHolders> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return Promise.resolve(this.cached.holders);
    if (!this.inflight) {
      this.inflight = this.read()
        .then((holders) => {
          this.cached = { at: this.now(), holders };
          return holders;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async read(): Promise<RoleHolders> {
    const [owner, publisher] = await Promise.all([
      this.client.readContract({ address: this.deployment.factory, abi: OWNER_ABI, functionName: "owner" }),
      this.client.readContract({ address: this.deployment.lpGrantVault, abi: PUBLISHER_ABI, functionName: "publisher" }),
    ]);
    return { core: held(owner as Address), grant: held(publisher as Address) };
  }
}

/** The chain could not be asked who holds the on-chain roles. */
export class RolesUnavailableError extends Error {
  override name = "RolesUnavailableError";
}

/** Holders to authorise with: from the chain, never from the index. Throws RolesUnavailableError. */
export async function authoritativeRoleHolders(reader: ChainRoleReader | null): Promise<RoleHolders> {
  if (!reader) throw new RolesUnavailableError("no RPC client to read the on-chain roles");
  try {
    return await reader.holders();
  } catch (err) {
    throw new RolesUnavailableError("the on-chain roles could not be read", { cause: err });
  }
}

/** Holders to show: from the chain, or from the index while the chain cannot be read. */
export async function displayRoleHolders(db: Db, chainId: number, reader: ChainRoleReader | null): Promise<RoleHolders> {
  if (reader) {
    try {
      return await reader.holders();
    } catch {
      // fall back to what the index recorded
    }
  }
  return selectRoleHolders(db, chainId);
}

/** Every admin role `address` holds on `chainId`, in the order core, grant, operator. */
export async function selectAdminRoles(
  db: Db,
  chainId: number,
  address: string,
  holders: RoleHolders,
): Promise<AdminRole[]> {
  const a = address.toLowerCase();
  const ops = await db<{ ok: number }[]>`
    select 1 as ok from admin_operators where chain_id = ${chainId} and address = ${a}`;
  const roles: AdminRole[] = [];
  if (holders.core === a) roles.push("core");
  if (holders.grant === a) roles.push("grant");
  if (ops.length > 0) roles.push("operator");
  return roles;
}
