"use client";

import { useAdminRoles } from "@/lib/admin";
import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { NewQuotePanel, QuoteAssetsPanel } from "@/components/admin/AssetsPanels";
import { useT } from "@/i18n/provider";

/** Quote currencies: listing new ones on-chain (Core Admin) and how the site shows each (General Admins too). */
export default function AdminAssetsPage() {
  const { t } = useT();
  const roles = useAdminRoles();
  return (
    <SectionGate section="assets">
      <SectionIntro title={t("admin.nav.assets")} body={t(roles.isCore ? "admin.assets.bodyCore" : "admin.assets.bodyOperator")} />
      <QuoteAssetsPanel />
      {roles.isCore && <NewQuotePanel />}
    </SectionGate>
  );
}
