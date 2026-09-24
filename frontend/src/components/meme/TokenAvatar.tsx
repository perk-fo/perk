"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { HashSeal } from "@/components/art/HashSeal";

/**
 * The token's own image with its seal as a badge on the corner, or the seal alone when there is no image or it does
 * not load (a gateway down, a file gone): the seal is what proves the configuration, the image is decoration.
 */
export function TokenAvatar({
  image,
  configHash,
  moduleBitmap,
  size = 72,
  hover = false,
}: {
  image: string | null | undefined;
  configHash: Hex;
  moduleBitmap: bigint;
  size?: number;
  /** passed to the seal: lights its module ticks */
  hover?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!image || failed === image) {
    return <HashSeal hash={configHash} moduleBitmap={moduleBitmap} size={size} hover={hover} className="shrink-0" />;
  }
  const badge = Math.max(20, Math.round(size * 0.42));
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image}
        alt=""
        onError={() => setFailed(image)}
        className="h-full w-full object-cover"
        style={{ borderRadius: Math.round(size / 4) }}
      />
      <HashSeal
        hash={configHash}
        moduleBitmap={moduleBitmap}
        size={badge}
        hover={hover}
        className="absolute -bottom-1.5 -right-1.5 rounded-full ring-2 ring-surface"
      />
    </span>
  );
}
