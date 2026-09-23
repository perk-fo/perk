"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { assetRegistryAbi, moduleRegistryAbi, templateRegistryAbi } from "@/generated/abis";
import { adminApi } from "@/lib/api";
import type { QuoteAsset, QuoteCategory, QuoteDisplayUpdate, QuoteNotice } from "@/lib/api-types";
import { useQuoteAssets } from "@/lib/api-hooks";
import { useAdminRoles } from "@/lib/admin";
import { useAdminSession } from "@/lib/admin-session";
import { useDeployment, useTx } from "@/lib/hooks";
import { uploadImage } from "@/lib/media";
import { templateIdFor } from "@/lib/templates";
import {
  MODULE_IDS_V1,
  defaultNumbers,
  fastNumbers,
  forQuote,
  perkGrantV1,
  standardCurveV1,
  templateProblem,
  withThreshold,
  type TemplateStruct,
} from "@/lib/template-numbers";
import { formatAmount, shortAddress } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { RequireSession } from "@/components/admin/AdminKit";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { adminErrorText } from "@/components/admin/errors";
import { useT } from "@/i18n/provider";

const CATEGORIES: QuoteCategory[] = ["native", "ecosystem", "rwa", "stablecoin", "other"];
const LOCALES: Array<keyof QuoteNotice> = ["en", "zh-CN", "ja"];
const CONTROL =
  "block w-full rounded-[10px] border border-line-strong bg-ink/50 px-3.5 py-2 text-sm text-bone outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-flare focus:ring-2 focus:ring-flare/20";

// ---------------------------------------------------------------------------------------------- the list

/**
 * Every quote currency the asset registry knows. Whether new launches may use one is on-chain (Core Admin);
 * how the site shows it is off-chain (General Admins and the Core Admin).
 */
