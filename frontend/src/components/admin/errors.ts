import { ApiRequestError } from "@/lib/api";
import type { TFn } from "@/i18n/provider";

/** A failed admin API call, in words. */
export function adminErrorText(err: unknown, t: TFn): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 401) return t("admin.error.session");
    if (err.status === 403) return t("admin.error.forbidden");
    if (err.status === 404) return t("admin.error.notFound");
    if (err.status === 400) return t("admin.error.badInput", { message: err.message });
    if (err.status === 429) return t("admin.error.rateLimited");
    if (err.status === 0 || err.status >= 500) return t("admin.error.unreachable");
  }
  return t("admin.error.failed");
}
