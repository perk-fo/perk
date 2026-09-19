"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { DEFAULT_CHAIN } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { Pill } from "@/components/ui/Pill";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";
import { useT } from "@/i18n/provider";
import Image from "next/image";
import { Sparkle } from "@/components/art/Sparkle";
import { SyncStatus } from "@/components/SyncStatus";
import { AccountMenu } from "@/components/AccountMenu";

const THEME_KEY = "perk-theme";

function ThemeToggle() {
  const { t } = useT();
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      document.documentElement.dataset.theme = stored;
      setTheme(stored);
    }
  }, []);

  function toggle() {
    const explicit = document.documentElement.dataset.theme;
    const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    const current = explicit === "light" || explicit === "dark" ? explicit : system;
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  }

  return (
    <button type="button" onClick={toggle} className="btn-ghost px-2.5 py-1 text-xs" title={t("header.theme.title")}>
      {theme === null ? t("header.theme.system") : theme === "dark" ? t("header.theme.dark") : t("header.theme.light")}
    </button>
  );
}

/** Language menu: a Pill with the current locale label, opening the three locale choices. */
function LanguageMenu() {
  const { locale, setLocale, t } = useT();
  const [open, setOpen] = useState(false);

  function pick(next: Locale) {
    setLocale(next);
    setOpen(false);
  }

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("header.lang.title")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Pill tone="muted">{`${LOCALE_LABELS[locale]} ▾`}</Pill>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <span
            role="listbox"
            className="panel absolute right-0 z-20 mt-1.5 flex min-w-28 flex-col gap-0.5 p-1.5"
          >
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="option"
                aria-selected={l === locale}
                onClick={() => pick(l)}
                className={`rounded-[8px] px-2.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-bone/5 ${
                  l === locale ? "text-bone" : "text-bone/60"
                }`}
              >
                {LOCALE_LABELS[l]}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

export function Header() {
  const { t } = useT();
  const pathname = usePathname();
  // useAccount().chainId is the wallet's real chain; useChainId() stays on the last *supported* chain when the
  // wallet sits on e.g. Ethereum, which hid the mismatch.
  const { address, isConnected, chainId, status: walletStatus } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const configured = DEFAULT_CHAIN;
  const configuredName = configured.testnet ? t("header.network.testnet") : configured.name;
  const wrongChain = isConnected && chainId !== configured.id;
  const dotClass = !isConnected ? "bg-bone/40" : wrongChain ? "bg-rose" : "bg-verdigris";

  // entries by intent (like a DEX): trade memes, provide liquidity through LP Grant, launch a token.
  // A token page belongs to Trade; a campaign page belongs to LP Grant.
  const nav = [
    { href: "/trade", label: t("nav.trade"), match: (p: string) => p.startsWith("/trade") || p.startsWith("/meme") },
    { href: "/pool", label: t("nav.pool"), match: (p: string) => p.startsWith("/pool") },
    { href: "/grant", label: t("nav.grant"), match: (p: string) => p.startsWith("/grant") },
    // launching is rare next to trading / LP: a plain entry, not a highlighted button
    { href: "/launch", label: t("nav.launch"), match: (p: string) => p.startsWith("/launch") },
  ];

  useEffect(() => {
    // connected on another network: ask once per mismatch
    if (wrongChain) switchChain({ chainId: configured.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrongChain, configured.id]);

  return (
    <>
    <header className="sticky top-0 z-10 border-b border-bone/8 bg-ink/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Perk">
          <Image
            src="/brand/perk-logo.jpeg"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-full ring-1 ring-bone/10"
            priority
          />
          <span className="font-display text-[22px] leading-none tracking-[-0.04em]">Perk</span>
          <Sparkle size={10} tone="flare" className="-ml-1 -mt-3" />
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          {nav.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`transition-colors duration-fast ${
                  active ? "text-bone underline decoration-flare decoration-2 underline-offset-8" : "text-bone/60 hover:text-bone"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <LanguageMenu />
          <ThemeToggle />
          <SyncStatus />
          <button
            type="button"
            onClick={() => wrongChain && switchChain({ chainId: configured.id })}
            title={wrongChain ? t("header.wrongChain", { network: configuredName }) : configuredName}
            className={wrongChain ? "cursor-pointer" : "cursor-default"}
          >
            <Pill tone={wrongChain ? "rose" : isConnected ? "verdigris" : "muted"}>
              <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
              {configuredName}
            </Pill>
          </button>
          {walletStatus === "reconnecting" ? (
            // restoring a previous session: hold the slot instead of flashing "Connect wallet"
            <span className="skel inline-block h-[30px] w-[132px] rounded-full" aria-busy="true" />
          ) : isConnected && address ? (
            <AccountMenu />
          ) : (
            <button
              type="button"
              className="btn-primary px-3.5 py-1.5 text-sm"
              disabled={isPending || connectors.length === 0}
              onClick={() =>
                connectors[0] &&
                connect(
                  { connector: connectors[0], chainId: configured.id },
                  {
                    onSuccess: (data) => {
                      // wallets may ignore the requested chainId: verify and ask to switch (adds the chain if unknown)
                      if (data.chainId !== configured.id) switchChain({ chainId: configured.id });
                    },
                  },
                )
              }
            >
              {t("header.connect")}
            </button>
          )}
        </div>
      </div>
    </header>
    {wrongChain && (
      <div className="border-b border-rose/30 bg-rose/10">
        <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
          <span className="flex items-center gap-2 text-rose">
            <span className="h-1.5 w-1.5 rounded-full bg-rose" aria-hidden />
            {t("header.wrongChain", { network: configuredName })}
          </span>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => switchChain({ chainId: configured.id })}>
            {t("header.switchNetwork", { network: configuredName })}
          </button>
        </div>
      </div>
    )}
    </>
  );
}
