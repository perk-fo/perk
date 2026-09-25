"use client";

import { useAdminRoles } from "@/lib/admin";
import { useDeployment } from "@/lib/hooks";
import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { ActivityPanel, CoreAdminPanel, GeneralAdminsPanel, GrantAdminPanel } from "@/components/admin/RolesPanels";
import { useT } from "@/i18n/provider";

/** Core Admin: who holds each admin role, appointing the Grant Admin and General Admins, and the activity log. */
export default function AdminRolesPage() {
  const { t } = useT();
  const { deployment } = useDeployment();
  const roles = useAdminRoles();
  if (!deployment) return null;
  return (
    <SectionGate section="roles">
      <SectionIntro title={t("admin.nav.roles")} body={t("admin.roles.body")} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CoreAdminPanel />
        <GrantAdminPanel vault={deployment.lpGrantVault} canWrite={roles.owns.vault} />
      </div>
      <GeneralAdminsPanel />
      <ActivityPanel />
    </SectionGate>
  );
}
