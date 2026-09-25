"use client";

import { Fragment, type ReactNode } from "react";
import { PageHeader } from "@/components/ui/SectionHeading";
import { useT } from "@/i18n/provider";
import { useDeployment } from "@/lib/hooks";
import { explorerAddressUrl } from "@/lib/chains";
import type { DocBlock, DocsContent } from "@/i18n/docs/types";
import en from "@/i18n/docs/en";
import zhCN from "@/i18n/docs/zh-CN";
import ja from "@/i18n/docs/ja";

const CONTENT: Record<string, DocsContent> = { en, "zh-CN": zhCN, ja };

/**
 * Docs: how Perk works, for someone who has never seen it. The text lives in src/i18n/docs (one file per locale, the
 * same sections in the same order); the contract table at the end reads the live deployment.
 */
export default function DocsPage() {
  const { t, locale } = useT();
  const docs = CONTENT[locale] ?? en;

  return (
    <div className="space-y-10 pt-6 sm:pt-8">
      <PageHeader eyebrow={t("docs.eyebrow")} title={t("docs.title")} description={t("docs.sub")} />

      {/* phones: the sections as a compact row of links */}
      <nav aria-label={t("docs.toc")} className="-mx-1 flex flex-wrap gap-1.5 lg:hidden">
        {docs.sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full bg-raised px-3 py-1.5 text-[13px] font-medium text-muted transition-colors duration-fast hover:bg-yolk/40 hover:text-bone"
          >
            {s.title}
          </a>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label={t("docs.toc")} className="sticky top-24">
            <p className="eyebrow mb-3 text-[10px] font-bold tracking-[0.2em]">{t("docs.toc")}</p>
            <ol className="space-y-1 border-l border-line">
              {docs.sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="-ml-px block border-l-2 border-transparent py-1 pl-4 text-[14px] text-muted transition-colors duration-fast hover:border-honey hover:text-bone"
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="min-w-0 max-w-3xl space-y-14">
          {docs.sections.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-24">
              <h2 className="font-display text-[26px] leading-tight sm:text-[28px]">{s.title}</h2>
              <div className="mt-5 space-y-5">
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} />
                ))}
              </div>
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

/** Text with `code` spans. */
function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split("`");
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="mono rounded bg-raised px-1.5 py-0.5 text-[0.9em] text-bone">
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "p":
      return (
        <p className="text-[15px] leading-[1.8] text-bone/85">
          <Rich text={block.text} />
        </p>
      );
    case "list":
      return (
        <ul className="space-y-2.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-[1.75] text-bone/85">
              <span aria-hidden className="mt-[0.7em] h-1.5 w-1.5 shrink-0 rounded-full bg-honey" />
              <span>
                <Rich text={item} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="space-y-4">
          {block.items.map((step, i) => (
            <li key={i} className="flex gap-4">
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-yolk font-mono text-[12px] font-bold text-charcoal"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-bold leading-7 text-bone">{step.title}</p>
                <p className="mt-0.5 text-[15px] leading-[1.75] text-bone/85">
                  <Rich text={step.text} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[480px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-line-strong">
                {block.head.map((h, i) => (
                  <th key={i} className="label py-2.5 pr-4 font-bold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-line align-top last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className={`py-2.5 pr-4 leading-relaxed ${j === 0 ? "font-medium text-bone" : "text-bone/85"}`}>
                      <Rich text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "note":
      return (
        <p className="rounded-xl border-l-4 border-honey bg-yolk/10 px-4 py-3 text-[14px] leading-relaxed text-bone/90">
          <Rich text={block.text} />
        </p>
      );
    case "contracts":
      return <Contracts />;
  }
}

function Contracts() {
  const { t } = useT();
  const { chainId, deployment } = useDeployment();
  if (!deployment) return <p className="text-sm text-muted">{t("docs.contracts.none")}</p>;
  const rows: Array<[string, string]> = [
    ["LaunchFactory", deployment.factory],
    ["BondingCurve", deployment.curve],
    ["GraduationManager", deployment.graduationManager],
    ["PerkComposableHookV1", deployment.hook],
    ["LPGrantVault", deployment.lpGrantVault],
    ["FeeRouter", deployment.feeRouter],
    ["HolderRewardDistributor", deployment.distributor],
    ["ReferralRegistry", deployment.referralRegistry],
    ["TemplateRegistry", deployment.templateRegistry],
  ];
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-left text-[14px]">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="label py-2.5 pr-4 font-bold">{t("docs.contracts.name")}</th>
            <th className="label py-2.5 font-bold">{t("docs.contracts.address")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, address]) => (
            <tr key={name} className="border-b border-line last:border-0">
              <td className="py-2.5 pr-4 font-medium">{name}</td>
              <td className="py-2.5">
                <a
                  href={explorerAddressUrl(chainId, address)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono break-all text-[13px] text-bone underline decoration-line-strong underline-offset-4 hover:decoration-honey"
                >
                  {address}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
