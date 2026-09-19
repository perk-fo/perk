"use client";

import { useState } from "react";
import type { Address } from "viem";
import { inviteLink } from "@/lib/referral";
import { useT } from "@/i18n/provider";

/** "My invite link" with copy; the link is `<this site>/?ref=<address>`. */
export function InviteLinkRow({ address }: { address: Address }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const link = typeof window === "undefined" ? "" : inviteLink(window.location.origin, address);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked: the link is selectable */
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{t("invite.myLink")}</span>
      <div className="flex items-center gap-2">
        <span className="num min-w-0 flex-1 select-all truncate text-[12px] text-bone/70" title={link}>
          {link}
        </span>
        <button type="button" onClick={copy} className="btn-ghost shrink-0 px-3 py-1 text-xs">
          {copied ? t("invite.copied") : t("invite.copyLink")}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-bone/40">{t("invite.share")}</p>
    </div>
  );
}
