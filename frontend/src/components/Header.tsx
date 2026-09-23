"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { DEFAULT_CHAIN } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { Pill } from "@/components/ui/Pill";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";
import { useT } from "@/i18n/provider";
import Image from "next/image";
import { Sparkle } from "@/components/art/Sparkle";
import { CheckIcon, ChevronDownIcon, GlobeIcon, MoonIcon, SunIcon, SystemIcon } from "@/components/ui/Icon";
import { SyncStatus } from "@/components/SyncStatus";
import { AccountMenu } from "@/components/AccountMenu";
import { useAdminRoles } from "@/lib/admin";
import { useDismiss } from "@/lib/use-dismiss";

const THEME_KEY = "perk-theme";
const PALETTE_KEY = "perk-palette";
type ThemeChoice = "system" | "light" | "dark";
type PaletteChoice = "graphite" | "moss" | "stone";

/**
 * The neutral families a reader can pick (globals.css). Only the neutral tones differ and every lightness step is
 * shared, so each is as readable as the others; Graphite is the default. Swatches: the family's page colour in
 * dark and in light.
 */
const PALETTES: { key: PaletteChoice; swatch: readonly [string, string] }[] = [
  { key: "graphite", swatch: ["#121916", "#F4F5F1"] },
  { key: "moss", swatch: ["#0A1A19", "#EFF7F0"] },
  { key: "stone", swatch: ["#191713", "#F7F4ED"] },
];

/** Resolve a choice onto <html data-theme>; the inline script in app/layout.tsx does the same before first paint. */
function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const resolved =
    choice === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : choice;
  root.dataset.theme = resolved;
  root.dataset.themeSource = choice === "system" ? "system" : "user";
}

/** Apply a palette to <html data-palette>; Graphite is the absence of the attribute. */
function applyPalette(palette: PaletteChoice) {
  const root = document.documentElement;
  if (palette === "graphite") delete root.dataset.palette;
  else root.dataset.palette = palette;
}

// No horizontal padding in the base: a `px-0` added on top would lose to `px-3` in Tailwind's generated order and
// squeeze the icon. Each chip sets its own width or padding.
const CHIP_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-line text-[13px] text-muted transition-colors duration-fast hover:border-line-strong hover:text-bone";
const MENU_ITEM =
  "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors duration-fast hover:bg-raised";

/**
 * Theme menu: the mode (follow the system, or pin light or dark) and the colour palette. It stays open while choosing
 * so palettes can be compared in both modes; a click outside or Escape closes it.
 */