export function QuoteAssetsPanel() {
  const { t } = useT();
  const assets = useQuoteAssets();
  const list = assets.data?.assets ?? [];
  return (
    <Panel title={t("admin.assets.listTitle")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.assets.listBody")}</p>
      {assets.isError ? (
        <p className="mt-4 text-sm text-rose">{t("admin.error.unreachable")}</p>
      ) : list.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{assets.isLoading ? "…" : t("admin.assets.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {list.map((a) => (
            <AssetRow key={a.address} asset={a} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AssetRow({ asset }: { asset: QuoteAsset }) {
  const { t } = useT();
  const roles = useAdminRoles();
  const [editing, setEditing] = useState(false);
  const allowed = asset.enabled && asset.rewardCompatible;
  const category = asset.display.category;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AssetIcon asset={asset} />
          <span className="min-w-0">
            <span className="block truncate text-sm text-bone">
              {asset.display.displayName ?? asset.symbol}
              {asset.display.displayName && <span className="ml-2 text-xs text-subtle">{asset.symbol}</span>}
            </span>
            <span className="mono block text-xs text-subtle">{asset.isNative ? t("admin.assets.native") : shortAddress(asset.address)}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={allowed ? "verdigris" : "rose"}>{allowed ? t("admin.assets.allowed") : t("admin.assets.notAllowed")}</Pill>
          <Pill tone={asset.activeTemplates > 0 ? "muted" : "amber"}>
            {asset.activeTemplates > 0 ? t("admin.assets.templates", { n: asset.activeTemplates }) : t("admin.assets.noTemplates")}
          </Pill>
          {!asset.display.listed && <Pill tone="muted">{t("admin.assets.unlisted")}</Pill>}
          {category && <Pill tone="muted">{t(`quote.category.${category}`)}</Pill>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing((v) => !v)} className="btn-ghost h-8 px-3.5 text-xs font-medium" aria-expanded={editing}>
          {editing ? t("admin.assets.closeEditor") : t("admin.assets.editDisplay")}
        </button>
        {roles.isCore && <ChainToggle asset={asset} canWrite={roles.owns.assets} />}
      </div>
      {editing && (
        <div className="mt-3 rounded-xl border border-line bg-ink/40 p-4">
          <RequireSession>
            <DisplayEditor asset={asset} onSaved={() => setEditing(false)} />
          </RequireSession>
        </div>
      )}
    </li>
  );
}

function AssetIcon({ asset }: { asset: QuoteAsset }) {
  if (asset.display.iconUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.display.iconUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" loading="lazy" />;
  }
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold text-muted" aria-hidden>
      {asset.symbol.slice(0, 3)}
    </span>
  );
}

/** Core Admin: allow or stop new launches against this currency (AssetRegistry.setAsset). Existing launches go on. */
function ChainToggle({ asset, canWrite }: { asset: QuoteAsset; canWrite: boolean }) {
  const { t } = useT();
  const { deployment } = useDeployment();
  const tx = useTx();
  const busy = tx.isPending || tx.isConfirming;
  if (!deployment?.assetRegistry) return null;
  const allowed = asset.enabled && asset.rewardCompatible;
  const set = (enabled: boolean) =>
    tx.write({
      address: deployment.assetRegistry!,
      abi: assetRegistryAbi,
      functionName: "setAsset",
      args: [
        asset.address,
        { enabled, rewardCompatible: true, isNative: asset.isNative, decimals: asset.decimals, symbol: asset.symbol },
      ],
    });
  return (
    <>
      {allowed ? (
        <ConfirmButton disabled={!canWrite || busy} onConfirm={() => set(false)}>
          {t("admin.assets.disable")}
        </ConfirmButton>
      ) : (
        <button type="button" disabled={!canWrite || busy} onClick={() => set(true)} className="btn-ghost h-8 px-3.5 text-xs font-medium">
          {t("admin.assets.enable")}
        </button>
      )}
      <div className="basis-full">
        <TxStatus tx={tx} />
      </div>
    </>
  );
}

/** How the site shows a currency: name, icon, category, risk notice per language, order, and whether it is offered. */
function DisplayEditor({ asset, onSaved }: { asset: QuoteAsset; onSaved: () => void }) {
  const { t } = useT();
  const s = useAdminSession();
  const qc = useQueryClient();
  const d = asset.display;
  const [displayName, setDisplayName] = useState(d.displayName ?? "");
  const [iconUrl, setIconUrl] = useState(d.iconUrl ?? "");
  const [category, setCategory] = useState<QuoteCategory | "">(d.category ?? "");
  const [notice, setNotice] = useState<QuoteNotice>(d.notice);
  const [sortOrder, setSortOrder] = useState(String(d.sortOrder));
  const [listed, setListed] = useState(d.listed);
  const [busy, setBusy] = useState<"upload" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const order = Number(sortOrder);
  const orderValid = Number.isInteger(order) && order >= -1000 && order <= 1000;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy("upload");
    setError(null);
    try {
      setIconUrl((await uploadImage(file)).url);
    } catch (e) {
      setError(adminErrorText(e, t));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    const body: QuoteDisplayUpdate = {
      displayName: displayName.trim() || null,
      iconUrl: iconUrl.trim() || null,
      category: category || null,
      notice,
      sortOrder: order,
      listed,
    };
    try {
      await s.call((tok) => adminApi.setQuoteDisplay(tok, asset.address, body));
      await qc.invalidateQueries({ queryKey: ["api", "quote-assets"] });
      onSaved();
    } catch (e) {
      setError(adminErrorText(e, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">{t("admin.assets.displayName")}</span>
          <input value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder={asset.symbol} className={`${CONTROL} mt-1.5`} />
        </label>
        <label className="block">
          <span className="label">{t("admin.assets.category")}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as QuoteCategory | "")} className={`${CONTROL} mt-1.5`}>
            <option value="">{t("admin.assets.categoryDefault")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`quote.category.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="label">{t("admin.assets.icon")}</span>
          <span className="mt-1.5 flex gap-2">
            <input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} placeholder="https://… / ipfs://…" spellCheck={false} className={`${CONTROL} mono text-[13px]`} />
            <span className="btn-ghost relative inline-flex h-9 shrink-0 cursor-pointer items-center px-3.5 text-xs font-medium">
              {busy === "upload" ? "…" : t("admin.assets.upload")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(e) => void upload(e.target.files?.[0])}
                disabled={busy !== null}
                aria-label={t("admin.assets.upload")}
              />
            </span>
          </span>
        </label>
      </div>
      <fieldset>
        <legend className="label">{t("admin.assets.notice")}</legend>
        <p className="mt-1 text-xs text-subtle">{t("admin.assets.noticeHint")}</p>
        <div className="mt-2 grid gap-3 lg:grid-cols-3">
          {LOCALES.map((l) => (
            <label key={l} className="block">
              <span className="text-xs text-muted">{t(`admin.assets.locale.${l}`)}</span>
              <textarea
                value={notice[l] ?? ""}
                maxLength={600}
                onChange={(e) => setNotice((n) => ({ ...n, [l]: e.target.value }))}
                className={`${CONTROL} mt-1 h-24 resize-y`}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block w-32">
          <span className="label">{t("admin.assets.sortOrder")}</span>
          <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" className={`${CONTROL} num mt-1.5`} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--c-flare))]" />
          {t("admin.assets.listed")}
        </label>
      </div>
      {error && <p className="text-[13px] text-rose">{error}</p>}
      <div className="max-w-xs">
        <Button onClick={() => void save()} pending={busy === "save"} disabled={busy !== null || !orderValid}>
          {t("admin.save")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- listing a new one

interface Step {
  key: string;
  label: string;
  done: boolean;
  /** The wallet cannot send this one (it does not own that registry). */
  blocked: boolean;
  run: () => void;
}

/**
 * Core Admin: make a new ERC-20 usable as a quote currency, as contracts/script/ConfigureQuoteAsset.s.sol does.
 * Allow it in the asset registry, mark it compatible with each V1 module, and register the launch templates bound to
 * it, with curve numbers in its own decimals. Every step is its own transaction and the list shows what is already
 * done, so an interrupted listing picks up where it stopped.
 */
export function NewQuotePanel() {
  const { t, locale } = useT();
  const { chainId, deployment } = useDeployment();
  const roles = useAdminRoles();
  const tx = useTx();
  const [input, setInput] = useState("");
  const [thresholdInput, setThresholdInput] = useState("85");
  const [withFast, setWithFast] = useState(chainId === 1952);
  const [checks, setChecks] = useState([false, false, false]);

  const raw = input.trim();
  const token = isAddress(raw) ? (getAddress(raw) as Address) : undefined;

  const meta = useReadContracts({
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: "symbol" },
          { address: token, abi: erc20Abi, functionName: "decimals" },
          { address: token, abi: erc20Abi, functionName: "name" },
        ]
      : [],
    query: { enabled: !!token },
  });
  const symbol = meta.data?.[0]?.result as string | undefined;
  const decimals = meta.data?.[1]?.result as number | undefined;
  const name = meta.data?.[2]?.result as string | undefined;
  const isToken = !!token && symbol !== undefined && decimals !== undefined;

  const bases = useMemo(
    () => ["PERK_GRANT_V1", "STANDARD_CURVE_V1", ...(chainId === 1952 ? ["TEST_FAST_V1"] : [])],
    [chainId],
  );
  const ready = isToken && !!deployment?.assetRegistry && !!deployment.moduleRegistry;
  const assetState = useReadContracts({
    contracts: ready
      ? [{ address: deployment!.assetRegistry!, abi: assetRegistryAbi, functionName: "assetInfo" as const, args: [token!] as const }]
      : [],
    query: { enabled: ready, refetchInterval: 10_000 },
  });
  const moduleState = useReadContracts({
    contracts: ready
      ? MODULE_IDS_V1.map((m) => ({
          address: deployment!.moduleRegistry!,
          abi: moduleRegistryAbi,
          functionName: "isQuoteCompatible" as const,
          args: [m.id, 1, token!] as const,
        }))
      : [],
    query: { enabled: ready, refetchInterval: 10_000 },
  });
  const templateState = useReadContracts({
    contracts: ready
      ? bases.map((b) => ({
          address: deployment!.templateRegistry,
          abi: templateRegistryAbi,
          functionName: "isActive" as const,
          args: [templateIdFor(b, token!)] as const,
        }))
      : [],
    query: { enabled: ready, refetchInterval: 10_000 },
  });
  const info = assetState.data?.[0]?.result as { enabled: boolean; rewardCompatible: boolean; decimals: number } | undefined;
  const compatible = MODULE_IDS_V1.map((_, i) => moduleState.data?.[i]?.result === true);
  const active = bases.map((_, i) => templateState.data?.[i]?.result === true);
  const loaded = !!assetState.data && !!moduleState.data && !!templateState.data;

  // Once one bound template exists its threshold is fixed on-chain; the others must match it.
  const firstActive = bases.findIndex((b, i) => active[i] && b !== "TEST_FAST_V1");
  const existing = useReadContracts({
    contracts:
      token && firstActive >= 0
        ? [{ address: deployment!.templateRegistry, abi: templateRegistryAbi, functionName: "getTemplate" as const, args: [templateIdFor(bases[firstActive]!, token)] as const }]
        : [],
    query: { enabled: !!token && firstActive >= 0 },
  });
  const lockedThreshold = (existing.data?.[0]?.result as TemplateStruct | undefined)?.curve.graduationQuoteThreshold;
  useEffect(() => {
    if (lockedThreshold !== undefined && decimals !== undefined) setThresholdInput(formatUnits(lockedThreshold, decimals));
  }, [lockedThreshold, decimals]);

  const threshold = useMemo(() => {
    if (decimals === undefined) return null;
    try {
      const v = parseUnits(thresholdInput.trim() || "0", decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [thresholdInput, decimals]);

  const templates = useMemo(() => {
    if (!token || decimals === undefined || threshold === null) return [];
    const n = withThreshold(forQuote(defaultNumbers(), token, decimals), threshold);
    return bases
      .filter((b) => b !== "TEST_FAST_V1" || withFast)
      .map((b) => ({
        base: b,
        struct: b === "PERK_GRANT_V1" ? perkGrantV1(n) : b === "STANDARD_CURVE_V1" ? standardCurveV1(n) : perkGrantV1(fastNumbers(n)),
      }));
  }, [token, decimals, threshold, bases, withFast]);
  const problems = templates.map((x) => ({ base: x.base, problem: templateProblem(x.struct) })).filter((p) => p.problem);

  const listedOnChain = !!info && info.enabled && info.rewardCompatible && info.decimals === decimals;
  const steps: Step[] = !token || !isToken || !deployment
    ? []
    : [
        {
          key: "asset",
          label: t("admin.newQuote.step.asset", { symbol: symbol! }),
          done: listedOnChain,
          blocked: !roles.owns.assets,
          run: () =>
            tx.write({
              address: deployment.assetRegistry!,
              abi: assetRegistryAbi,
              functionName: "setAsset",
              args: [token, { enabled: true, rewardCompatible: true, isNative: false, decimals: decimals!, symbol: symbol! }],
            }),
        },
        ...MODULE_IDS_V1.map((m, i) => ({
          key: `module.${m.name}`,
          label: t("admin.newQuote.step.module", { module: m.name }),
          done: compatible[i]!,
          blocked: !roles.owns.modules,
          run: () =>
            tx.write({
              address: deployment.moduleRegistry!,
              abi: moduleRegistryAbi,
              functionName: "setQuoteCompatibility",
              args: [m.id, 1, token, true],
            }),
        })),
        ...templates.map((x) => ({
          key: `template.${x.base}`,
          label: t("admin.newQuote.step.template", { template: t(`admin.newQuote.template.${x.base}`) }),
          done: active[bases.indexOf(x.base)]!,
          blocked: !roles.owns.templates,
          run: () =>
            tx.write({
              address: deployment.templateRegistry,
              abi: templateRegistryAbi,
              functionName: "registerTemplate",
              args: [templateIdFor(x.base, token), x.struct],
            }),
        })),
      ];
  const next = steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const allConfirmed = listedOnChain || checks.every(Boolean);
  const busy = tx.isPending || tx.isConfirming;
  const canRun = !!next && !next.blocked && !busy && allConfirmed && problems.length === 0 && threshold !== null;

  const reserve = templates[0]?.struct.curve.virtualQuoteReserve;

  return (
    <Panel title={t("admin.newQuote.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.newQuote.body")}</p>
      <label className="mt-4 block">
        <span className="label">{t("admin.newQuote.address")}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className={`${CONTROL} mono mt-1.5 text-[13px]`}
        />
      </label>
      {raw !== "" && !token && <p className="mt-1 text-xs text-rose">{t("admin.invalidAddress")}</p>}
      {token && meta.isLoading && <p className="mt-3 text-sm text-subtle">{t("admin.newQuote.reading")}</p>}
      {token && !meta.isLoading && !isToken && <p className="mt-3 text-sm text-rose">{t("admin.newQuote.notToken")}</p>}

      {isToken && (
        <div className="mt-5 space-y-5">
          <dl className="grid grid-cols-3 gap-3 rounded-xl border border-line p-3 text-sm">
            <div>
              <dt className="label">{t("admin.newQuote.name")}</dt>
              <dd className="mt-0.5 truncate">{name ?? "—"}</dd>
            </div>
            <div>
              <dt className="label">{t("admin.newQuote.symbol")}</dt>
              <dd className="mt-0.5">{symbol}</dd>
            </div>
            <div>
              <dt className="label">{t("admin.newQuote.decimals")}</dt>
              <dd className="num mt-0.5">{decimals}</dd>
            </div>
          </dl>

          {!listedOnChain && (
            <fieldset>
              <legend className="label">{t("admin.newQuote.checks")}</legend>
              <div className="mt-2 space-y-2">
                {checks.map((c, i) => (
                  <label key={i} className="flex items-start gap-2.5 text-sm leading-relaxed">
                    <input
                      type="checkbox"
                      checked={c}
                      onChange={(e) => setChecks((v) => v.map((x, j) => (j === i ? e.target.checked : x)))}
                      className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--c-flare))]"
                    />
                    <span>{t(`admin.newQuote.check.${i}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">{t("admin.newQuote.threshold", { symbol: symbol! })}</span>
              <input
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                inputMode="decimal"
                disabled={lockedThreshold !== undefined}
                className={`${CONTROL} num mt-1.5 disabled:opacity-70`}
              />
              <span className="mt-1 block text-xs text-subtle">
                {lockedThreshold !== undefined
                  ? t("admin.newQuote.thresholdLocked")
                  : reserve !== undefined
                    ? t("admin.newQuote.thresholdHint", { reserve: formatAmount(reserve, decimals!, { locale, maxFrac: 6 }), symbol: symbol! })
                    : t("admin.newQuote.thresholdBad")}
              </span>
            </label>
            {chainId === 1952 && (
              <label className="flex items-start gap-2.5 pt-6 text-sm leading-relaxed">
                <input
                  type="checkbox"
                  checked={withFast}
                  onChange={(e) => setWithFast(e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--c-flare))]"
                />
                <span>{t("admin.newQuote.fast")}</span>
              </label>
            )}
          </div>
          {problems.length > 0 && (
            <Notice tone="rose">
              {problems.map((p) => (
                <span key={p.base} className="block">
                  {t(`admin.newQuote.template.${p.base}`)}: {t(`admin.newQuote.problem.${p.problem}`)}
                </span>
              ))}
            </Notice>
          )}

          <div>
            <p className="label">{t("admin.newQuote.progress", { done: doneCount, total: steps.length })}</p>
            <ol className="mt-2 divide-y divide-line border-y border-line">
              {steps.map((s, i) => (
                <li key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${
                        s.done ? "bg-verdigris/15 text-verdigris" : s === next ? "bg-flare/15 text-flare" : "bg-raised text-subtle"
                      }`}
                      aria-hidden
                    >
                      {s.done ? "✓" : i + 1}
                    </span>
                    <span className={s.done ? "text-muted" : "text-bone"}>{s.label}</span>
                  </span>
                  {!s.done && s.blocked && <span className="text-xs text-rose">{t("admin.newQuote.notOwner")}</span>}
                </li>
              ))}
            </ol>
          </div>

          {!loaded ? null : next ? (
            <div className="max-w-sm">
              <Button tx={tx} disabled={!canRun} onClick={() => next.run()}>
                {t("admin.newQuote.run", { step: doneCount + 1, total: steps.length })}
              </Button>
              {!allConfirmed && <p className="mt-2 text-xs text-subtle">{t("admin.newQuote.confirmFirst")}</p>}
              <TxStatus tx={tx} />
            </div>
          ) : (
            <div className="rounded-xl border border-verdigris/25 bg-verdigris/[0.07] px-4 py-3 text-sm leading-relaxed text-bone">
              <p className="mb-1 text-[13px] font-medium text-verdigris">{t("admin.newQuote.doneTitle")}</p>
              {t("admin.newQuote.done", { symbol: symbol! })}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
