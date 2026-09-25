"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { DEFAULT_CHAIN } from "@/lib/chains";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";
import { useT } from "@/i18n/provider";
import { CheckIcon, ChevronDownIcon, GlobeIcon, MoonIcon, SunIcon, SystemIcon } from "@/components/ui/Icon";
import { SyncStatus } from "@/components/SyncStatus";
import { AccountMenu } from "@/components/AccountMenu";
import { PerkBrand } from "@/components/brand/PerkBrand";
import { useAdminRoles } from "@/lib/admin";
import { useDismiss } from "@/lib/use-dismiss";

const THEME_KEY = "perk-theme";
type ThemeChoice = "system" | "light" | "dark";

/** Resolve a choice onto <html data-theme>; the inline script in app/layout.tsx does the same before first paint. */
function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const resolved =
    choice === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
  root.dataset.theme = resolved;
  root.dataset.themeSource = choice === "system" ? "system" : "user";
}

// Round header controls. No horizontal padding in the base: each control sets its own width or padding.
const CHIP_BASE =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface text-[13px] font-semibold text-muted transition-[color,border-color,transform] duration-fast hover:-translate-y-px hover:border-line-strong hover:text-bone";
const MENU_ITEM =
  "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-fast hover:bg-raised";

/**
 * Theme menu: follow the system, or pin light or dark. It stays open while choosing so the modes can be compared; a
 * press outside, Escape or focus leaving closes it.
 */
