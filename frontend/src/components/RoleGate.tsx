"use client";

import type { ReactNode } from "react";
import type { Address } from "viem";
import { useRoles, type Role } from "@/lib/roles";

/**
 * Wrap UI that only some roles should see. Gating is a build-time switch (ROLE_GATING_ENABLED): while off,
 * children always render, unwrapped (see ROLE_GATING_ENABLED).
 * `meme` scopes creator/lp checks to one launch.
 */
export function RoleGate({
  roles,
  meme,
  fallback = null,
  children,
}: {
  roles: Role | Role[];
  meme?: Address;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const state = useRoles();
  const list = Array.isArray(roles) ? roles : [roles];
  if (!state.can(list, meme)) return <>{fallback}</>;
  // no wrapper element: a `display: contents` div swallowed the parent's space-y margins (cards touched)
  return <>{children}</>;
}
