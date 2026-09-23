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
}: {
  image: string | null | undefined;
  configHash: Hex;
  moduleBitmap: bigint;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!image || failed === image) {
    return <HashSeal hash={configHash} moduleBitmap={moduleBitmap} size={72} className="shrink-0" />;
  }
  return (
    <span className="relative shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt="" onError={() => setFailed(image)} className="h-[72px] w-[72px] rounded-[18px] object-cover" />
      <HashSeal
        hash={configHash}
        moduleBitmap={moduleBitmap}
        size={30}
        className="absolute -bottom-2 -right-2 rounded-full ring-2 ring-ink"
      />
    </span>
  );
}
