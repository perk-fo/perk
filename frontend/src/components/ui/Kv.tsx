"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortAddress, shortHash } from "@/lib/format";
import { useT } from "@/i18n/provider";

function looksLikeAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}
function looksLikeHash(v: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

/**
 * Key/value row. Values render in mono; 0x addresses/hashes are truncated in the middle and,
 * when `copy` is set (or auto-detected), clicking copies the full value with a subtle tick.
 */
export function Kv({
  label,
  value,
  copy,
  href,
  children,
}: {
  label: string;
  /** Full string value; auto-truncated when it is an address or 32-byte hash. */
  value?: string;
  /** Copy-to-clipboard: true copies `value`, a string copies that string. */
  copy?: boolean | string;
  /** Wrap the value in an external link (e.g. explorer). */
  href?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useT();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copyText = copy === true ? value : typeof copy === "string" ? copy : undefined;
  const canCopy = copyText !== undefined && copyText.length > 0;
  const display =
    children ??
    (value !== undefined
      ? looksLikeHash(value)
        ? shortHash(value)
        : looksLikeAddress(value)
          ? shortAddress(value)
          : value
      : "—");

  function onCopy() {
    if (!copyText) return;
    void navigator.clipboard?.writeText(copyText).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }

  const body = (
    <span className="num break-all text-[13px] leading-snug">
      {display}
      {canCopy && (
        <span
          className={`ml-1.5 inline-block w-3 text-[11px] transition-opacity duration-200 ${
            copied ? "text-verdigris opacity-100" : "opacity-0"
          }`}
          aria-hidden={!copied}
        >
          ✓
        </span>
      )}
    </span>
  );

  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="label shrink-0 pt-px">{label}</span>
      <span className="min-w-0 text-right">
        {canCopy ? (
          <button
            type="button"
            onClick={onCopy}
            title={`${t("kv.copy")} ${copyText}`}
            className="transition-opacity duration-200 hover:opacity-70"
          >
            {body}
          </button>
        ) : href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={t("kv.openExplorer")}
            className="underline decoration-bone/30 hover:decoration-flare"
          >
            {body}
            <span className="ml-1 text-[10px] text-bone/40" aria-hidden>
              ↗
            </span>
          </a>
        ) : (
          body
        )}
      </span>
    </div>
  );
}
