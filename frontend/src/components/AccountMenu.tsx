"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { ROLE_ORDER, useRoles, type Role } from "@/lib/roles";
import { shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { InviteLinkRow } from "@/components/InviteLinkRow";

const ROLE_TONE: Record<Role, string> = {
  admin: "bg-flare text-[rgb(var(--on-flare))]",
  creator: "bg-amber/20 text-amber",
  lp: "bg-amber/20 text-amber",
  user: "bg-bone/10 text-bone/70",
  guest: "bg-bone/10 text-bone/70",
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
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-role={tier}
        className="btn-ghost flex items-center gap-2 py-1 pl-2.5 pr-1 text-xs"
      >
        <span className="num">{shortAddress(address)}</span>
        {showChip ? (
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] leading-none ${ROLE_TONE[tier]}`}>{t(`role.${tier}`)}</span>
        ) : (
          <span className="pr-1.5 text-bone/40" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <span role="menu" className="panel absolute right-0 z-20 mt-1.5 flex w-72 flex-col gap-3 p-4">
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
              <span className="num select-all break-all text-[12px] leading-snug text-bone/80">{address}</span>
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="label">{t("header.account.roles")}</span>
              <span className="flex flex-wrap gap-1.5">
                {(held.length ? held : (["user"] as Role[])).map((r) => (
                  <span key={r} className={`rounded-full px-2 py-0.5 text-[11px] ${ROLE_TONE[r]}`}>
                    {t(`role.${r}`)}
                  </span>
                ))}
              </span>
              <span className="text-[11px] leading-snug text-bone/40">{t("header.role.title")}</span>
            </span>
            <span className="block border-t border-bone/8 pt-3">
              <InviteLinkRow address={address} />
            </span>
            <span className="flex gap-2 border-t border-bone/8 pt-3">
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
