"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/api";
import type { AdminLaunch } from "@/lib/api-types";
import { useAdminSession } from "@/lib/admin-session";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { MediaPreview, RequireSession, TokenCell } from "@/components/admin/AdminKit";
import { adminErrorText } from "@/components/admin/errors";
import { useT } from "@/i18n/provider";

export const MAX_FEATURED = 12;

const SEARCH_CLASS =
  "block w-full rounded-full border border-line-strong bg-ink/50 px-4 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-honey focus:ring-2 focus:ring-honey/30";

/** Launches matching an address, name or symbol, hidden ones included. Empty text lists the newest. */
function useLaunchSearch(text: string) {
  const s = useAdminSession();
  const [term, setTerm] = useState(text);
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  return useQuery({
    queryKey: ["admin", "launches", term, s.session?.address],
    enabled: !!s.session,
    queryFn: () => s.call((tok) => adminApi.searchLaunches(tok, term)),
  });
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("admin.search.placeholder")}
      aria-label={t("admin.search.placeholder")}
      spellCheck={false}
      className={SEARCH_CLASS}
    />
  );
}

function StatePills({ item }: { item: AdminLaunch }) {
  const { t } = useT();
  if (item.hidden) return <Pill tone="rose">{t("admin.moderation.hidden")}</Pill>;
  if (item.mediaHidden) return <Pill tone="amber">{t("admin.moderation.mediaHidden")}</Pill>;
  return <Pill tone="muted">{t("admin.moderation.visible")}</Pill>;
}

// ---------------------------------------------------------------------------------------------- moderation

/**
 * Hide a launch from every list on the site, or withhold only its image, description and links. Nothing changes
 * on-chain: the token keeps trading, and its page stays reachable so holders can sell.
 */
export function ModerationPanels() {
  const { t } = useT();
  return (
    <RequireSession title={t("admin.nav.moderation")}>
      <ModerationSearch />
      <ModeratedList />
    </RequireSession>
  );
}

