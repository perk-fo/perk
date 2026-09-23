"use client";

import { SectionGate, SectionIntro } from "@/components/admin/AdminKit";
import { ModerationPanels } from "@/components/admin/CurationPanels";
import { useT } from "@/i18n/provider";

/** General Admins and the Core Admin: hide launches or their media from this site. */
export default function AdminModerationPage() {
  const { t } = useT();
  return (
    <SectionGate section="moderation">
      <SectionIntro title={t("admin.nav.moderation")} body={t("admin.moderation.body")} />
      <ModerationPanels />
    </SectionGate>
  );
}
