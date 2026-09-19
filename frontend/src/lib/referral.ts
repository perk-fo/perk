/**
 * Invite links. A user shares `<site>/?ref=<their address>`; whoever opens it has that inviter remembered in this
 * browser until they bind on-chain (ReferralRegistry.bindInviter must be sent by the invitee, so a link alone cannot
 * bind — it makes binding one click). First touch wins: a later link does not replace a pending inviter, and nothing
 * is kept once the wallet has any inviter on-chain.
 */
import { getAddress, isAddress, type Address } from "viem";

export const REF_PARAM = "ref";
const STORAGE_KEY = "perk_ref";
const TTL_MS = 30 * 24 * 3600 * 1000;
const CHANGE_EVENT = "perk-ref-change";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Invite links open the LP Grant page, where opt-in and the inviter live. Any page accepts ?ref= too. */
export function inviteLink(origin: string, address: Address): string {
  return `${origin.replace(/\/$/, "")}/grant?${REF_PARAM}=${getAddress(address)}`;
}

/** The inviter in a query string, or null when absent / not an address. */
export function parseRef(search: string): Address | null {
  const raw = new URLSearchParams(search).get(REF_PARAM);
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

export interface StoredRef {
  inviter: Address;
  at: number;
}

/** First touch wins; an expired entry counts as absent. */
export function nextStoredRef(current: StoredRef | null, incoming: Address, now: number): StoredRef {
  if (current && now - current.at < TTL_MS) return current;
  return { inviter: incoming, at: now };
}

export function isFresh(ref: StoredRef | null, now: number): ref is StoredRef {
  return !!ref && now - ref.at < TTL_MS;
}

export type BindBlock = "self" | "alreadyBound" | "mutual";

/**
 * Why the connected wallet cannot bind `pending` (mirrors ReferralRegistry.bindInviter), or null when it can.
 * `myInviter` / `pendingsInviter` are inviterOf(me) / inviterOf(pending); undefined while loading → null (unknown).
 */
export function bindBlock(
  me: Address,
  pending: Address,
  myInviter: Address | undefined,
  pendingsInviter: Address | undefined,
): BindBlock | null {
  if (me.toLowerCase() === pending.toLowerCase()) return "self";
  if (myInviter && myInviter !== ZERO) return "alreadyBound";
  if (pendingsInviter && pendingsInviter.toLowerCase() === me.toLowerCase()) return "mutual";
  return null;
}

// ---- browser storage (per-viewer convenience; every access guarded) ----

export function readStoredRef(): StoredRef | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredRef;
    return isAddress(v.inviter) && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

export function rememberInviter(inviter: Address): void {
  try {
    const next = nextStoredRef(readStoredRef(), inviter, Date.now());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* storage blocked: the link still works for this page view via the URL */
  }
}

export function forgetInviter(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

export function onStoredRefChange(fn: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(CHANGE_EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}
