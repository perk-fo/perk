"use client";

import { useAdminRoles } from "@/lib/admin";
import { useDeployment } from "@/lib/hooks";
import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { PausePanel, RescuePanel } from "@/components/admin/ProtocolPanels";
import { useT } from "@/i18n/provider";

/** Core Admin: the emergency pause, stuck graduations and refunds. */
export default function AdminProtocolPage() {
  const { t } = useT();
  const { deployment } = useDeployment();
  const roles = useAdminRoles();
  if (!deployment) return null;
  return (
    <SectionGate section="protocol">
      <SectionIntro title={t("admin.nav.protocol")} body={t("admin.protocol.body")} />
      <PausePanel factory={deployment.factory} canWrite={roles.isCore} />
      <RescuePanel graduation={deployment.graduationManager} canWrite={roles.owns.graduation} />
    </SectionGate>
  );
}
