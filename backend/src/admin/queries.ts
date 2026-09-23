import type { Db } from "../db/client";
import type { AppConfig } from "../config";
import type {
  AdminAuditEntry,
  AdminLaunch,
  AdminOperator,
  QuoteAsset,
  QuoteCategory,
  QuoteDisplayUpdate,
  QuoteNotice,
} from "../api/types";
import { LAUNCH_24H_SELECT, LAUNCH_COLUMNS, launchFrom } from "../api/queries";
import { mapLaunchSummary, mapTokenMetadata, type LaunchRow } from "../api/mappers";
import { addr, num, numNull } from "../api/serialize";
import { browserImageUrl } from "../media/metadata";

const ZERO = "0x0000000000000000000000000000000000000000";

function unix(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.floor(new Date(v).getTime() / 1000);
}

// ---------------------------------------------------------------- audit

export async function audit(db: Db, address: string, action: string, target: string | null, detail?: unknown): Promise<void> {
  await db`insert into admin_audit (address, action, target, detail)
    values (${address.toLowerCase()}, ${action}, ${target}, ${detail === undefined ? null : db.json(detail as never)})`;
}

export async function selectAudit(db: Db, limit: number): Promise<AdminAuditEntry[]> {
  const rows = await db<{ id: string | bigint; at: Date; address: string; action: string; target: string | null; detail: unknown }[]>`
    select id, at, address, action, target, detail from admin_audit order by id desc limit ${limit}`;
  return rows.map((r) => ({
    id: Number(r.id),
    at: unix(r.at) ?? 0,
    address: addr(r.address),
    action: r.action,
    target: r.target,
    detail: r.detail ?? null,
  }));
}

// ---------------------------------------------------------------- General Admins

export async function selectOperators(db: Db): Promise<AdminOperator[]> {
  const rows = await db<{ address: string; added_by: string; added_at: Date }[]>`
    select address, added_by, added_at from admin_operators order by added_at asc`;
  return rows.map((r) => ({ address: addr(r.address), addedBy: addr(r.added_by), addedAt: unix(r.added_at) ?? 0 }));
}

/** true when the address was not a General Admin before. */
export async function insertOperator(db: Db, address: string, addedBy: string): Promise<boolean> {
  const rows = await db`insert into admin_operators (address, added_by) values (${address}, ${addedBy.toLowerCase()})
    on conflict (address) do nothing returning address`;
  return rows.length > 0;
}

/** true when the address was a General Admin. */
export async function deleteOperator(db: Db, address: string): Promise<boolean> {
  const rows = await db`delete from admin_operators where address = ${address} returning address`;
  return rows.length > 0;
}

// ---------------------------------------------------------------- launches as admins see them

type AdminLaunchRow = LaunchRow & {
  mod_reason: string | null;
  mod_updated_by: string | null;
  mod_updated_at: Date | null;
  featured_position: number | null;
};

const ADMIN_EXTRA = `lm.reason as mod_reason, lm.updated_by as mod_updated_by, lm.updated_at as mod_updated_at,
  (select lf.position from launch_featured lf where lf.chain_id = l.chain_id and lf.meme = l.meme) as featured_position`;

function mapAdminLaunch(row: AdminLaunchRow): AdminLaunch {
  const launch = mapLaunchSummary(row);
  return {
    launch,
    metadata: mapTokenMetadata(row),
    hidden: Boolean(row.mod_hidden),
    mediaHidden: Boolean(row.mod_hidden) || Boolean(row.mod_media_hidden),
    reason: row.mod_reason ?? null,
    featuredPosition: numNull(row.featured_position),
    updatedBy: row.mod_updated_by ? addr(row.mod_updated_by) : null,
    updatedAt: unix(row.mod_updated_at),
  };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Launches whose address, name or symbol match `q` (newest first), hidden ones included. */
export async function searchLaunches(db: Db, chainId: number, q: string, now: number, limit = 20): Promise<AdminLaunch[]> {
  const cutoff = now - 86_400;
  const term = q.trim().toLowerCase();
  const rows = await db.unsafe<AdminLaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}, ${ADMIN_EXTRA}
     ${launchFrom(cutoff)}
     where l.chain_id = $1
       and ($2 = '' or l.meme like $3 or l.name ilike $4 or l.symbol ilike $4)
     order by l.created_block desc, l.created_log_index desc
     limit $5`,
    [chainId, term, `${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, likePattern(term), limit],
  );
  return rows.map(mapAdminLaunch);
}

