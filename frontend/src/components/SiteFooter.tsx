"use client";

import { useDeployment } from "@/lib/hooks";
import { explorerAddressUrl, DEFAULT_CHAIN } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { PerkBrand } from "@/components/brand/PerkBrand";
import { useT } from "@/i18n/provider";

/** Site footer: the lockup and one line of positioning, the on-chain contracts that make the site checkable, the network. */
export function SiteFooter() {
  const { t } = useT();
  const { chainId, deployment } = useDeployment();
  const links: { label: string; address: string | undefined }[] = [
    { label: "Factory", address: deployment?.factory },
    { label: "Hook", address: deployment?.hook },
    { label: "LPGrantVault", address: deployment?.lpGrantVault },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto w-full max-w-page px-4 pt-12 sm:px-8">
        <div className="grid grid-cols-1 gap-10 pb-10 md:grid-cols-[1.3fr_1fr_0.7fr] md:gap-16">
          <div>
            <PerkBrand size={40} text={28} />
            <p className="mt-5 max-w-sm text-[13px] leading-relaxed text-subtle">{t("footer.note")}</p>
          </div>
          <div>
            <p className="mb-5 flex items-center justify-between text-[13px] font-bold">
              {t("footer.contracts")}
              <span aria-hidden>↗</span>
            </p>
            <ul className="space-y-3">
              {links.map((l) => (
                <li key={l.label}>
                  {l.address ? (
                    <a
                      href={explorerAddressUrl(chainId, l.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-baseline justify-between gap-4 text-[13px] text-subtle transition-colors duration-fast hover:text-bone"
                    >
                      <span>{l.label}</span>
                      <code className="mono text-[12px]">
                        {shortAddress(l.address)} <span className="nudge">↗</span>
                      </code>
                    </a>
                  ) : (
                    <span className="flex justify-between text-[13px] text-subtle">
                      {l.label} <span className="num">—</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-5 text-[13px] font-bold">{t("footer.network")}</p>
            <p className="flex items-center gap-2 text-[13px] font-semibold">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-tangerine" aria-hidden />
              {DEFAULT_CHAIN.testnet ? t("header.network.testnet") : DEFAULT_CHAIN.name}
            </p>
            <p className="num mt-3 flex gap-6 text-[13px] text-subtle">
              chainId <span className="text-bone">{chainId}</span>
            </p>
            <p className="mt-4 text-[12px] text-subtle">{t("footer.stack")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-6 text-xs text-subtle">
          <span>{t("footer.rights")}</span>
          <span>{t("footer.slogan")}</span>
        </div>
      </div>
    </footer>
  );
}
