import { getAddress, toEventSelector, type Address } from "viem";
import { INVITER_BOUND_EVENT } from "./abi";
import { fetchLogsPaged, LOG_PAGE_SIZE, type LogFetcher, type PagingOptions, type RawLog } from "./optin";

export const INVITER_BOUND_TOPIC = toEventSelector(INVITER_BOUND_EVENT);

export interface ReferralBinding {
  invitee: Address;
  inviter: Address;
  blockNumber: bigint;
}

/** Decode an `InviterBound` log (invitee = topic 1, inviter = topic 2, blockNumber in data). */
export function decodeInviterBound(log: RawLog): ReferralBinding {
  if (log.topics.length < 3) throw new Error("InviterBound log missing topics");
  return {
    invitee: getAddress(`0x${log.topics[1].slice(26)}`),
    inviter: getAddress(`0x${log.topics[2].slice(26)}`),
    blockNumber: BigInt(log.data),
  };
}

/**
 * Map invitee → binding for every `InviterBound` with blockNumber <= cutoff.
 * The registry rejects re-binding, so the first (and only) log per invitee wins;
 * the first-seen guard keeps the map stable even against a forged duplicate log.
 */
export async function collectReferrals(
  fetchRange: LogFetcher,
  cutoff: bigint,
  fromBlock: bigint = 0n,
  pageSize: bigint = LOG_PAGE_SIZE,
  paging: PagingOptions = {},
): Promise<Map<Address, ReferralBinding>> {
  const logs = await fetchLogsPaged(fetchRange, fromBlock, cutoff, pageSize, paging);
  const map = new Map<Address, ReferralBinding>();
  for (const log of logs) {
    if (log.topics[0] !== INVITER_BOUND_TOPIC) continue;
    const binding = decodeInviterBound(log);
    if (binding.blockNumber > cutoff) continue;
    if (!map.has(binding.invitee)) map.set(binding.invitee, binding);
  }
  return map;
}
