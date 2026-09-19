"use client";

import { useRef, useState, type DragEvent } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/provider";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Why a picked file cannot be used (i18n key), or null. Pure, for tests. */
export function imageProblem(file: { type: string; size: number }): string | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "launch.image.badType";
  if (file.size > IMAGE_MAX_BYTES) return "launch.image.tooBig";
  return null;
}

/**
 * Token image picker: drop or click, instant local preview, upload status on the tile itself.
 * The parent does the upload (onPick) and reports state back through `status`.
 */
export function ImageDrop({
  previewUrl,
  status,
  error,
  onPick,
  onClear,
}: {
  previewUrl: string | null;
  status: "idle" | "uploading" | "done" | "error";
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const take = (file: File | undefined) => {
    if (!file) return;
    setLocal(URL.createObjectURL(file));
    onPick(file);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files?.[0]);
  };
  const shown = previewUrl ?? local;

  return (
    <div className="flex items-start gap-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`relative grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-[22px] border border-dashed transition-colors duration-fast ${
          over ? "border-flare bg-flare/10" : shown ? "border-bone/20" : "border-bone/25 hover:border-bone/50"
        }`}
        aria-label={t("launch.image.pick")}
      >
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="whitespace-pre-line px-3 text-center text-[12px] leading-snug text-bone/50">{t("launch.image.drop")}</span>
        )}
        {status === "uploading" && (
          <span className="absolute inset-0 grid place-items-center bg-ink/60 text-flare">
            <Spinner size={20} />
          </span>
        )}
        {status === "done" && (
          <span className="absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-verdigris text-[11px] text-ink">
            ✓
          </span>
        )}
      </button>
      <div className="min-w-0 pt-2 text-[12px] leading-relaxed text-bone/50">
        <p>{t("launch.image.rules")}</p>
        {status === "uploading" && <p className="mt-1 text-flare">{t("launch.image.uploading")}</p>}
        {status === "error" && <p className="mt-1 text-rose">{error ?? t("launch.image.failed")}</p>}
        {shown && status !== "uploading" && (
          <button
            type="button"
            onClick={() => {
              setLocal(null);
              onClear();
            }}
            className="mt-2 text-bone/60 underline decoration-dotted underline-offset-4 hover:text-bone"
          >
            {t("launch.image.remove")}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
