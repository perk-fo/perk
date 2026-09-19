"use client";

import { useHealth } from "@/lib/api-hooks";
import { API_URL } from "@/lib/api";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n/provider";
import { formatNumber } from "@/lib/format";
import { useRoles } from "@/lib/roles";

/**
 * Lag bands, in blocks. X Layer mints roughly one block a second, so these read as ~1.5 min, ~17 min and ~80 min
 * behind. Below `NOTICE` the indexer is doing its job — it deliberately trails the head by `confirmations` — and
 * saying so to a trader is noise, so only operators see it there.
 */
export const LAG_NOTICE = 100;
export const LAG_SERIOUS = 1_000;
export const LAG_CRITICAL = 5_000;

/** Dot colour per tone. Written out in full because Tailwind only sees class names that appear literally. */
const DOT_CLASS: Record<"verdigris" | "amber" | "ember" | "rose", string> = {
  verdigris: "bg-verdigris",
  amber: "bg-amber",
  ember: "bg-ember",
  rose: "bg-rose",
};

export type LagTone = keyof typeof DOT_CLASS;

/** Pill tone for a lag, from healthy to badly behind. */
export function lagTone(lag: number): LagTone {
  if (lag >= LAG_CRITICAL) return "rose";
  if (lag >= LAG_SERIOUS) return "ember";
  if (lag >= LAG_NOTICE) return "amber";
  return "verdigris";
}

/**
 * Who sees the pill at a given lag. Operators always do; everyone else only once it has passed the notice band.
 * Separate from the component so the rule can be tested without a DOM.
 */
export function showsLag(lag: number, isAdmin: boolean): boolean {
  return isAdmin || lagTone(lag) !== "verdigris";
}

/**
 * Indexer freshness in the header.
 *
 * Operators (admins) always see it: for them it is a health readout and its absence would be ambiguous. Everyone
 * else only sees it once the lag passes `LAG_NOTICE`, because a couple of blocks behind is the normal, healthy
 * state and a permanent "2 blocks behind" badge just makes a working product look broken. From that point on both
 * audiences get the same escalation — amber, ember, then rose.
 *
 * An unreachable data service is shown to everyone regardless: that is an outage the user is entitled to know
 * about, and it changes what they should trust on the page.
 */
export function SyncStatus() {
  const { t, locale } = useT();
  const health = useHealth();
  const { isAdmin } = useRoles();

  if (health.isError || (!health.data && !health.isLoading)) {
    return (
      <span title={t("header.sync.downTitle", { url: API_URL })}>
        <Pill tone="rose">
          <span className="h-1.5 w-1.5 rounded-full bg-rose" aria-hidden />
          {t("header.sync.down")}
        </Pill>
      </span>
    );
  }
  const h = health.data;
  if (!h) {
    // placeholder only where the pill is always present, so the header does not jump for operators
    return isAdmin ? (
      <Pill tone="muted">
        <span className="h-1.5 w-1.5 rounded-full bg-bone/30" aria-hidden />
        <span className="inline-block w-14 opacity-0">·</span>
      </Pill>
    ) : null;
  }

  const lag = h.lagBlocks ?? 0;
  const catchingUp = h.mode === "catchup";
  const tone = lagTone(lag);
  const healthy = tone === "verdigris";
  if (!showsLag(lag, isAdmin)) return null;

  // "fresh" keeps its old meaning for the wording: within ~20 s of the head rather than merely under the band.
  const fresh = healthy && !catchingUp && h.ok && ((h.lagSeconds !== null && h.lagSeconds <= 20) || lag <= 12);
  const n = formatNumber(lag, locale);
  return (
    <span
      title={t("header.sync.title", {
        cursor: formatNumber(h.cursorBlock, locale),
        head: h.headBlock === null ? "—" : formatNumber(h.headBlock, locale),
        n,
        seconds: h.lagSeconds === null ? "—" : formatNumber(h.lagSeconds, locale),
        conf: formatNumber(h.confirmations ?? 0, locale),
      })}
      data-lag-tone={tone}
      data-admin={isAdmin ? "true" : undefined}
    >
      <Pill tone={tone}>
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]}${fresh ? " twinkle" : ""}`} aria-hidden />
        <span className="num">
          {catchingUp ? t("header.sync.catchup", { n }) : t(fresh ? "header.sync.ok" : "header.sync.lag", { n })}
        </span>
      </Pill>
    </span>
  );
}
