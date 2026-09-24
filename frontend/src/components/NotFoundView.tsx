"use client";

import Link from "next/link";
import { PerkChick } from "@/components/brand/PerkChick";
import { useT } from "@/i18n/provider";

/** The site's "page not found" view: unknown routes, and pages a visitor has no role for. The chick is the zero. */
export function NotFoundView() {
  const { t } = useT();
  return (
    <div className="fade-up mx-auto flex max-w-md flex-col items-center py-20 text-center">
      <p className="chick-host flex items-center font-display text-[88px] leading-none tracking-tight" aria-label="404">
        <span aria-hidden>4</span>
        <PerkChick size={96} mode="follow" className="mx-1" />
        <span aria-hidden>4</span>
      </p>
      <h1 className="mt-6 font-display text-3xl">{t("notFound.title")}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t("notFound.body")}</p>
      <Link href="/" className="btn-primary group mt-7 inline-flex items-center gap-3 px-5 py-3 text-sm">
        {t("notFound.home")}
        <span aria-hidden className="nudge">
          ↗
        </span>
      </Link>
    </div>
  );
}
