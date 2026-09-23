"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { lpGrantVaultAbi } from "@/generated/abis";
import { api } from "@/lib/api";
import type { GrantCampaign } from "@/lib/api-types";
import { useApiGrant, useLaunchDetail } from "@/lib/api-hooks";
import { useNow, useTabVisible, useTx } from "@/lib/hooks";
import { fmtTime, formatRelativeTime, shortHash } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { TxStatus } from "@/components/TxStatus";
import { TokenCell } from "@/components/admin/AdminKit";
import { useT } from "@/i18n/provider";

function useCampaigns(status: "1" | "2") {
  const visible = useTabVisible();
  return useQuery({
    queryKey: ["api", "grants", status, "all"],
    // the admin view keeps campaigns of launches that moderation hid from the site
    queryFn: () => api.grants(status, { includeHidden: true }),
    refetchInterval: visible ? 15_000 : false,
  });
}

/** Published lists in their public review window: check the dataset, cancel a wrong one, or activate once due. */
export function ReviewListsPanel({ vault, canWrite }: { vault: Address; canWrite: boolean }) {
  const { t } = useT();
  const q = useCampaigns("2");
  const list = q.data?.campaigns ?? [];
  return (
    <Panel title={t("admin.review.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.review.body")}</p>
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{q.isLoading ? "…" : t("admin.review.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {list.map((c) => (
            <ReviewRow key={c.meme} vault={vault} campaign={c} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const DATASET_TONE = { verified: "verdigris", mismatch: "rose", unreachable: "rose", pending: "amber", none: "muted" } as const;

function ReviewRow({ vault, campaign, canWrite }: { vault: Address; campaign: GrantCampaign; canWrite: boolean }) {
  const { t, locale } = useT();
  const now = useNow();
  const cancel = useTx();
  const activate = useTx();
  const launch = useLaunchDetail(campaign.meme).data;
  const dataset = useApiGrant(campaign.meme).data?.dataset;
  const due = campaign.activatableAt !== null && now >= campaign.activatableAt;
  const busy = cancel.isPending || cancel.isConfirming || activate.isPending || activate.isConfirming;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TokenCell meme={campaign.meme} launch={launch} href={`/grant/${campaign.meme}`} />
        <span className="flex flex-wrap items-center gap-1.5">
          {dataset && (
            <Pill tone={DATASET_TONE[dataset.status]}>
              {t(`admin.review.dataset.${dataset.status}`, { n: dataset.accounts })}
            </Pill>
          )}
          <span className="text-[13px] text-muted">
            {campaign.activatableAt ? t("admin.review.activatesAt", { time: fmtTime(campaign.activatableAt, locale) }) : "—"}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="mono text-xs text-subtle">{campaign.root ? `root ${shortHash(campaign.root)}` : ""}</span>
        <span className="flex gap-2">
          {due && (
            <span className="w-40">
              <Button
                variant="ghost"
                tx={activate}
                disabled={busy}
                onClick={() => activate.write({ address: vault, abi: lpGrantVaultAbi, functionName: "activateRoot", args: [campaign.meme] })}
                className="py-1.5 text-[13px]"
              >
                {t("admin.review.activate")}
              </Button>
            </span>
          )}
          <span className="w-40">
            <Button
              variant="danger"
              tx={cancel}
              disabled={!canWrite || busy || cancel.isSuccess}
              onClick={() => cancel.write({ address: vault, abi: lpGrantVaultAbi, functionName: "cancelRoot", args: [campaign.meme] })}
              className="py-1.5 text-[13px]"
            >
              {t("admin.review.cancel")}
            </Button>
          </span>
        </span>
      </div>
      <TxStatus tx={cancel} />
      <TxStatus tx={activate} />
    </li>
  );
}

/** Graduated LP Grant launches still waiting for their list, oldest first: what the publisher has not done yet. */
export function AwaitingListsPanel() {
  const { t } = useT();
  const q = useCampaigns("1");
  const list = [...(q.data?.campaigns ?? [])].sort((a, b) => a.initializedAt - b.initializedAt);
  return (
    <Panel title={t("admin.awaiting.title")}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.awaiting.body")}</p>
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{q.isLoading ? "…" : t("admin.awaiting.empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {list.map((c) => (
            <AwaitingRow key={c.meme} campaign={c} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AwaitingRow({ campaign }: { campaign: GrantCampaign }) {
  const { t, locale } = useT();
  const now = useNow();
  const launch = useLaunchDetail(campaign.meme).data;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <TokenCell meme={campaign.meme} launch={launch} href={`/grant/${campaign.meme}`} />
      <span className="text-[13px] text-muted" title={fmtTime(campaign.initializedAt, locale)}>
        {t("admin.awaiting.since", { time: formatRelativeTime(campaign.initializedAt, now, t) })}
      </span>
    </li>
  );
}
