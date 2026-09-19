import { MODULE_BITS } from "@/lib/deployments";

/** The five V1 modules as toy bricks; `data-on` comes from the launch's module bitmap. */
export function ModuleBlocks({ bitmap }: { bitmap: bigint | number | undefined }) {
  const bits = bitmap === undefined ? undefined : BigInt(bitmap);
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {MODULE_BITS.map(([bit, label]) => (
        <span key={label} className="module-block" data-on={bits === undefined ? true : (bits & bit) !== 0n}>
          {label}
        </span>
      ))}
    </span>
  );
}
