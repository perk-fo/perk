"use client";

import Link from "next/link";
import { PerkChick, type ChickMode } from "./PerkChick";

/** The lockup: the chick and the "Perk." wordmark with its tangerine full stop. Hovering it makes the chick hop. */
export function PerkBrand({
  href = "/",
  size = 36,
  text = 26,
  mode = "idle",
  className,
  wordmarkClassName,
}: {
  href?: string | null;
  size?: number;
  text?: number;
  mode?: ChickMode;
  className?: string;
  /** e.g. hide the wordmark on the narrowest phones, where the chick alone carries the brand */
  wordmarkClassName?: string;
}) {
  const inner = (
    <>
      <PerkChick size={size} mode={mode} />
      <span className={`wordmark leading-none ${wordmarkClassName ?? ""}`} style={{ fontSize: text }}>
        Perk<span className="text-tangerine">.</span>
      </span>
    </>
  );
  if (href === null) return <span className={`chick-host inline-flex items-center gap-2 ${className ?? ""}`}>{inner}</span>;
  return (
    <Link href={href} aria-label="Perk" className={`chick-host inline-flex shrink-0 items-center gap-2 ${className ?? ""}`}>
      {inner}
    </Link>
  );
}