/** Launches with any moderation in force, most recently changed first. */
export async function selectModerated(db: Db, chainId: number, now: number): Promise<AdminLaunch[]> {
  const cutoff = now - 86_400;
  const rows = await db.unsafe<AdminLaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}, ${ADMIN_EXTRA}
     ${launchFrom(cutoff)}
     where l.chain_id = $1 and (lm.hidden or lm.media_hidden)
     order by lm.updated_at desc`,
    [chainId],
  );
  return rows.map(mapAdminLaunch);
}

export async function selectAdminLaunch(db: Db, chainId: number, meme: string, now: number): Promise<AdminLaunch | null> {
  const cutoff = now - 86_400;
  const rows = await db.unsafe<AdminLaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}, ${ADMIN_EXTRA}
     ${launchFrom(cutoff)}
     where l.chain_id = $1 and l.meme = $2`,
    [chainId, meme],
  );
  return rows[0] ? mapAdminLaunch(rows[0]) : null;
}

/** Sets or clears a launch's moderation. Both flags false removes the row. */
export async function upsertModeration(
  db: Db,
  chainId: number,
  meme: string,
  update: { hidden: boolean; mediaHidden: boolean; reason: string | null },
  by: string,
): Promise<void> {
  if (!update.hidden && !update.mediaHidden) {
    await db`delete from launch_moderation where chain_id = ${chainId} and meme = ${meme}`;
    return;
  }
  await db`insert into launch_moderation (chain_id, meme, hidden, media_hidden, reason, updated_by, updated_at)
    values (${chainId}, ${meme}, ${update.hidden}, ${update.mediaHidden}, ${update.reason}, ${by.toLowerCase()}, now())
    on conflict (chain_id, meme) do update set
      hidden = excluded.hidden, media_hidden = excluded.media_hidden, reason = excluded.reason,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
}

// ---------------------------------------------------------------- featured

/** The home page's featured launches, in order. Hidden launches drop out without losing their slot. */
export async function selectFeatured(db: Db, chainId: number, now: number, opts: { includeHidden?: boolean } = {}): Promise<LaunchRow[]> {
  const cutoff = now - 86_400;
  return db.unsafe<LaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}
     ${launchFrom(cutoff)}
     join launch_featured lf on lf.chain_id = l.chain_id and lf.meme = l.meme
     where l.chain_id = $1 ${opts.includeHidden ? "" : "and not coalesce(lm.hidden, false)"}
     order by lf.position asc`,
    [chainId],
  );
}

/** Replace the featured list. Callers check that every meme is an indexed launch. */
export async function replaceFeatured(db: Db, chainId: number, memes: string[], by: string): Promise<void> {
  await db.begin(async (tx) => {
    await tx`delete from launch_featured where chain_id = ${chainId}`;
    for (const [i, meme] of memes.entries()) {
      await tx`insert into launch_featured (chain_id, meme, position, updated_by) values (${chainId}, ${meme}, ${i + 1}, ${by.toLowerCase()})`;
    }
  });
}

export async function existingLaunches(db: Db, chainId: number, memes: string[]): Promise<Set<string>> {
  if (memes.length === 0) return new Set();
  const rows = await db<{ meme: string }[]>`select meme from launches where chain_id = ${chainId} and meme in ${db(memes)}`;
  return new Set(rows.map((r) => r.meme));
}

// ---------------------------------------------------------------- quote currencies

