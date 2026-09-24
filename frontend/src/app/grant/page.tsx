"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { lpGrantVaultAbi } from "@/generated/abis";
import { api, API_URL, isApiUnreachable } from "@/lib/api";
import type { GrantCampaign, LaunchSummary } from "@/lib/api-types";
import { useLaunchList } from "@/lib/api-hooks";
import { progressBpsOf } from "@/lib/api-adapters";
import { useDeployment, useNow, useTabVisible } from "@/lib/hooks";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { PerkPass } from "@/components/grant/PerkPass";
import { Pill, campaignStatusPill, launchStatusPill } from "@/components/ui/Pill";
import { Panel } from "@/components/ui/Panel";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { fmtCountdown, formatAmount } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { PageHeader } from "@/components/ui/SectionHeading";
import { PerkLoader } from "@/components/brand/PerkLoader";

type Group = "active" | "upcoming" | "preGrad" | "ended";
const GROUPS: Group[] = ["active", "upcoming", "preGrad", "ended"];

interface Row {
  launch: LaunchSummary;
  campaign: GrantCampaign | null;
}

function groupOf(r: Row): Group {
  const s = r.campaign?.status;
  if (s === 3) return "active";
  if (s === 1 || s === 2) return "upcoming";
  if (s === 4 || s === 5) return "ended";
  return "preGrad"; // no campaign yet: still on the curve (or waiting to graduate) with LP Grant enabled
}

/**
 * LP Grant: its own entry. Participation (opt-in, inviter, invite link) is global and lives here, not on a token page.
 * Below it, every launch with LP Grant enabled, grouped by where its campaign stands; the connected wallet's
 * claimable allocation is shown on active ones.
 */
export default function GrantHubPage() {
  const { t } = useT();
  const visible = useTabVisible();
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const launches = useLaunchList({ limit: 100 });
  const campaigns = useQuery({ queryKey: ["api", "grants"], queryFn: () => api.grants(), refetchInterval: visible ? 15_000 : false });
  const apiDown = isApiUnreachable(launches.error) || isApiUnreachable(campaigns.error);

  const rows = useMemo<Row[]>(() => {
    const byMeme = new Map((campaigns.data?.campaigns ?? []).map((c) => [c.meme.toLowerCase(), c]));
    return (launches.data?.launches ?? [])
      .filter((l) => l.lpGrantEnabled)
      .map((l) => ({ launch: l, campaign: byMeme.get(l.meme.toLowerCase()) ?? null }));
  }, [launches.data, campaigns.data]);

  const active = rows.filter((r) => groupOf(r) === "active");
  const mine = useReadContracts({
    contracts: active.map((r) => ({
      address: deployment?.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "grantBreakdown" as const,
      args: address ? [r.launch.meme, address] : undefined,
    })),
    query: { enabled: !!deployment && !!address && active.length > 0, refetchInterval: 15_000 },
  });
  const claimableOf = new Map<string, bigint>();
  active.forEach((r, i) => {
    const b = mine.data?.[i]?.result as readonly [bigint, bigint, bigint] | undefined;
    if (b) claimableOf.set(r.launch.meme.toLowerCase(), b[0] + b[1] + b[2]);
  });

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t("home.door.grantTag")} title={t("nav.grant")} description={t("grant.hub.sub")}>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-subtle">
          {t("grant.hub.vsPool")}{" "}
          <Link href="/pool" className="group font-semibold text-muted underline decoration-honey decoration-2 underline-offset-4 hover:text-bone">
            {t("grant.hub.toPool")} <span className="nudge">→</span>
          </Link>
        </p>
      </PageHeader>

      <PerkPass />

      {apiDown && (
        <Notice tone="rose" title={t("home.api.downTitle")}>
          {t("home.api.downBody", { url: API_URL })}
        </Notice>
      )}

      {launches.isLoading || campaigns.isLoading ? (
        <Panel>
          <PerkLoader size={56} minHeight={220} />
        </Panel>
      ) : (
        GROUPS.map((g) => {
          const list = rows.filter((r) => groupOf(r) === g);
          if (list.length === 0 && g !== "active") return null;
          return (
            <section key={g}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="label">{t(`grant.hub.group.${g}`)}</h2>
                <span className="num text-xs text-subtle">{list.length}</span>
              </div>
              <p className="mb-4 text-xs text-subtle">{t(`grant.hub.group.${g}Hint`)}</p>
              {list.length === 0 ? (
                <Panel className="py-8 text-center text-sm text-subtle">{t("grant.hub.noneActive")}</Panel>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {list.map((r) => (
                    <CampaignCard key={r.launch.meme} row={r} group={g} claimable={claimableOf.get(r.launch.meme.toLowerCase())} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

function CampaignCard({ row, group, claimable }: { row: Row; group: Group; claimable?: bigint }) {
  const { t, locale } = useT();
  const now = useNow();
  const { launch, campaign } = row;
  const pill = campaign ? campaignStatusPill(campaign.status, t) : launchStatusPill(launch.status, t);
  const href = group === "preGrad" ? `/meme/${launch.meme}` : `/grant/${launch.meme}`;
  let detail: string;
  if (group === "active" && campaign?.endTime) detail = t("grant.hub.endsIn", { time: fmtCountdown(campaign.endTime - now, t) });
  else if (campaign?.status === 2 && campaign.activatableAt)
    detail =
      campaign.activatableAt > now
        ? t("grant.hub.opensIn", { time: fmtCountdown(campaign.activatableAt - now, t) })
        : t("grant.hub.reviewDone");
  else if (campaign?.status === 1) detail = t("grant.hub.awaitingList");
  else if (group === "preGrad")
    detail =
      launch.status === 2
        ? t("grant.hub.gradPending")
        : t("grant.hub.curveProgress", { pct: (Number(progressBpsOf(launch)) / 100).toFixed(0) });
  else detail = pill.label;

  return (
    <Link href={href} className="panel group flex h-full flex-col p-5">
      <div className="flex items-start gap-3">
        <LaunchAvatar hash={launch.configHash} image={launch.metadata?.image} status={launch.status} size={48} title={launch.name} />
        <div className="min-w-0 flex-1">
          {/* two lines before truncating: next to a long status pill one line held about eight characters */}
          <div className="line-clamp-2 break-words font-display text-lg leading-tight">{launch.name}</div>
          <div className="num mt-0.5 text-xs text-subtle">
            {launch.symbol} / {launch.quoteSymbol}
          </div>
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      <p className="num mt-4 text-[13px] text-muted">{detail}</p>
      {campaign && (
        <p className="num mt-1 text-[13px] text-subtle">
          {t("grant.hub.positions", { n: campaign.activePositions })}
        </p>
      )}
      <div className="mt-auto pt-4">
        {group === "active" && claimable !== undefined ? (
          claimable > 0n ? (
            <p className="text-sm text-verdigris">
              {t("grant.hub.myClaimable", { amount: formatAmount(claimable, launch.decimals, { locale, maxFrac: 0 }), symbol: launch.symbol })}
            </p>
          ) : (
            <p className="text-sm text-subtle">{t("grant.hub.notEligible")}</p>
          )
        ) : null}
      </div>
    </Link>
  );
}