function ThemeMenu() {
  const { t } = useT();
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [palette, setPalette] = useState<PaletteChoice>("graphite");
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      /* storage blocked: follow the system */
    }
    setChoice(stored === "light" || stored === "dark" ? stored : "system");
    const applied = document.documentElement.dataset.palette;
    setPalette(applied === "moss" || applied === "stone" ? applied : "graphite");
    // while following the system, follow it live (e.g. macOS switching at sunset)
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (document.documentElement.dataset.themeSource !== "user") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function pickMode(next: ThemeChoice) {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* not persisted; still applied for this visit */
    }
    applyTheme(next);
    setChoice(next);
  }

  function pickPalette(next: PaletteChoice) {
    try {
      if (next === "graphite") localStorage.removeItem(PALETTE_KEY);
      else localStorage.setItem(PALETTE_KEY, next);
    } catch {
      /* not persisted; still applied for this visit */
    }
    applyPalette(next);
    setPalette(next);
  }

  const modes: { key: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
    { key: "system", label: t("header.theme.system"), Icon: SystemIcon },
    { key: "light", label: t("header.theme.light"), Icon: SunIcon },
    { key: "dark", label: t("header.theme.dark"), Icon: MoonIcon },
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
        className={`${CHIP_BASE} w-8 justify-center`}
      >
        <Current size={15} />
      </button>
      {open && (
        <>
          <span role="menu" aria-label={t("header.theme.title")} className="popover absolute right-0 z-30 mt-2 flex w-48 flex-col p-1.5">
            <span role="group" aria-label={t("header.theme.mode")} className="flex flex-col gap-0.5">
              <span className="px-2.5 pb-0.5 pt-1 text-xs text-subtle" aria-hidden>
                {t("header.theme.mode")}
              </span>
              {modes.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={key === choice}
                  onClick={() => pickMode(key)}
                  className={`${MENU_ITEM} ${key === choice ? "text-bone" : "text-muted"}`}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="flex-1">{label}</span>
                  {key === choice && <CheckIcon size={14} className="text-flare" />}
                </button>
              ))}
            </span>
            <span role="separator" className="mx-1 my-1.5 border-t border-line" />
            <span role="group" aria-label={t("header.theme.palette")} className="flex flex-col gap-0.5">
              <span className="px-2.5 pb-0.5 pt-1 text-xs text-subtle" aria-hidden>
                {t("header.theme.palette")}
              </span>
              {PALETTES.map(({ key, swatch }) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={key === palette}
                  onClick={() => pickPalette(key)}
                  className={`${MENU_ITEM} ${key === palette ? "text-bone" : "text-muted"}`}
                >
                  <span className="flex h-[15px] w-[15px] shrink-0 overflow-hidden rounded-full ring-1 ring-line-strong" aria-hidden>
                    <span className="h-full w-1/2" style={{ background: swatch[0] }} />
                    <span className="h-full w-1/2" style={{ background: swatch[1] }} />
                  </span>
                  <span className="flex-1">{t(`header.theme.palette.${key}`)}</span>
                  {key === palette && <CheckIcon size={14} className="text-flare" />}
                </button>
              ))}
            </span>
          </span>
        </>
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
        className={`${CHIP_BASE} w-8 justify-center sm:w-auto sm:px-3`}
      >
        <GlobeIcon size={14} />
        <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
        <ChevronDownIcon size={12} className="-mr-0.5 hidden opacity-70 sm:block" />
      </button>
      {open && (
        <>
          <span role="listbox" className="popover absolute right-0 z-30 mt-2 flex min-w-36 flex-col gap-0.5 p-1.5">
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
  const adminRoles = useAdminRoles();

  const configured = DEFAULT_CHAIN;
  const configuredName = configured.testnet ? t("header.network.testnet") : configured.name;
  const wrongChain = isConnected && chainId !== configured.id;
  const dotClass = !isConnected ? "bg-faint" : wrongChain ? "bg-rose" : "bg-verdigris";

  // entries by intent (like a DEX): trade memes, provide liquidity through LP Grant, launch a token.
  // A token page belongs to Trade; a campaign page belongs to LP Grant.
  const nav = [
    { href: "/trade", label: t("nav.trade"), match: (p: string) => p.startsWith("/trade") || p.startsWith("/meme") },
    { href: "/pool", label: t("nav.pool"), match: (p: string) => p.startsWith("/pool") },
    { href: "/grant", label: t("nav.grant"), match: (p: string) => p.startsWith("/grant") },
    // launching is rare next to trading / LP: a plain entry, not a highlighted button
    { href: "/launch", label: t("nav.launch"), match: (p: string) => p.startsWith("/launch") },
    // only the wallet that owns the contracts sees the admin entry (the page itself is open, read-only)
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
    {/* two rows on a phone (brand + controls, then nav) and not sticky there: four wrapped rows pinned to the top
        took almost half of a small screen */}
    <header className="z-20 border-b border-line bg-ink/85 backdrop-blur-md sm:sticky sm:top-0">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="order-1 flex items-center gap-2.5" aria-label="Perk">
          <Image
            src="/brand/perk-logo.jpeg"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-full"
            priority
          />
          <span className="wordmark text-[22px] leading-none">Perk</span>
          <Sparkle size={9} tone="flare" className="-ml-1.5 -mt-3" />
        </Link>
        <nav className="order-3 -ml-2 flex w-full items-center gap-0.5 overflow-x-auto text-[14px] sm:order-2 sm:w-auto">
          {nav.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 transition-colors duration-fast ${
                  active ? "bg-raised font-medium text-bone" : "text-muted hover:text-bone"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="order-2 ml-auto flex items-center gap-2 sm:order-3">
          <LanguageMenu />
          <ThemeMenu />
          <SyncStatus />
          <button
            type="button"
            onClick={() => wrongChain && switchChain({ chainId: configured.id })}
            title={wrongChain ? t("header.wrongChain", { network: configuredName }) : configuredName}
            className={`hidden sm:inline-flex ${wrongChain ? "cursor-pointer" : "cursor-default"}`}
          >
            <Pill tone={wrongChain ? "rose" : isConnected ? "verdigris" : "muted"}>
              <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
              {configuredName}
            </Pill>
          </button>
          {walletStatus === "reconnecting" ? (
            // restoring a previous session: hold the slot instead of flashing "Connect wallet"
            <span className="skel inline-block h-8 w-[132px] rounded-full" aria-busy="true" />
          ) : isConnected && address ? (
            <AccountMenu />
          ) : (
            <button
              type="button"
              className="btn-primary h-8 px-4 text-[13px]"
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
