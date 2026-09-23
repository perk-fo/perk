"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { AdminRole } from "@/lib/api-types";
import { adminApi, ApiRequestError } from "@/lib/api";
import { useDeployment } from "@/lib/hooks";

/**
 * Sign-in for the off-chain admin work (General Admins, and the Core Admin managing them). The wallet signs a
 * message the API wrote; no transaction, no gas. The session token lives in sessionStorage, so it ends with the tab
 * and is never shared with another site; the API checks the wallet's role again on every call.
 */
export interface AdminSessionState {
  token: string;
  address: string;
  roles: AdminRole[];
  expiresAt: number;
}

export type SignInError = "rejected" | "notAdmin" | "origin" | "unreachable" | "failed";

interface Ctx {
  session: AdminSessionState | null;
  signingIn: boolean;
  error: SignInError | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Run an admin API call with the session token; a 401 ends the session so the page asks to sign in again. */
  call: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
}

const SessionContext = createContext<Ctx | null>(null);

function storageKey(chainId: number, address: string): string {
  return `perk-admin-session:${chainId}:${address.toLowerCase()}`;
}

function readStored(chainId: number, address: string | undefined): AdminSessionState | null {
  if (!address) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(chainId, address));
    if (!raw) return null;
    const s = JSON.parse(raw) as AdminSessionState;
    return s.expiresAt * 1000 > Date.now() && s.address === address.toLowerCase() ? s : null;
  } catch {
    return null;
  }
}

function store(chainId: number, address: string, s: AdminSessionState | null): void {
  try {
    if (s) window.sessionStorage.setItem(storageKey(chainId, address), JSON.stringify(s));
    else window.sessionStorage.removeItem(storageKey(chainId, address));
  } catch {
    // storage unavailable (private mode): the session lasts until reload
  }
}

function classify(err: unknown): SignInError {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "UserRejectedRequestError" || /reject|denied/i.test((err as Error)?.message ?? "")) return "rejected";
  if (err instanceof ApiRequestError) {
    if (err.code === "not_admin") return "notAdmin";
    if (err.code === "bad_origin") return "origin";
    if (err.status === 0 || err.status >= 500) return "unreachable";
  }
  return "failed";
}

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { chainId } = useDeployment();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<AdminSessionState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<SignInError | null>(null);

  // a different wallet means a different session
  useEffect(() => {
    setSession(readStored(chainId, address));
    setError(null);
  }, [chainId, address]);

  const drop = useCallback(() => {
    if (address) store(chainId, address, null);
    setSession(null);
  }, [chainId, address]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setSigningIn(true);
    setError(null);
    try {
      const { message } = await adminApi.nonce(address);
      const signature = await signMessageAsync({ message });
      const s = await adminApi.login(message, signature);
      const state: AdminSessionState = { token: s.token, address: s.address, roles: s.roles, expiresAt: s.expiresAt };
      store(chainId, address, state);
      setSession(state);
    } catch (e) {
      setError(classify(e));
    } finally {
      setSigningIn(false);
    }
  }, [address, chainId, signMessageAsync]);

  const signOut = useCallback(async () => {
    const token = session?.token;
    drop();
    if (token) await adminApi.logout(token).catch(() => undefined);
  }, [session, drop]);

  const call = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      if (!session) throw new ApiRequestError(401, "unauthorized", "sign in first");
      try {
        return await fn(session.token);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) drop();
        throw e;
      }
    },
    [session, drop],
  );

  const value = useMemo(() => ({ session, signingIn, error, signIn, signOut, call }), [session, signingIn, error, signIn, signOut, call]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAdminSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useAdminSession outside AdminSessionProvider");
  return ctx;
}
