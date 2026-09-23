"use client";

import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { FeaturedPanels } from "@/components/admin/CurationPanels";
import { useT } from "@/i18n/provider";

/** General Admins and the Core Admin: the launches featured on the home page. */
export default function AdminFeaturedPage() {
  const { t } = useT();
  return (
    <SectionGate section="featured">
      <SectionIntro title={t("admin.nav.featured")} body={t("admin.featured.intro")} />
      <FeaturedPanels />
    </SectionGate>
  );
}
