"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi, parseUnits, toHex, zeroHash, type Address, type Hex } from "viem";
import { launchFactoryAbi, templateRegistryAbi } from "@/generated/abis";
import { useDeployment, useTx } from "@/lib/hooks";
import { decodeErrorMessage } from "@/lib/errors";
import { NATIVE_QUOTE } from "@/lib/deployments";
import { TEMPLATE_BASES, templateIdFor } from "@/lib/templates";
import { findQuote, isLaunchable, quoteNotice, useQuotes } from "@/lib/quotes";
import { formatAmount } from "@/lib/format";
import { HashEgg } from "@/components/art/HashEgg";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { Panel } from "@/components/ui/Panel";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Field, FieldRow } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Kv } from "@/components/ui/Kv";
import { ModuleBlocks } from "@/components/ui/ModuleBlocks";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { Skeleton } from "@/components/ui/Skeleton";
import { TxStatus } from "@/components/TxStatus";
import { ImageDrop, imageProblem } from "@/components/ImageDrop";
import { Spinner } from "@/components/ui/Spinner";
import { buildMetadata, DESCRIPTION_MAX, normalizeLink, uploadImage, uploadMetadata, type MediaUpload, type TokenLinks } from "@/lib/media";
import { useT } from "@/i18n/provider";
import { usePauseFlags } from "@/lib/pause";
import { PageHeader } from "@/components/ui/SectionHeading";

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** RWA quote notice: one truncated line by default; the toggle expands the full PRD 11.3 text. */
function RwaNotice({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useT();
  return (
    <Notice tone="amber" className="mt-3 text-xs">
      {open ? text : `${text.slice(0, 24)}…`}
      <span
        role="button"
        tabIndex={0}
        className="ml-2 cursor-pointer underline decoration-amber/40 hover:decoration-amber"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? t("create.rwa.less") : t("create.rwa.more")}
      </span>
    </Notice>
  );
}

