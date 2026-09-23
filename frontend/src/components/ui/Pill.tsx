import type { ReactNode } from "react";
import type { TFn } from "@/i18n/provider";

export type PillTone = "amber" | "ember" | "flare" | "verdigris" | "rose" | "muted";

// A tinted fill and no outline: status reads from the colour, and a page of badges is not a page of rings.
// Text on every tint is at least 4.8:1 in both themes (DESIGN.md).
const TONE_CLASS: Record<PillTone, string> = {
  amber: "bg-amber/10 text-amber",
  ember: "bg-ember/10 text-ember",
  flare: "bg-flare/10 text-flare",
  verdigris: "bg-verdigris/10 text-verdigris",
  rose: "bg-rose/10 text-rose",
  muted: "bg-raised text-muted",
};

/** Status capsule. Colours per DESIGN.md. */
export function Pill({ tone = "muted", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium leading-5 ${TONE_CLASS[tone]}`}
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

/**
 * Grant campaign status -> pill (AWAITING_ROOT muted, ROOT_PROPOSED amber, ACTIVE verdigris, EXPIRED muted,
 * CANCELLED rose). A campaign that ran its window is finished, not failed: red is kept for cancellation.
 */
export function campaignStatusPill(status: number | undefined, t: TFn): { tone: PillTone; label: string } {
  switch (status) {
    case 1:
      return { tone: "muted", label: t("status.campaign.awaitingRoot") };
    case 2:
      return { tone: "amber", label: t("status.campaign.rootProposed") };
    case 3:
      return { tone: "verdigris", label: t("status.campaign.active") };
    case 4:
      return { tone: "muted", label: t("status.campaign.ended") };
    case 5:
      return { tone: "rose", label: t("status.campaign.cancelled") };
    default:
      return { tone: "muted", label: t("status.campaign.none") };
  }
}
