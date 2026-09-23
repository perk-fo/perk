"use client";

import { useAdminRoles } from "@/lib/admin";
import { useDeployment } from "@/lib/hooks";
import { Notice } from "@/components/ui/Notice";
import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { AwaitingListsPanel, ReviewListsPanel } from "@/components/admin/GrantPanels";
import { shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";

/** Grant Admin (and the Core Admin as fallback): LP Grant allocation lists under review and still to publish. */
export default function AdminGrantsPage() {
  const { t } = useT();
  const { deployment } = useDeployment();
  const roles = useAdminRoles();
  if (!deployment) return null;
  // the vault accepts cancellations from its publisher or its owner
  const canWrite = roles.isGrant || roles.owns.vault;
  return (
    <SectionGate section="grants">
      <SectionIntro title={t("admin.nav.grants")} body={t("admin.grants.body")} />
      {!roles.isGrant && roles.isCore && (
        <Notice tone="amber">
          {roles.publisher
            ? t("admin.grants.coreFallback", { publisher: shortAddress(roles.publisher) })
            : t("admin.grants.noPublisher")}
        </Notice>
      )}
      <ReviewListsPanel vault={deployment.lpGrantVault} canWrite={canWrite} />
      <AwaitingListsPanel />
    </SectionGate>
  );
}
