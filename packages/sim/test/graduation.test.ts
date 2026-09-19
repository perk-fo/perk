import { describe, expect, test } from "bun:test";
import { finalPriceX18, mulDiv, WAD } from "../src/curve.ts";
import {
  compareTemplates,
  defaultNumbers,
  seedPool,
  simulateTemplate,
  type TemplateNumbers,
} from "../src/graduation.ts";

describe("graduation", () => {
  test("test_seedPool_quoteMatchesMemeTimesPrice_withinRounding", () => {
    const priceX18 = finalPriceX18(
      defaultNumbers.virtualQuoteReserve,
      defaultNumbers.virtualMemeReserve,
      defaultNumbers.graduationQuoteThreshold,
    );
    const cases = [
      { memeReceived: 2n * 10n ** 26n, quoteReceived: 85n * 10n ** 18n, priceX18 },
      { memeReceived: 1n, quoteReceived: 10n ** 18n, priceX18 },
      { memeReceived: 10n ** 27n, quoteReceived: 1n, priceX18 },
      { memeReceived: 35n * 10n ** 25n, quoteReceived: 85n * 10n ** 18n + 10n ** 17n, priceX18 },
    ];
    for (const input of cases) {
      const seed = seedPool(input);
      const implied = mulDiv(seed.memeToPool, input.priceX18, WAD);
      const diff = seed.quoteToPool >= implied ? seed.quoteToPool - implied : implied - seed.quoteToPool;
      expect(diff).toBeLessThanOrEqual(1n);
    }
  });

  test("test_seedPool_oneLeftoverIsZero", () => {
    const priceX18 = 5n * 10n ** 11n;
    const cases = [
      { memeReceived: 10n ** 20n, quoteReceived: 10n ** 18n, priceX18 },
      { memeReceived: 1n, quoteReceived: 10n ** 24n, priceX18 },
      { memeReceived: 2n * 10n ** 26n, quoteReceived: 85n * 10n ** 18n, priceX18 },
    ];
    for (const input of cases) {
      const seed = seedPool(input);
      expect(seed.memeLeftover === 0n || seed.quoteLeftover === 0n).toBe(true);
      expect(seed.memeToPool + seed.memeLeftover).toBe(input.memeReceived);
      expect(seed.quoteToPool + seed.quoteLeftover).toBe(input.quoteReceived);
    }
  });

  test("test_compareTemplates_standardMemeLeftoverExceedsPerkByGrantGap", () => {
    // Same curve numbers for both templates; vM chosen so sold < curveSupply and both are quote-limited.
    const numbers: TemplateNumbers = {
      ...defaultNumbers,
      virtualMemeReserve: 8n * 10n ** 26n,
    };
    const cmp = compareTemplates(numbers);
    const grantGap = cmp.perk.grantReserveSupply;
    expect(grantGap).toBe(mulDiv(numbers.totalSupply, 1500n, 10_000n));
    expect(cmp.standard.poolReserveSupply - cmp.perk.poolReserveSupply).toBe(grantGap);
    expect(cmp.perk.seed.quoteLeftover).toBe(0n);
    expect(cmp.standard.seed.quoteLeftover).toBe(0n);
    expect(cmp.standard.seed.memeLeftover - cmp.perk.seed.memeLeftover).toBe(grantGap);
    expect(cmp.memeLeftoverDelta).toBe(grantGap);
  });

  test("test_simulateTemplate_supplySplits", () => {
    const perk = simulateTemplate(defaultNumbers, { grantBps: 1500n });
    const standard = simulateTemplate(defaultNumbers, { grantBps: 0n });
    expect(perk.grantReserveSupply + perk.curveSupply + perk.poolReserveSupply).toBe(defaultNumbers.totalSupply);
    expect(standard.grantReserveSupply).toBe(0n);
    expect(standard.curveSupply + standard.poolReserveSupply).toBe(defaultNumbers.totalSupply);
  });
});