function ModerationSearch() {
  const { t } = useT();
  const [text, setText] = useState("");
  const q = useLaunchSearch(text);
  const results = q.data?.launches ?? [];
  return (
    <Panel title={t("admin.moderation.searchTitle")}>
      <SearchBox value={text} onChange={setText} />
      {results.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{q.isLoading ? "…" : t("admin.search.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {results.map((item) => (
            <ModerationRow key={item.launch.meme} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ModeratedList() {
  const { t } = useT();
  const s = useAdminSession();
  const q = useQuery({
    queryKey: ["admin", "moderation", s.session?.address],
    enabled: !!s.session,
    queryFn: () => s.call(adminApi.moderated),
  });
  const list = q.data?.launches ?? [];
  return (
    <Panel title={t("admin.moderation.currentTitle")}>
      {list.length === 0 ? (
        <p className="text-sm text-subtle">{q.isLoading ? "…" : t("admin.moderation.none")}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((item) => (
            <ModerationRow key={item.launch.meme} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ModerationRow({ item }: { item: AdminLaunch }) {
  const { t } = useT();
  const s = useAdminSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(item.hidden);
  const [mediaHidden, setMediaHidden] = useState(item.mediaHidden);
  const [reason, setReason] = useState(item.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await s.call((tok) =>
        adminApi.setModeration(tok, item.launch.meme, { hidden, mediaHidden: hidden || mediaHidden, reason: reason.trim() || null }),
      );
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
    } catch (e) {
      setError(adminErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TokenCell meme={item.launch.meme} launch={item.launch} image={item.metadata?.image} />
        <span className="flex items-center gap-2">
          <StatePills item={item} />
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="btn-ghost h-8 px-3.5 text-xs font-medium">
            {open ? t("admin.moderation.close") : t("admin.moderation.edit")}
          </button>
        </span>
      </div>
      {item.reason && !open && <p className="mt-1.5 text-[13px] text-subtle">{t("admin.moderation.reasonShown", { reason: item.reason })}</p>}
      <MediaPreview metadata={item.metadata} />
      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-line bg-ink/40 p-4">
          <label className="flex items-start gap-2.5 text-sm leading-relaxed">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--c-flare))]" />
            <span>
              {t("admin.moderation.hide")}
              <span className="block text-xs text-subtle">{t("admin.moderation.hideHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={hidden || mediaHidden}
              disabled={hidden}
              onChange={(e) => setMediaHidden(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--c-flare))]"
            />
            <span>
              {t("admin.moderation.hideMedia")}
              <span className="block text-xs text-subtle">{t("admin.moderation.hideMediaHint")}</span>
            </span>
          </label>
          <label className="block">
            <span className="label">{t("admin.moderation.reason")}</span>
            <input
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5 block w-full rounded-[10px] border border-line-strong bg-ink/50 px-3.5 py-2 text-sm outline-none focus:border-honey focus:ring-2 focus:ring-honey/30"
            />
            <span className="mt-1 block text-xs text-subtle">{t("admin.moderation.reasonHint")}</span>
          </label>
          {error && <p className="text-[13px] text-rose">{error}</p>}
          <div className="max-w-xs">
            <Button onClick={() => void save()} pending={busy} disabled={busy}>
              {t("admin.save")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------- featured

/** The launches the home page features, in order. Saving replaces the whole list. */
export function FeaturedPanels() {
  const { t } = useT();
  return (
    <RequireSession title={t("admin.nav.featured")}>
      <FeaturedEditor />
    </RequireSession>
  );
}

function FeaturedEditor() {
  const { t } = useT();
  const s = useAdminSession();
  const qc = useQueryClient();
  const key = ["admin", "featured", s.session?.address];
  const current = useQuery({ queryKey: key, enabled: !!s.session, queryFn: () => s.call(adminApi.featured) });
  const [draft, setDraft] = useState<AdminLaunch[] | null>(null);
  const [text, setText] = useState("");
  const search = useLaunchSearch(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = draft ?? current.data?.launches ?? [];
  const inList = new Set(list.map((l) => l.launch.meme));
  const edit = (next: AdminLaunch[]) => setDraft(next);
  const move = (i: number, by: number) => {
    const next = [...list];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    edit(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await s.call((tok) => adminApi.setFeatured(tok, list.map((l) => l.launch.meme))));
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["api", "featured"] });
    } catch (e) {
      setError(adminErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title={t("admin.featured.listTitle", { n: list.length, max: MAX_FEATURED })}>
        <p className="text-sm leading-relaxed text-muted">{t("admin.featured.body")}</p>
        {list.length === 0 ? (
          <p className="mt-4 text-sm text-subtle">{current.isLoading ? "…" : t("admin.featured.empty")}</p>
        ) : (
          <ol className="mt-4 divide-y divide-line border-y border-line">
            {list.map((item, i) => (
              <li key={item.launch.meme} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="num w-5 text-right text-[13px] text-subtle">{i + 1}</span>
                  <TokenCell meme={item.launch.meme} launch={item.launch} />
                  {item.hidden && <Pill tone="rose">{t("admin.featured.hidden")}</Pill>}
                </span>
                <span className="flex gap-1.5">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="btn-ghost h-8 w-8 text-sm" aria-label={t("admin.featured.up")}>
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === list.length - 1}
                    onClick={() => move(i, 1)}
                    className="btn-ghost h-8 w-8 text-sm"
                    aria-label={t("admin.featured.down")}
                  >
                    ↓
                  </button>
                  <button type="button" onClick={() => edit(list.filter((_, j) => j !== i))} className="btn-ghost h-8 px-3 text-xs font-medium">
                    {t("admin.featured.remove")}
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        {error && <p className="mt-3 text-[13px] text-rose">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="w-44">
            <Button onClick={() => void save()} pending={busy} disabled={busy || draft === null}>
              {t("admin.save")}
            </Button>
          </span>
          {draft !== null && (
            <button type="button" onClick={() => setDraft(null)} className="btn-ghost px-4 text-sm">
              {t("admin.featured.discard")}
            </button>
          )}
        </div>
      </Panel>
      <Panel title={t("admin.featured.addTitle")}>
        <SearchBox value={text} onChange={setText} />
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {(search.data?.launches ?? [])
            .filter((item) => !inList.has(item.launch.meme))
            .slice(0, 8)
            .map((item) => (
              <li key={item.launch.meme} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="flex min-w-0 items-center gap-3">
                  <TokenCell meme={item.launch.meme} launch={item.launch} />
                  <StatePills item={item} />
                </span>
                <button
                  type="button"
                  disabled={list.length >= MAX_FEATURED || item.hidden}
                  onClick={() => edit([...list, item])}
                  className="btn-ghost h-8 px-3.5 text-xs font-medium"
                >
                  {t("admin.featured.add")}
                </button>
              </li>
            ))}
        </ul>
      </Panel>
    </>
  );
}
