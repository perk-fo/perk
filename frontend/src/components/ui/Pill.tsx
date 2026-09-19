import type { ReactNode } from "react";
import type { TFn } from "@/i18n/provider";

export type PillTone = "amber" | "ember" | "flare" | "verdigris" | "rose" | "muted";

const TONE_CLASS: Record<PillTone, string> = {
  amber: "border-amber/40 bg-amber/10 text-amber",
  ember: "border-ember/40 bg-ember/10 text-ember",
  flare: "border-flare/40 bg-flare/10 text-flare",
  verdigris: "border-verdigris/40 bg-verdigris/10 text-verdigris",
  rose: "border-rose/40 bg-rose/10 text-rose",
  muted: "border-bone/20 bg-bone/5 text-bone/60",
};

/** Status capsule. Colours per DESIGN.md. */
export function Pill({ tone = "muted", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs leading-5 ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/** Launch status -> pill (CURVE_ACTIVE amber, GRADUATION_PENDING flare, GRADUATED verdigris). */
export function launchStatusPill(status: number | undefined, t: TFn): { tone: PillTone; label: string } {
  switch (status) {
    case 1:
      return { tone: "amber", label: t("status.launch.active") };
    case 2:
      return { tone: "flare", label: t("status.launch.pending") };
    case 3:
      return { tone: "verdigris", label: t("status.launch.graduated") };
    default:
      return { tone: "muted", label: "—" };
  }
}

/** Grant campaign status -> pill (AWAITING_ROOT muted, ROOT_PROPOSED amber, ACTIVE verdigris, EXPIRED/CANCELLED rose). */
export function campaignStatusPill(status: number | undefined, t: TFn): { tone: PillTone; label: string } {
  switch (status) {
    case 1:
      return { tone: "muted", label: t("status.campaign.awaitingRoot") };
    case 2:
      return { tone: "amber", label: t("status.campaign.rootProposed") };
    case 3:
      return { tone: "verdigris", label: t("status.campaign.active") };
    case 4:
      return { tone: "rose", label: t("status.campaign.ended") };
    case 5:
      return { tone: "rose", label: t("status.campaign.cancelled") };
    default:
      return { tone: "muted", label: t("status.campaign.none") };
  }
}
