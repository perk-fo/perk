"use client";

import Link from "next/link";
import { useT } from "@/i18n/provider";

/** The site's "page not found" view: unknown routes, and pages a visitor has no role for. */
export function NotFoundView() {
  const { t } = useT();
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="num text-sm text-subtle">404</p>
      <h1 className="mt-2 font-display text-3xl">{t("notFound.title")}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t("notFound.body")}</p>
      <Link href="/" className="btn-ghost mt-6 inline-flex px-5 py-2 text-sm">
        {t("notFound.home")}
      </Link>
    </div>
  );
}
