import { concat, keccak256, toHex, type Address, type Hex } from "viem";
import { NATIVE_QUOTE } from "./deployments";
import { shortHash } from "./format";

/**
 * Mirrors PerkTemplates.templateIdFor: the base id itself for the native OKB quote,
 * keccak256(baseId ++ quote) for any ERC-20 quote.
 */
export function templateIdFor(baseName: string, quote: Address): Hex {
  const baseId = keccak256(toHex(baseName));
  if (quote.toLowerCase() === NATIVE_QUOTE.toLowerCase()) return baseId;
  return keccak256(concat([baseId, quote]));
}

export interface TemplateBase {
  baseName: string;
  /** Product name per PRD 5.1. */
  label: string;
  recommended: boolean;
  testnetOnly: boolean;
  /** One-line description (message key) shown under the name. */
  blurb: string;
  /** PRD 5.1 LP Grant ON/OFF summary rows as [labelKey, valueKey] message keys. */
  lines: Array<[string, string]>;
}

export const TEMPLATE_BASES: readonly TemplateBase[] = [
  {
    baseName: "PERK_GRANT_V1",
    label: "Perk Launch",
    recommended: true,
    testnetOnly: false,
    blurb: "tpl.perk.blurb",
    lines: [
      ["tpl.perk.row1.label", "tpl.perk.row1.value"],
      ["tpl.perk.row2.label", "tpl.perk.row2.value"],
      ["tpl.perk.row3.label", "tpl.perk.row3.value"],
      ["tpl.perk.row4.label", "tpl.perk.row4.value"],
    ],
  },
  {
    baseName: "STANDARD_CURVE_V1",
    label: "Standard Launch",
    recommended: false,
    testnetOnly: false,
    blurb: "tpl.standard.blurb",
    lines: [
      ["tpl.standard.row1.label", "tpl.standard.row1.value"],
      ["tpl.standard.row2.label", "tpl.standard.row2.value"],
      ["tpl.standard.row3.label", "tpl.standard.row3.value"],
      ["tpl.standard.row4.label", "tpl.standard.row4.value"],
    ],
  },
  {
    baseName: "TEST_FAST_V1",
    label: "Test Fast",
    recommended: false,
    testnetOnly: true,
    blurb: "tpl.test.blurb",
    lines: [
      ["tpl.test.row1.label", "tpl.test.row1.value"],
      ["tpl.test.row2.label", "tpl.test.row2.value"],
      ["tpl.test.row3.label", "tpl.test.row3.value"],
    ],
  },
  {
    // Standard-template twin of the fast template (no LP Grant); registered on demand by the demo seeding script
    baseName: "STD_FAST_V1",
    label: "Test Fast · Standard",
    recommended: false,
    testnetOnly: true,
    blurb: "tpl.test.blurb",
    lines: [
      ["tpl.standard.row1.label", "tpl.standard.row1.value"],
      ["tpl.standard.row2.label", "tpl.standard.row2.value"],
      ["tpl.test.row2.label", "tpl.test.row2.value"],
    ],
  },
];

/**
 * Resolve a templateId back to a readable label like "Perk Launch · tAAPL" by trying every
 * base name × every known quote. Falls back to a truncated hash for unknown ids.
 */
export function templateLabel(
  id: string,
  quotes: ReadonlyArray<{ address: Address; symbol: string }>,
): string {
  const target = id.toLowerCase();
  for (const base of TEMPLATE_BASES) {
    for (const q of quotes) {
      if (templateIdFor(base.baseName, q.address).toLowerCase() === target) {
        return q.address.toLowerCase() === NATIVE_QUOTE.toLowerCase()
          ? base.label
          : `${base.label} · ${q.symbol}`;
      }
    }
  }
  return shortHash(id);
}
