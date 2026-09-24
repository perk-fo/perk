"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ADMIN_SECTIONS, useAdminRoles } from "@/lib/admin";
import { AdminSessionProvider, useAdminSession } from "@/lib/admin-session";
import { useDeployment } from "@/lib/hooks";
import { NotFoundView } from "@/components/NotFoundView";
import { Notice } from "@/components/ui/Notice";
import { RolePill } from "@/components/admin/AdminKit";
import { useT } from "@/i18n/provider";
import { PerkLoader } from "@/components/brand/PerkLoader";

/**
 * Everything under /admin. Only a wallet holding an admin role sees any of it: the Core Admin and the Grant Admin
 * are read from the chain, General Admins from the API. Everyone else (including a visitor with no wallet
 * connected) gets the same not-found page as any unknown address, and the navigation never links here for them.
 * The page code is public like the rest of the site; what protects each action is the contract or the API, which
 * check the caller themselves.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { t } = useT();
  const { deployment } = useDeployment();
  const roles = useAdminRoles();

  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")} className="mt-6">
        {t("home.network.body")}
      </Notice>
    );
  }
  if (roles.isLoading) return <PerkLoader minHeight={480} />;
  if (!roles.isAdmin) return <NotFoundView />;

  return (
    <AdminSessionProvider>
      <div className="space-y-6 pt-6 sm:pt-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow mb-3 text-[10px] font-bold tracking-[0.2em]">{t("page.admin.eyebrow")}</p>
            <h1 className="font-display text-[36px] leading-[1.08] sm:text-[48px]">{t("admin.title")}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              <span>{t("admin.youAre")}</span>
              {roles.roles.map((r) => (
                <RolePill key={r} role={r} />
              ))}
            </p>
          </div>
          <SessionChip />
        </header>
        <AdminNav />
        {children}
      </div>
    </AdminSessionProvider>
  );
}

function AdminNav() {
  const { t } = useT();
  const pathname = usePathname();
  const roles = useAdminRoles();
  const items = [
    { href: "/admin", label: t("admin.nav.overview"), active: pathname === "/admin" },
    ...ADMIN_SECTIONS.filter((s) => roles.can(s.key)).map((s) => ({
      href: `/admin/${s.key}`,
      label: t(`admin.nav.${s.key}`),
      active: pathname.startsWith(`/admin/${s.key}`),
    })),
  ];
  return (
    <nav aria-label={t("admin.title")} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-full bg-raised p-1">
        {items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={i.active ? "page" : undefined}
              className={`block whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-fast ${
                i.active ? "bg-knob text-bone shadow-sm" : "text-muted hover:text-bone"
              }`}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SessionChip() {
  const { t } = useT();
  const s = useAdminSession();
  if (!s.session) return null;
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <span className="inline-block h-2 w-2 rounded-full bg-verdigris" aria-hidden />
      <span>{t("admin.session.active")}</span>
      <button type="button" onClick={() => void s.signOut()} className="btn-ghost h-7 px-3 text-xs">
        {t("admin.session.signOut")}
      </button>
    </div>
  );
}
