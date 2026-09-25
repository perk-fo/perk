import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeAbiParameters, getAddress, parseAbiParameters, zeroAddress } from "viem";
import { CAMPAIGN_ABI } from "../src/abi";

const HEAD =
  "uint8 status, address quote, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 poolId, bool memeIsCurrency0, int24 tickLower, int24 tickUpper, uint64 graduatedAt, uint64 graduatedAtBlock, uint64 windowSeconds, uint64 minLpSeconds, uint64 startTime, uint64 endTime, uint256 reserve, uint256 basePool, uint256 referralBudget, uint256 referralBudgetUsed, uint256 totalActivated, uint256 burned, bytes32 root, string rootUri, uint64 rootProposedAt, uint256 rootTotalBase, uint256 rootTotalInviteeBoost";

const HOOK = getAddress("0x00000000000000000000000000000000000000bb");
const values = [
  2,
  zeroAddress,
  { currency0: zeroAddress, currency1: getAddress("0x00000000000000000000000000000000000000aa"), fee: 8500, tickSpacing: 60, hooks: HOOK },
  `0x${"01".repeat(32)}`,
  false,
  -887220,
  887220,
  1n,
  41_683_391n,
  7200n,
  600n,
  0n,
  0n,
  10n,
  120n,
  30n,
  0n,
  0n,
  0n,
  `0x${"ab".repeat(32)}`,
  "ipfs://dataset",
  5n,
  100n,
  7n,
] as const;

describe("CAMPAIGN_ABI", () => {
  for (const [label, tail] of [
    ["the deployed vault (three incentive fields)", ", uint256 a, uint256 b, uint256 c"],
    ["the revised vault (liquidity-seconds incentives, registered totals)", ", uint256 a, uint256 b, uint256 c, uint256 d, uint256 e, uint256 f"],
  ] as const) {
    test(`decodes the fields the tools read from ${label}`, () => {
      const extra = tail.split(",").length - 1;
      const data = encodeAbiParameters(parseAbiParameters(`(${HEAD}${tail})`), [
        [...values, ...Array.from({ length: extra }, (_, i) => BigInt(1000 + i))] as never,
      ]);
      const c = decodeFunctionResult({ abi: CAMPAIGN_ABI, functionName: "campaign", data });
      expect(c.status).toBe(2);
      expect(c.key.hooks).toBe(HOOK);
      expect(c.graduatedAtBlock).toBe(41_683_391n);
      expect(c.basePool).toBe(120n);
      expect(c.referralBudget).toBe(30n);
      expect(c.root).toBe(`0x${"ab".repeat(32)}`);
      expect(c.rootUri).toBe("ipfs://dataset");
      expect(c.rootTotalBase).toBe(100n);
      expect(c.rootTotalInviteeBoost).toBe(7n);
    });
  }
});
