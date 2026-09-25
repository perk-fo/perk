"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { ROLE_ORDER, useRoles, type Role } from "@/lib/roles";
import { shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { InviteLinkRow } from "@/components/InviteLinkRow";
import { useDismiss } from "@/lib/use-dismiss";

const ROLE_TONE: Record<Role, string> = {
  admin: "bg-yolk text-charcoal",
  creator: "bg-amber/20 text-amber",
  lp: "bg-amber/20 text-amber",
  user: "bg-raised text-muted",
  guest: "bg-raised text-muted",
};

/**
 * The connected wallet as one control: short address plus the highest role (admin / creator / LP; plain users show
 * none). Clicking opens a menu with the full address, every role the wallet holds, copy and disconnect — a stray
 * click no longer disconnects.
 */
export function AccountMenu() {
  const { t } = useT();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));
  if (!address) return null;

  const tier = roles.tier;
  const showChip = !roles.isLoading && tier !== "user" && tier !== "guest";
  const held = ROLE_ORDER.filter((r) => r !== "guest" && roles.roles.has(r));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked: the address is selectable in the menu */
    }
  };

  return (
    <span ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-role={tier}
        className="btn-ghost flex h-10 items-center gap-2 pl-3.5 pr-2 text-[13px]"
      >
        <span className="mono">{shortAddress(address)}</span>
        {/* on a phone the chip would push the header onto a third row; the menu lists every role anyway */}
        {showChip && (
          <span className={`hidden rounded-full px-2 py-0.5 text-[11px] font-bold leading-none sm:inline ${ROLE_TONE[tier]}`}>
            {t(`role.${tier}`)}
          </span>
        )}
        <span className={`pr-1.5 text-subtle ${showChip ? "sm:hidden" : ""}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <>
          <span role="menu" className="popover absolute right-0 z-30 mt-2 flex w-72 flex-col gap-3 p-4">
            <Link
              href="/me"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="btn-primary flex items-center justify-between px-4 py-2 text-sm"
            >
              {t("nav.me")}
              <span aria-hidden>→</span>
            </Link>
            <span className="flex flex-col gap-1.5">
              <span className="label">{t("header.account.address")}</span>
              <span className="mono select-all break-all text-[13px] leading-snug text-bone">{address}</span>
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="label">{t("header.account.roles")}</span>
              <span className="flex flex-wrap gap-1.5">
                {(held.length ? held : (["user"] as Role[])).map((r) => (
                  <span key={r} className={`rounded-full px-2 py-0.5 text-xs ${ROLE_TONE[r]}`}>
                    {t(`role.${r}`)}
                  </span>
                ))}
              </span>
              <span className="text-xs leading-snug text-subtle">{t("header.role.title")}</span>
            </span>
            <span className="block border-t border-line pt-3">
              <InviteLinkRow address={address} />
            </span>
            <span className="flex gap-2 border-t border-line pt-3">
              <button type="button" role="menuitem" onClick={copy} className="btn-ghost flex-1 py-1.5 text-xs">
                {copied ? t("header.account.copied") : t("header.account.copy")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  disconnect();
                }}
                className="btn-ghost flex-1 py-1.5 text-xs text-rose"
              >
                {t("header.disconnect")}
              </button>
            </span>
          </span>
        </>
      )}
    </span>
  );
}
