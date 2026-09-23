"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { forgetInviter, parseRef, REF_PARAM, rememberInviter } from "@/lib/referral";
import { useInvite } from "@/lib/use-referral";
import { shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";

/**
 * Invite links, mounted once under the header:
 *   1. on any page, `?ref=<address>` is remembered (first touch wins) and stripped from the address bar;
 *   2. accepting happens on the LP Grant page (participation card: accept + opt in). Elsewhere, while an invite is
 *      pending and still usable, a slim bar points there. Own link / already bound → the invite is dropped silently.
 */
export function InviteBar() {
  const { t } = useT();
  const pathname = usePathname();
  const invite = useInvite();

  useEffect(() => {
    const ref = parseRef(window.location.search);
    if (!ref) return;
    rememberInviter(ref);
    const url = new URL(window.location.href);
    url.searchParams.delete(REF_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);

  if (!invite.pending || pathname.startsWith("/grant")) return null;
  if (invite.block === "self" || invite.block === "alreadyBound") return null;

  const [before, after] = t("invite.bar.pointer", { who: "{who}" }).split("{who}");
  return (
    <div className="border-b border-flare/20 bg-flare/[0.06]">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
        <span className="text-bone">
          {before}
          <span className="mono text-bone">{shortAddress(invite.pending)}</span>
          {after}
        </span>
        <span className="flex items-center gap-2">
          <Link href="/grant" className="btn-primary px-3.5 py-1 text-xs">
            {t("invite.bar.go")}
          </Link>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={forgetInviter}>
            {t("invite.bar.dismiss")}
          </button>
        </span>
      </div>
    </div>
  );
}