function ThemeMenu() {
  const { t } = useT();
  const [choice, setChoice] = useState<ThemeChoice>("light");
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      /* storage blocked: the light default */
    }
    setChoice(stored === "dark" || stored === "system" ? stored : "light");
    // while following the system, follow it live (e.g. macOS switching at sunset)
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (document.documentElement.dataset.themeSource === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function pick(next: ThemeChoice) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* not persisted; still applied for this visit */
    }
    applyTheme(next);
    setChoice(next);
  }

  const modes: { key: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
    { key: "light", label: t("header.theme.light"), Icon: SunIcon },
    { key: "dark", label: t("header.theme.dark"), Icon: MoonIcon },
    { key: "system", label: t("header.theme.system"), Icon: SystemIcon },
  ];
  const Current = modes.find((o) => o.key === choice)!.Icon;

  return (
    <span ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("header.theme.title")}
        aria-label={t("header.theme.title")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${CHIP_BASE} group w-9 justify-center`}
      >
        <Current size={16} className="transition-transform duration-500 ease-spring group-hover:rotate-45" />
      </button>
      {open && (
        <span role="menu" aria-label={t("header.theme.title")} className="popover fade-up absolute right-0 z-30 mt-2 flex w-44 flex-col gap-0.5 p-1.5">
          {modes.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={key === choice}
              onClick={() => pick(key)}
              className={`${MENU_ITEM} ${key === choice ? "text-bone" : "text-muted"}`}
            >
              <Icon size={15} className="shrink-0" />
              <span className="flex-1">{label}</span>
              {key === choice && <CheckIcon size={14} className="text-flare" />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Language menu: the current locale, opening the three locale choices. */
function LanguageMenu() {
  const { locale, setLocale, t } = useT();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));

  function pick(next: Locale) {
    setLocale(next);
    setOpen(false);
  }

  return (
    <span ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("header.lang.title")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("header.lang.title")}
        className={`${CHIP_BASE} w-9 justify-center 2xl:w-auto 2xl:px-3`}
      >
        <GlobeIcon size={15} />
        <span className="hidden 2xl:inline">{LOCALE_LABELS[locale]}</span>
        <ChevronDownIcon size={12} className="-mr-0.5 hidden opacity-70 2xl:block" />
      </button>
      {open && (
        <span role="listbox" className="popover fade-up absolute right-0 z-30 mt-2 flex min-w-40 flex-col gap-0.5 p-1.5">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="option"
              aria-selected={l === locale}
              onClick={() => pick(l)}
              className={`${MENU_ITEM} ${l === locale ? "text-bone" : "text-muted"}`}
            >
              <span className="flex-1">{LOCALE_LABELS[l]}</span>
              {l === locale && <CheckIcon size={14} className="text-flare" />}
            </button>
          ))}
        </span>
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
  const { switchChain } = useSwitchChain();
  const adminRoles = useAdminRoles();

  const configured = DEFAULT_CHAIN;
  const configuredName = configured.testnet ? t("header.network.testnet") : configured.name;
  const wrongChain = isConnected && chainId !== configured.id;

  // entries by intent (like a DEX): trade memes, provide liquidity, LP Grant, launch a token.
  // A token page belongs to Trade; a campaign page belongs to LP Grant.
  const nav = [
    { href: "/trade", label: t("nav.trade"), match: (p: string) => p.startsWith("/trade") || p.startsWith("/meme") },
    { href: "/pool", label: t("nav.pool"), match: (p: string) => p.startsWith("/pool") },
    { href: "/grant", label: t("nav.grant"), match: (p: string) => p.startsWith("/grant") },
    { href: "/launch", label: t("nav.launch"), match: (p: string) => p.startsWith("/launch") },
    { href: "/docs", label: t("nav.docs"), match: (p: string) => p.startsWith("/docs") },
    // only wallets holding an admin role see the admin entry (everyone else gets a not-found page there)
    ...(adminRoles.isAdmin
      ? [{ href: "/admin", label: t("nav.admin"), match: (p: string) => p.startsWith("/admin") }]
      : []),
  ];

  useEffect(() => {
    // connected on another network: ask once per mismatch
    if (wrongChain) switchChain({ chainId: configured.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrongChain, configured.id]);

  return (
    <>
      {/* two rows on a phone (brand + controls, then nav) and not sticky there: rows pinned to the top would take a
          large share of a small screen. The first row must hold the brand and every control on a 320 px screen, so
          phones get tighter gaps, a shorter connect label, no role chip on the account button (the menu lists the
          roles) and, on the narrowest screens (below 360 px, or 390 px with a wallet connected), the chick without the
          wordmark. */}
      <header className="z-20 border-b border-line bg-ink/90 backdrop-blur-md sm:sticky sm:top-0">
        <div className="mx-auto flex w-full max-w-page flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:gap-x-6 sm:px-8 sm:py-4 lg:flex-nowrap">
          <PerkBrand className="order-1" wordmarkClassName={isConnected ? "max-[389px]:hidden" : "max-[359px]:hidden"} />
          <nav className="order-3 -mx-1 flex w-full min-w-0 items-center gap-0.5 overflow-x-auto pb-1 text-[14px] font-bold max-[389px]:gap-0 max-[389px]:text-[13px] sm:order-2 sm:w-auto sm:pb-0">
            {nav.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`group relative whitespace-nowrap rounded-lg px-2 py-2 transition-colors duration-fast max-[389px]:px-1 sm:px-2.5 ${
                    active ? "text-bone" : "text-muted hover:text-bone"
                  }`}
                >
                  {/* an underline beneath the word (never over it) marks the current section; it draws in on hover */}
                  <span
                    aria-hidden
                    className={`absolute inset-x-2.5 bottom-0 h-[3px] max-[389px]:inset-x-1 origin-left rounded-full transition-transform duration-300 ease-spring ${
                      active ? "scale-x-100 bg-tangerine dark:bg-yolk" : "scale-x-0 bg-honey group-hover:scale-x-100"
                    }`}
                  />
                  <span className="relative">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="order-2 ml-auto flex shrink-0 items-center gap-1.5 sm:order-3 sm:gap-2">
            <button
              type="button"
              onClick={() => wrongChain && switchChain({ chainId: configured.id })}
              title={wrongChain ? t("header.wrongChain", { network: configuredName }) : configuredName}
              className={`mr-1 hidden items-center gap-2 whitespace-nowrap text-[12px] font-bold xl:inline-flex ${
                wrongChain ? "cursor-pointer text-rose" : "cursor-default text-bone"
              }`}
            >
              <span
                className={`pulse-dot h-1.5 w-1.5 rounded-full ${wrongChain ? "bg-rose" : isConnected ? "bg-verdigris" : "bg-tangerine"}`}
                aria-hidden
              />
              {configuredName}
            </button>
            <SyncStatus />
            <LanguageMenu />
            <ThemeMenu />
            {walletStatus === "reconnecting" ? (
              // restoring a previous session: hold the slot instead of flashing "Connect wallet"
              <span className="skel inline-block h-10 w-[140px] rounded-xl" aria-busy="true" />
            ) : isConnected && address ? (
              <AccountMenu />
            ) : (
              <button
                type="button"
                className="btn-dark group inline-flex h-10 items-center gap-2 whitespace-nowrap px-3.5 text-[13px] sm:px-4"
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
                <span className="sm:hidden">{t("header.connectShort")}</span>
                <span className="hidden sm:inline">{t("header.connect")}</span>
                <span aria-hidden className="nudge hidden sm:inline-block">
                  ↗
                </span>
              </button>
            )}
          </div>
        </div>
      </header>
      {wrongChain && (
        <div className="border-b border-rose/30 bg-rose/10">
          <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm sm:px-8">
            <span className="flex items-center gap-2 font-semibold text-rose">
              <span className="h-1.5 w-1.5 rounded-full bg-rose" aria-hidden />
              {t("header.wrongChain", { network: configuredName })}
            </span>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => switchChain({ chainId: configured.id })}>
              {t("header.switchNetwork", { network: configuredName })}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
