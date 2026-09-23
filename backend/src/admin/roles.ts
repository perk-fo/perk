import type { Db } from "../db/client";
import type { AdminRole } from "../api/types";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface RoleHolders {
  /** Owner of the contracts (the factory's owner), or null before the indexer has seen it. */
  core: string | null;
  /** The grant vault's publisher, or null while the role is vacant. */
  grant: string | null;
}

/** Current holders of the two on-chain roles: the latest change the indexer recorded for each. */
export async function selectRoleHolders(db: Db, chainId: number): Promise<RoleHolders> {
  const [row] = await db<{ core: string | null; grant: string | null }[]>`
    select
      (select address from chain_role_events where chain_id = ${chainId} and role = 'core'
        order by block_number desc, log_index desc limit 1) as core,
      (select address from chain_role_events where chain_id = ${chainId} and role = 'grant'
        order by block_number desc, log_index desc limit 1) as grant`;
  const held = (a: string | null | undefined) => (a && a !== ZERO ? a : null);
  return { core: held(row?.core), grant: held(row?.grant) };
}

/** Every admin role `address` holds, in the order core, grant, operator. */
export async function selectAdminRoles(db: Db, chainId: number, address: string): Promise<AdminRole[]> {
  const a = address.toLowerCase();
  const [holders, ops] = await Promise.all([
    selectRoleHolders(db, chainId),
    db<{ ok: number }[]>`select 1 as ok from admin_operators where address = ${a}`,
  ]);
  const roles: AdminRole[] = [];
  if (holders.core === a) roles.push("core");
  if (holders.grant === a) roles.push("grant");
  if (ops.length > 0) roles.push("operator");
  return roles;
}
