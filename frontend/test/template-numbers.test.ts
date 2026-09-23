import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import fixture from "./fixtures/templates-1952.json";
import { templateIdFor } from "@/lib/templates";
import {
  defaultNumbers,
  fastNumbers,
  forQuote,
  memeSoldAtGraduation,
  perkGrantV1,
  standardCurveV1,
  templateProblem,
  withThreshold,
  type TemplateStruct,
} from "@/lib/template-numbers";

/** JSON form of a struct, numbers as strings, the way the fixture stores what the chain returned. */
function plain(t: TemplateStruct): unknown {
  return JSON.parse(JSON.stringify(t, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const quote = getAddress(fixture.quote) as Address;
const tAAPL = forQuote(defaultNumbers(), quote, fixture.decimals);

describe("template numbers match the templates the deploy scripts registered on testnet", () => {
  test("Perk Grant V1 bound to a 6-decimal quote", () => {
    expect(templateIdFor("PERK_GRANT_V1", quote)).toBe(fixture.PERK_GRANT_V1.id as `0x${string}`);
    expect(plain(perkGrantV1(tAAPL))).toEqual(fixture.PERK_GRANT_V1.template);
  });
  test("Standard Curve V1 bound to a 6-decimal quote", () => {
    expect(plain(standardCurveV1(tAAPL))).toEqual(fixture.STANDARD_CURVE_V1.template);
  });
  test("the testnet fast template", () => {
    expect(templateIdFor("TEST_FAST_V1", quote)).toBe(fixture.TEST_FAST_V1.id as `0x${string}`);
    expect(plain(perkGrantV1(fastNumbers(tAAPL)))).toEqual(fixture.TEST_FAST_V1.template);
  });
  test("native OKB, 18 decimals", () => {
    const okb = forQuote(defaultNumbers(), "0x0000000000000000000000000000000000000000", 18);
    expect(plain(perkGrantV1(okb))).toEqual(fixture["native.PERK_GRANT_V1"].template);
    expect(plain(standardCurveV1(okb))).toEqual(fixture["native.STANDARD_CURVE_V1"].template);
  });
  test("the default threshold reproduces forQuote exactly", () => {
    expect(withThreshold(tAAPL, 85_000_000n)).toEqual(tAAPL);
  });
});

describe("a custom threshold keeps the curve valid", () => {
  test("the share sold at graduation never exceeds the curve supply", () => {
    for (const th of [85n, 86n, 97n, 1_000n, 12_345_679n, 100_000_000n, 3n * 10n ** 25n]) {
      for (const n of [withThreshold(tAAPL, th), fastNumbers(withThreshold(tAAPL, th))]) {
        const t = perkGrantV1(n);
        if (t.curve.graduationQuoteThreshold === 0n) continue;
        expect(memeSoldAtGraduation(t) <= t.supply.curveSupply).toBe(true);
        expect(templateProblem(t)).toBeNull();
      }
    }
  });
  test("a threshold too small for the fast curve is caught before signing", () => {
    expect(templateProblem(perkGrantV1(fastNumbers(withThreshold(tAAPL, 9_999n))))).toBe("zeroThreshold");
  });
});
