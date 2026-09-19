"use client";

import Image from "next/image";
import { useDeployment } from "@/lib/hooks";
import { explorerAddressUrl, DEFAULT_CHAIN } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { Sparkle } from "@/components/art/Sparkle";
import { useT } from "@/i18n/provider";

/** Site footer: a single top rule, the mark, one line of positioning, and the on-chain facts that make the site checkable. */
export function SiteFooter() {
  const { t } = useT();
  const { chainId, deployment } = useDeployment();
  const links: { label: string; address: string | undefined }[] = [
    { label: "Factory", address: deployment?.factory },
    { label: "Hook", address: deployment?.hook },
    { label: "LPGrantVault", address: deployment?.lpGrantVault },
  ];
  return (
    <footer className="mx-auto w-full max-w-page px-4 pb-12 pt-6 sm:px-6">
      <div className="border-t border-bone/10 pt-8">
        <div className="grid gap-8 md:grid-cols-12">
          <div className="md:col-span-5">
            <div className="flex items-center gap-2.5">
              <Image src="/brand/perk-logo.jpeg" alt="" width={24} height={24} className="h-6 w-6 rounded-full ring-1 ring-bone/10" />
              <span className="font-display text-lg tracking-[-0.03em]">Perk</span>
              <Sparkle size={8} tone="flare" className="-ml-1 -mt-2" />
            </div>
            <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-bone/55">{t("footer.note")}</p>
          </div>
          <div className="md:col-span-4">
            <p className="label-en mb-3">{t("footer.contracts")}</p>
            <ul className="space-y-1.5">
              {links.map((l) => (
                <li key={l.label} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="text-bone/55">{l.label}</span>
                  {l.address ? (
                    <a
                      href={explorerAddressUrl(chainId, l.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="num text-bone/80 underline decoration-bone/20 underline-offset-4 transition-colors duration-fast hover:text-flare hover:decoration-flare"
                    >
                      {shortAddress(l.address)}
                    </a>
                  ) : (
                    <span className="num text-bone/40">—</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-3">
            <p className="label-en mb-3">{t("footer.network")}</p>
            <p className="text-[13px] text-bone/80">{DEFAULT_CHAIN.testnet ? t("header.network.testnet") : DEFAULT_CHAIN.name}</p>
            <p className="num mt-1 text-[12px] text-bone/45">chainId {chainId}</p>
            <p className="mt-4 text-[12px] text-bone/45">{t("footer.stack")}</p>
          </div>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-bone/6 pt-4 text-[11px] text-bone/40">
          <span>{t("footer.rights")}</span>
          <span>{t("footer.slogan")}</span>
        </div>
      </div>
    </footer>
  );
}
