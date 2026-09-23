"use client";

import Link from "next/link";
import { ADMIN_SECTIONS, useAdminRoles } from "@/lib/admin";
import { Panel } from "@/components/ui/Panel";
import { Addr, RolePill } from "@/components/admin/AdminKit";
import { useT } from "@/i18n/provider";

/** The admin home: the sections this wallet's roles open, and who holds the on-chain roles. */
export default function AdminOverviewPage() {
  const { t } = useT();
  const roles = useAdminRoles();
  const sections = ADMIN_SECTIONS.filter((s) => roles.can(s.key));
  return (
    <div className="space-y-6">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <li key={s.key}>
            <Link href={`/admin/${s.key}`} className="panel block h-full p-5 transition-colors duration-fast hover:border-line-strong">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-lg">{t(`admin.nav.${s.key}`)}</h2>
                <span className="text-subtle" aria-hidden>
                  →
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{t(`admin.section.${s.key}`)}</p>
              <p className="mt-3 flex flex-wrap gap-1.5">
                {s.roles.map((r) => (
                  <RolePill key={r} role={r} />
                ))}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      <Panel title={t("admin.holders.title")}>
        <dl className="divide-y divide-line border-y border-line text-sm [&>div]:flex [&>div]:flex-wrap [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&>div]:py-2.5">
          <div>
            <dt className="flex items-center gap-2">
              <RolePill role="core" />
            </dt>
            <dd>{roles.owner ? <Addr value={roles.owner} /> : "—"}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-2">
              <RolePill role="grant" />
            </dt>
            <dd>{roles.publisher ? <Addr value={roles.publisher} /> : <span className="text-subtle">{t("admin.holders.vacant")}</span>}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-2">
              <RolePill role="operator" />
            </dt>
            <dd className="text-[13px] text-muted">{t("admin.holders.operators")}</dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}
