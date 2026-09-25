"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress, zeroAddress, type Address } from "viem";
import { lpGrantVaultAbi } from "@/generated/abis";
import { adminApi } from "@/lib/api";
import type { AdminAuditEntry, AdminOperator } from "@/lib/api-types";
import { useAdminRoles } from "@/lib/admin";
import { useAdminSession } from "@/lib/admin-session";
import { useNow, useTx } from "@/lib/hooks";
import { fmtTime, formatRelativeTime, shortAddress } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { Addr, RequireSession } from "@/components/admin/AdminKit";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { adminErrorText } from "@/components/admin/errors";
import { useT, type TFn } from "@/i18n/provider";

const INPUT_CLASS =
  "mono block w-full rounded-full border border-line-strong bg-ink/50 px-4 py-2 text-[13px] outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-honey focus:ring-2 focus:ring-honey/30";

/** Who owns the contracts, and a warning while an ownership transfer is half done. */
export function CoreAdminPanel() {
  const { t } = useT();
  const roles = useAdminRoles();
  const partial = roles.isCore && Object.values(roles.owns).some((v) => !v);
  return (
    <Panel title={t("admin.role.core")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.roles.coreBody")}</p>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3 border-y border-line py-2.5 text-sm">
        <span className="label">{t("admin.roles.holder")}</span>
        {roles.owner ? <Addr value={roles.owner} /> : "—"}
      </div>
      {partial && (
        <Notice tone="amber" className="mt-4">
          {t("admin.roles.ownersDiffer")}
        </Notice>
      )}
      <p className="mt-3 text-[13px] text-subtle">{t("admin.roles.later")}</p>
    </Panel>
  );
}

/** Appoint or revoke the Grant Admin: the vault's publisher, which can publish or cancel allocation lists only. */
export function GrantAdminPanel({ vault, canWrite }: { vault: Address; canWrite: boolean }) {
  const { t } = useT();
  const tx = useTx();
  const roles = useAdminRoles();
  const [input, setInput] = useState("");
  const publisher = roles.publisher;
  const value = input.trim();
  const valid = isAddress(value) && value !== zeroAddress;
  const busy = tx.isPending || tx.isConfirming;
  const appoint = (addr: Address) =>
    tx.write({ address: vault, abi: lpGrantVaultAbi, functionName: "setPublisher", args: [addr] });
  return (
    <Panel title={t("admin.role.grant")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.grantAdmin.body")}</p>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3 border-y border-line py-2.5 text-sm">
        <span className="label">{t("admin.roles.holder")}</span>
        {publisher ? <Addr value={publisher} /> : <span className="text-subtle">{t("admin.grantAdmin.none")}</span>}
      </div>
      <label className="mt-4 block">
        <span className="label">{t("admin.grantAdmin.new")}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className={`${INPUT_CLASS} mt-1.5`}
        />
        {value !== "" && !valid && <span className="mt-1 block text-xs text-rose">{t("admin.invalidAddress")}</span>}
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button tx={tx} disabled={!canWrite || busy || !valid} onClick={() => appoint(value as Address)}>
          {publisher ? t("admin.grantAdmin.replace") : t("admin.grantAdmin.appoint")}
        </Button>
        <Button variant="ghost" disabled={!canWrite || busy || !publisher} onClick={() => appoint(zeroAddress)}>
          {t("admin.grantAdmin.revoke")}
        </Button>
      </div>
      <TxStatus tx={tx} />
    </Panel>
  );
}

/** General Admins: added and removed by the Core Admin, stored by the API. */
export function GeneralAdminsPanel() {
  const { t, locale } = useT();
  return (
    <Panel title={t("admin.role.operator")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.operators.body")}</p>
      <RequireSession>
        <OperatorList locale={locale} />
      </RequireSession>
    </Panel>
  );
}

function OperatorList({ locale }: { locale: string }) {
  const { t } = useT();
  const s = useAdminSession();
  const qc = useQueryClient();
  const key = ["admin", "operators", s.session?.address];
  const list = useQuery({ queryKey: key, enabled: !!s.session, queryFn: () => s.call(adminApi.operators) });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = input.trim();
  const valid = isAddress(value);

  const run = async (fn: (token: string) => Promise<{ operators: AdminOperator[] }>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await s.call(fn));
      void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
      return true;
    } catch (e) {
      setError(adminErrorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const operators = list.data?.operators ?? [];
  return (
    <div className="mt-4">
      {list.isLoading ? (
        <p className="text-sm text-subtle">…</p>
      ) : operators.length === 0 ? (
        <p className="text-sm text-subtle">{t("admin.operators.empty")}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {operators.map((o) => (
            <li key={o.address} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <Addr value={o.address} />
                <span className="block text-xs text-subtle">
                  {t("admin.operators.added", { time: fmtTime(o.addedAt, locale), by: shortAddress(o.addedBy) })}
                </span>
              </span>
              <ConfirmButton disabled={busy} onConfirm={() => void run((tok) => adminApi.removeOperator(tok, o.address))}>
                {t("admin.operators.remove")}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void run((tok) => adminApi.addOperator(tok, value)).then((ok) => ok && setInput(""));
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          aria-label={t("admin.operators.new")}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={!valid || busy} className="btn-primary h-9 shrink-0 px-5 text-sm font-semibold">
          {t("admin.operators.add")}
        </button>
      </form>
      {value !== "" && !valid && <p className="mt-1 text-xs text-rose">{t("admin.invalidAddress")}</p>}
      {error && <p className="mt-2 text-[13px] text-rose">{error}</p>}
    </div>
  );
}

/** What admins changed off-chain, newest first. On-chain changes have their own history on the explorer. */
export function ActivityPanel() {
  const { t } = useT();
  return (
    <Panel title={t("admin.audit.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.audit.body")}</p>
      <RequireSession>
        <AuditList />
      </RequireSession>
    </Panel>
  );
}

function AuditList() {
  const { t, locale } = useT();
  const s = useAdminSession();
  const now = useNow();
  const q = useQuery({
    queryKey: ["admin", "audit", s.session?.address],
    enabled: !!s.session,
    queryFn: () => s.call((tok) => adminApi.audit(tok, 50)),
    refetchInterval: 30_000,
  });
  const entries = q.data?.entries ?? [];
  if (q.isLoading) return <p className="mt-4 text-sm text-subtle">…</p>;
  if (entries.length === 0) return <p className="mt-4 text-sm text-subtle">{t("admin.audit.empty")}</p>;
  return (
    <ul className="mt-4 divide-y divide-line border-y border-line">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-[13px]">
          <span className="min-w-0">
            <span className="text-bone">{auditLabel(e, t)}</span>
            {e.target && <span className="mono ml-2 text-subtle">{shortAddress(e.target)}</span>}
          </span>
          <span className="text-subtle" title={fmtTime(e.at, locale)}>
            <span className="mono">{shortAddress(e.address)}</span> · {formatRelativeTime(e.at, now, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function auditLabel(e: AdminAuditEntry, t: TFn): string {
  if (e.action === "moderation") {
    const d = (e.detail ?? {}) as { hidden?: boolean; mediaHidden?: boolean };
    return t(d.hidden ? "admin.audit.hid" : d.mediaHidden ? "admin.audit.hidMedia" : "admin.audit.restored");
  }
  const known = ["sign_in", "operator_add", "operator_remove", "featured", "quote_display"];
  return known.includes(e.action) ? t(`admin.audit.${e.action}`) : e.action;
}
