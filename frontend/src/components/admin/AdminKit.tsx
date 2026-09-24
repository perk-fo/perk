"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Address } from "viem";
import type { AdminRole, LaunchSummary, TokenMetadataView } from "@/lib/api-types";
import { useAdminRoles, type AdminSection } from "@/lib/admin";
import { useAdminSession } from "@/lib/admin-session";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { NotFoundView } from "@/components/NotFoundView";
import { Panel } from "@/components/ui/Panel";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";

export const ROLE_TONE: Record<AdminRole, PillTone> = { core: "flare", grant: "amber", operator: "verdigris" };

export function RolePill({ role }: { role: AdminRole }) {
  const { t } = useT();
  return <Pill tone={ROLE_TONE[role]}>{t(`admin.role.${role}`)}</Pill>;
}

/** A section renders only for the roles that may use it; anyone else gets the site's not-found page. */
export function SectionGate({ section, children }: { section: AdminSection; children: ReactNode }) {
  const roles = useAdminRoles();
  if (!roles.can(section)) return <NotFoundView />;
  return <div className="space-y-6">{children}</div>;
}

export function SectionIntro({ title, body }: { title: string; body: string }) {
  return (
    <header>
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{body}</p>
    </header>
  );
}

/**
 * Off-chain admin work (General Admins, moderation, featured, display settings) goes through the API, which needs
 * a signed-in session. Until there is one this asks for it in place of `children`.
 */
export function RequireSession({ title, children }: { title?: string; children: ReactNode }) {
  const { t } = useT();
  const s = useAdminSession();
  if (s.session) return <>{children}</>;
  return (
    <Panel title={title}>
      <p className="text-sm leading-relaxed text-muted">{t("admin.session.body")}</p>
      <div className="mt-4 max-w-xs">
        <Button onClick={() => void s.signIn()} pending={s.signingIn} disabled={s.signingIn}>
          {s.signingIn ? t("admin.session.signing") : t("admin.session.signIn")}
        </Button>
      </div>
      {s.error && <p className="mt-2 text-[13px] text-rose">{t(`admin.session.error.${s.error}`)}</p>}
    </Panel>
  );
}

/** Egg, name and symbol of a launch, linking to its page. */
export function TokenCell({
  meme,
  launch,
  href,
  image,
}: {
  meme: Address;
  launch: LaunchSummary | undefined;
  href?: string;
  /** Shown beside the egg, uncropped by any shell, for admins judging a launch's media. */
  image?: string | null;
}) {
  return (
    <Link href={href ?? `/meme/${meme}`} className="group flex min-w-0 items-center gap-3 hover:text-flare">
      {launch && <LaunchAvatar hash={launch.configHash} image={launch.metadata?.image} status={launch.status} size={32} title={launch.name} />}
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="h-9 w-9 shrink-0 rounded-lg object-cover"
          loading="lazy"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm">{launch?.name || shortAddress(meme)}</span>
        <span className="num block text-xs text-subtle">{launch?.symbol ?? ""}</span>
      </span>
    </Link>
  );
}

/** What a launch's metadata says, for admins deciding whether to withhold it. */
export function MediaPreview({ metadata }: { metadata: TokenMetadataView | null }) {
  const { t } = useT();
  if (!metadata || (!metadata.description && !metadata.links.x && !metadata.links.telegram && !metadata.links.website)) {
    return null;
  }
  const links = Object.entries(metadata.links).filter(([, v]) => !!v) as Array<[string, string]>;
  return (
    <div className="mt-2 space-y-1 text-[13px] text-muted">
      {metadata.description && <p className="line-clamp-2 break-words">{metadata.description}</p>}
      {links.length > 0 && (
        <p className="flex flex-wrap gap-x-3 gap-y-1">
          {links.map(([k, v]) => (
            <a key={k} href={v} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline decoration-line-strong hover:text-flare">
              {t(`meme.link.${k}`)}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

/** An address in mono, shortened on small screens. */
export function Addr({ value }: { value: string }) {
  return (
    <>
      <span className="mono hidden break-all text-[13px] sm:inline">{value}</span>
      <span className="mono text-[13px] sm:hidden">{shortAddress(value)}</span>
    </>
  );
}