interface QuoteRow {
  quote: string;
  symbol: string | null;
  name: string | null;
  decimals: number | string;
  kind: number | string | null;
  allowed: boolean | null;
  info: { enabled?: boolean; rewardCompatible?: boolean } | null;
  active_templates: number | string;
  display_name: string | null;
  icon_url: string | null;
  category: string | null;
  notice: unknown;
  sort_order: number | string | null;
  listed: boolean | null;
  updated_at: Date | null;
}

const CATEGORIES = new Set<QuoteCategory>(["native", "ecosystem", "rwa", "stablecoin", "other"]);
const NOTICE_LOCALES = ["en", "zh-CN", "ja"] as const;

function mapNotice(v: unknown): QuoteNotice {
  const out: QuoteNotice = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const l of NOTICE_LOCALES) {
    const s = (v as Record<string, unknown>)[l];
    if (typeof s === "string" && s.trim() !== "") out[l] = s;
  }
  return out;
}

function mapQuote(r: QuoteRow, config: AppConfig): QuoteAsset {
  const isNative = r.quote === ZERO;
  const enabled = r.info?.enabled ?? Boolean(r.allowed);
  const icon = r.icon_url ? browserImageUrl(r.icon_url, config.publicApiUrl, config.ipfsGateway) : null;
  return {
    address: addr(r.quote),
    symbol: r.symbol ?? "?",
    name: r.name,
    decimals: num(r.decimals),
    isNative,
    kind: numNull(r.kind),
    enabled: Boolean(enabled),
    rewardCompatible: Boolean(r.info?.rewardCompatible ?? isNative),
    activeTemplates: num(r.active_templates),
    display: {
      displayName: r.display_name,
      iconUrl: icon,
      category: r.category && CATEGORIES.has(r.category as QuoteCategory) ? (r.category as QuoteCategory) : null,
      notice: mapNotice(r.notice),
      sortOrder: num(r.sort_order ?? 0),
      listed: r.listed ?? true,
      updatedAt: unix(r.updated_at),
    },
  };
}

/** Every quote asset the registry has ever listed, with its display settings, in picker order. */
export async function selectQuoteAssets(db: Db, config: AppConfig): Promise<QuoteAsset[]> {
  const rows = await db<QuoteRow[]>`
    select qa.quote, qa.symbol, qa.name, qa.decimals, qa.kind, qa.allowed, qa.info,
      (select count(*)::int from templates t
        where t.chain_id = qa.chain_id and t.status = 2 and lower(t.template->>'quote') = qa.quote
          and coalesce((t.template->>'anyQuote')::boolean, false) = false) as active_templates,
      d.display_name, d.icon_url, d.category, d.notice, d.sort_order, d.listed, d.updated_at
    from quote_assets qa
    left join quote_asset_display d on d.chain_id = qa.chain_id and d.quote = qa.quote
    where qa.chain_id = ${config.chainId}
    order by coalesce(d.sort_order, 0) asc, (qa.quote = ${ZERO}) desc, qa.symbol asc`;
  return rows.map((r) => mapQuote(r, config));
}

export async function upsertQuoteDisplay(db: Db, chainId: number, quote: string, d: QuoteDisplayUpdate, by: string): Promise<void> {
  await db`insert into quote_asset_display
      (chain_id, quote, display_name, icon_url, category, notice, sort_order, listed, updated_by, updated_at)
    values (${chainId}, ${quote}, ${d.displayName}, ${d.iconUrl}, ${d.category}, ${db.json(d.notice as never)},
      ${d.sortOrder}, ${d.listed}, ${by.toLowerCase()}, now())
    on conflict (chain_id, quote) do update set
      display_name = excluded.display_name, icon_url = excluded.icon_url, category = excluded.category,
      notice = excluded.notice, sort_order = excluded.sort_order, listed = excluded.listed,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
}

export async function quoteAssetExists(db: Db, chainId: number, quote: string): Promise<boolean> {
  const rows = await db`select 1 from quote_assets where chain_id = ${chainId} and quote = ${quote}`;
  return rows.length > 0;
}