export default function CreatePage() {
  const { address, isConnected } = useAccount();
  const { chainId, deployment } = useDeployment();
  const { quotes } = useQuotes();
  const { t, locale } = useT();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  // media: the image uploads as soon as it is picked; the metadata JSON (name, symbol, description, links, image)
  // uploads when "Launch" is pressed, and its URI is what goes on-chain. Nobody types an ipfs:// address.
  const [image, setImage] = useState<{ upload: MediaUpload | null; status: "idle" | "uploading" | "done" | "error"; error: string | null }>({
    upload: null,
    status: "idle",
    error: null,
  });
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState<TokenLinks>({});
  const [uri, setUri] = useState("");
  const [launchStep, setLaunchStep] = useState<"idle" | "uploading" | "previewing">("idle");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [quoteAddress, setQuoteAddress] = useState<Address>(NATIVE_QUOTE);
  const [baseName, setBaseName] = useState("PERK_GRANT_V1");
  const [devBuyInput, setDevBuyInput] = useState("");
  const [salt, setSalt] = useState<Hex | null>(null);

  useEffect(() => {
    if (!salt) setSalt(randomSalt());
  }, [salt]);

  const quote = findQuote(quotes, quoteAddress);
  const templateId = useMemo(() => templateIdFor(baseName, quoteAddress), [baseName, quoteAddress]);

  // Only render templates that TemplateRegistry.isActive for the selected quote.
  const visibleBases = useMemo(
    () => TEMPLATE_BASES.filter((b) => !b.testnetOnly || chainId === 1952),
    [chainId],
  );
  const { data: activeReads } = useReadContracts({
    contracts: visibleBases.map((b) => ({
      address: deployment!.templateRegistry,
      abi: templateRegistryAbi,
      functionName: "isActive" as const,
      args: [templateIdFor(b.baseName, quoteAddress)] as const,
    })),
    query: { enabled: !!deployment },
  });
  const activeByBase = useMemo(() => {
    const m = new Map<string, boolean>();
    visibleBases.forEach((b, i) => m.set(b.baseName, activeReads?.[i]?.result === true));
    return m;
  }, [visibleBases, activeReads]);

  const devBuyQuote = useMemo(() => {
    if (!devBuyInput.trim()) return 0n;
    try {
      return parseUnits(devBuyInput, quote?.decimals ?? 18);
    } catch {
      return null; // invalid input
    }
  }, [devBuyInput, quote?.decimals]);

  const params = useMemo(() => {
    if (!salt) return undefined;
    return {
      templateId,
      quote: quoteAddress,
      moduleParams: "0x" as Hex,
      expectedConfigHash: zeroHash,
      metadata: { name, symbol, uri },
      devBuyQuote: devBuyQuote ?? 0n,
      salt,
    };
  }, [salt, templateId, quoteAddress, name, symbol, uri, devBuyQuote]);

  const preview = useReadContract({
    address: deployment?.factory,
    abi: launchFactoryAbi,
    functionName: "previewLaunch",
    args: params ? [params] : undefined,
    query: {
      enabled: !!deployment && !!params && isConnected && !!name.trim() && !!symbol.trim(),
      retry: false,
    },
  });
  const previewData = preview.data as readonly [Address, Address, bigint, Hex] | undefined;
  const configHash = previewData?.[3];
  const moduleBitmap = previewData?.[2];

  // ERC-20 quote: dev buy pulls from creator, so the factory needs an allowance first.
  const needsApprove = !!deployment && !!quote && !quote.isNative && !!devBuyQuote && devBuyQuote > 0n && !!address;
  const allowance = useReadContract({
    address: quoteAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && deployment ? [address, deployment.factory] : undefined,
    query: { enabled: needsApprove },
  });
  const approveTx = useTx();
  const createTx = useTx();

  const approved =
    !needsApprove || (allowance.data !== undefined && devBuyQuote !== null && allowance.data >= devBuyQuote);

  const pause = usePauseFlags();
  const canSubmit =
    !!deployment &&
    isConnected &&
    !!name.trim() &&
    !!symbol.trim() &&
    image.status === "done" &&
    launchStep === "idle" &&
    devBuyQuote !== null &&
    !pause.isPaused("launch") &&
    approved &&
    !createTx.isPending &&
    !createTx.isConfirming;

  const pickImage = async (file: File) => {
    const problem = imageProblem(file);
    if (problem) return setImage({ upload: null, status: "error", error: t(problem) });
    setImage({ upload: null, status: "uploading", error: null });
    try {
      setImage({ upload: await uploadImage(file), status: "done", error: null });
    } catch (e) {
      setImage({ upload: null, status: "error", error: decodeErrorMessage(e, t) });
    }
  };

  // Launch = (1) upload metadata → its URI, (2) wait for previewLaunch with that URI (the token address depends on
  // it), (3) createLaunch. Steps 1–2 show on the button; step 3 is an ordinary useTx write.
  const startLaunch = async () => {
    if (!image.upload) return;
    setLaunchError(null);
    setLaunchStep("uploading");
    try {
      const meta = buildMetadata({ name, symbol, description, image: image.upload.uri, links });
      const up = await uploadMetadata(meta);
      setUri(up.uri);
      setLaunchStep("previewing");
    } catch (e) {
      setLaunchStep("idle");
      setLaunchError(decodeErrorMessage(e, t));
    }
  };
  const previewedUri = (params?.metadata.uri ?? "") === uri && !!uri;
  useEffect(() => {
    if (launchStep !== "previewing" || !previewedUri || preview.isFetching) return;
    if (preview.error || !configHash || !params || !deployment) {
      setLaunchStep("idle");
      if (preview.error) setLaunchError(decodeErrorMessage(preview.error, t));
      return;
    }
    setLaunchStep("idle");
    createTx.write({
      address: deployment.factory,
      abi: launchFactoryAbi,
      functionName: "createLaunch",
      args: [{ ...params, expectedConfigHash: configHash }],
      value: quote?.isNative ? (devBuyQuote ?? 0n) : 0n,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchStep, previewedUri, preview.isFetching, preview.error, configHash]);

  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("create.network.body")}
      </Notice>
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t("home.door.launchTag")} title={t("create.title")} description={t("create.subtitle")} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* left: form */}
        <div className="space-y-6">
          <Panel title={t("create.section.basic")}>
            <div className="space-y-4">
              <Field label={t("create.field.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("create.field.namePh")} />
              <Field label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={t("create.field.symbolPh")} />
              <FieldRow label={t("launch.image.title")}>
                <ImageDrop
                  previewUrl={image.upload?.url ?? null}
                  status={image.status}
                  error={image.error}
                  onPick={pickImage}
                  onClear={() => setImage({ upload: null, status: "idle", error: null })}
                />
              </FieldRow>
              <Field
                label={t("launch.desc.label")}
                textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
                placeholder={t("launch.desc.placeholder")}
                hint={`${description.length}/${DESCRIPTION_MAX}`}
              />
              {/* one row each, on the same label grid as every other field: squeezed three to a line, the
                  labels took most of each column and the inputs showed three characters */}
              <>
                {(["x", "telegram", "website"] as const).map((k) => {
                  const v = links[k] ?? "";
                  const bad = !!v.trim() && !normalizeLink(k, v);
                  return (
                    <Field
                      key={k}
                      label={t(`launch.link.${k}`)}
                      value={v}
                      onChange={(e) => setLinks((l) => ({ ...l, [k]: e.target.value }))}
                      placeholder={t(`launch.link.${k}Ph`)}
                      hint={bad ? t("launch.link.invalid") : undefined}
                    />
                  );
                })}
              </>
            </div>
          </Panel>

          <Panel title={t("create.section.quote")}>
            <div role="radiogroup" aria-label={t("create.section.quote")} className="grid gap-3 sm:grid-cols-2">
              {quotes.filter(isLaunchable).map((q) => {
                const selected = q.address.toLowerCase() === quoteAddress.toLowerCase();
                const notice = quoteNotice(q, locale, t("create.quote.rwaNotice"));
                return (
                  <ChoiceCard
                    key={q.address}
                    selected={selected}
                    disabled={!q.enabled}
                    onSelect={() => setQuoteAddress(q.address)}
                  >
                    <div className="block w-full text-left">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          {q.iconUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={q.iconUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                          )}
                          <span className="truncate font-display text-lg">{q.displayName ?? q.symbol}</span>
                        </span>
                        <Pill tone={q.category === "rwa" ? "amber" : "muted"}>{t(`quote.category.${q.category}`)}</Pill>
                      </div>
                      <div className="num mt-2 text-xs text-subtle">
                        {q.displayName ? `${q.symbol} · ` : ""}
                        {q.isNative ? t("create.quote.native") : t("create.quote.decimals", { n: q.decimals })}
                      </div>
                    </div>
                    {notice && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <RwaNotice text={notice} />
                      </div>
                    )}
                  </ChoiceCard>
                );
              })}
            </div>
          </Panel>

          <Panel title={t("create.section.template")}>
            <div role="radiogroup" aria-label={t("create.section.template")} className="space-y-3">
              {visibleBases
                .filter((b) => activeByBase.get(b.baseName) === true)
                .map((b) => {
                  const id = templateIdFor(b.baseName, quoteAddress);
                  const selected = baseName === b.baseName;
                  return (
                    <ChoiceCard key={b.baseName} selected={selected} onSelect={() => setBaseName(b.baseName)}>
                      <div className="block w-full text-left">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display text-lg">{b.label}</span>
                          <Pill tone="muted">{quote?.symbol ?? "…"}</Pill>
                          {b.recommended && <Pill tone="verdigris">{t("create.template.recommended")}</Pill>}
                          {b.testnetOnly && <Pill tone="muted">{t("create.template.testnet")}</Pill>}
                        </div>
                        <div className="mt-3 space-y-1">
                          {b.lines.map(([k, v]) => (
                            <div key={k} className="flex items-baseline justify-between gap-4 text-xs">
                              <span className="num text-subtle">{t(k)}</span>
                              <span className="num text-right text-bone">{t(v)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="mt-3 border-t border-line pt-1" onClick={(e) => e.stopPropagation()}>
                        <Kv label="Template ID" value={id} copy />
                      </div>
                    </ChoiceCard>
                  );
                })}
              {visibleBases.every((b) => activeByBase.get(b.baseName) === undefined) && (
                <Skeleton size={48} lines={2} />
              )}
              {visibleBases.length > 0 && visibleBases.every((b) => activeByBase.get(b.baseName) === false) && (
                <Notice tone="amber">{t("create.template.noneActive")}</Notice>
              )}
            </div>
          </Panel>

          <Panel title={t("create.section.devBuy")}>
            <Field
              label={t("common.spendQuote", { symbol: quote?.symbol ?? "Quote" })}
              hint={t("create.devBuy.hint")}
              value={devBuyInput}
              onChange={(e) => setDevBuyInput(e.target.value)}
              placeholder="0"
              inputMode="decimal"
              numeric
              error={devBuyQuote === null ? t("common.invalidAmount") : undefined}
            />
            {needsApprove && !approved && (
              <div className="mt-3">
                <Button
                  variant="ghost"
                  tx={approveTx}
                  disabled={approveTx.isPending || approveTx.isConfirming}
                  onClick={() =>
                    devBuyQuote &&
                    approveTx.write({
                      address: quoteAddress,
                      abi: erc20Abi,
                      functionName: "approve",
                      args: [deployment.factory, devBuyQuote],
                    })
                  }
                >
                  {t("create.devBuy.approve", {
                    amount: formatAmount(devBuyQuote, quote?.decimals, { locale }),
                    symbol: quote?.symbol ?? "",
                  })}
                </Button>
                <TxStatus tx={approveTx} successText={t("common.approveSuccess")} />
              </div>
            )}
          </Panel>
        </div>

        {/* right: sticky preview */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <Panel title={t("create.preview.title")}>
            {/* the egg is laid afresh each time the configuration (and so its hash) changes; hovering the preview lifts
                its lid on the uploaded image, or on the hatchling drawn from the same hash */}
            <div className="group relative isolate flex flex-col items-center overflow-hidden rounded-2xl bg-yolk/15 py-6">
              <div className="grid-paper absolute inset-0 -z-10" aria-hidden />
              <span key={configHash ?? "empty"} className="twinkle">
                {configHash ? (
                  <LaunchAvatar
                    hash={configHash}
                    image={image.upload?.url}
                    size={128}
                    title={name || symbol ? `${name} (${symbol})` : t("create.preview.eggTitle")}
                  />
                ) : (
                  <HashEgg size={128} title={t("create.preview.eggTitle")} />
                )}
              </span>
              <p className="mt-3 font-display text-[22px]">{name.trim() || t("create.preview.unnamed")}</p>
              <p className="num font-mono text-xs tracking-wider text-subtle">{symbol.trim() || "—"}</p>
            </div>
            <div className="mt-2 divide-y divide-line">
              <Kv label={t("create.preview.predicted")} value={previewData?.[0]} copy />
              <Kv label="Hook" value={previewData?.[1]} copy />
              <Kv label="configHash" value={configHash} copy />
            </div>
            <div className="mt-4">
              <p className="label mb-2">{t("common.modules")}</p>
              <ModuleBlocks bitmap={moduleBitmap} />
            </div>
            <div className="mt-5">
              <FeeSplitBar />
            </div>
            {!isConnected && (
              <p className="label mt-4 text-center">{t("create.preview.connectHint")}</p>
            )}
            {isConnected && preview.isLoading && <p className="mt-4 text-sm text-muted">{t("create.preview.loading")}</p>}
            {preview.error && (
              <Notice tone="rose" className="mt-4">
                {t("create.preview.error", { msg: decodeErrorMessage(preview.error, t) })}
              </Notice>
            )}
            <div className="mt-5">
              <Button tx={createTx} disabled={!canSubmit} onClick={startLaunch}>
                {launchStep !== "idle" ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Spinner size={14} />
                    {t(launchStep === "uploading" ? "launch.step.uploading" : "launch.step.previewing")}
                  </span>
                ) : pause.isPaused("launch") ? (
                  t("pause.cta.launch")
                ) : (
                  t("create.submit.cta")
                )}
              </Button>
              {isConnected && !canSubmit && launchStep === "idle" && createTx.phase === "idle" && (
                <p className="mt-2 text-xs text-subtle">
                  {!name.trim() || !symbol.trim()
                    ? t("launch.need.nameSymbol")
                    : image.status !== "done"
                      ? t("launch.need.image")
                      : t("create.submit.hint")}
                </p>
              )}
              {launchError && <Notice tone="rose" className="mt-3">{launchError}</Notice>}
              <TxStatus tx={createTx} successText={t("create.submit.success")} />
              {createTx.isSuccess && previewData && (
                <p className="mt-3 text-sm">
                  <Link className="text-flare underline decoration-flare/40" href={`/meme/${previewData[0]}`}>
                    {t("create.submit.goto")}
                  </Link>
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
