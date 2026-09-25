import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAddress, zeroAddress } from "viem";
import { deploymentSystemAddresses, loadDeployment } from "../src/config";
import { applyExclusions, buildExclusions, DEAD_ADDRESS, parseAddressList } from "../src/exclusions";

describe("deploymentSystemAddresses", () => {
  test("takes every contract address, including nested quote assets, and leaves out people and zero", () => {
    const raw = {
      blockNumber: 1,
      hookSalt: `0x${"00".repeat(32)}`,
      deployer: "0x00000000000000000000000000000000000000d0",
      protocolOwner: "0x00000000000000000000000000000000000000d1",
      protocolFeeRecipient: "0x00000000000000000000000000000000000000d2",
      poolManager: "0x0000000000000000000000000000000000000051",
      quoter: zeroAddress,
      quoteAssets: { tAAPL: "0x0000000000000000000000000000000000000070" },
    };
    expect(deploymentSystemAddresses(raw)).toEqual([
      getAddress("0x0000000000000000000000000000000000000051"),
      getAddress("0x0000000000000000000000000000000000000070"),
    ]);
  });

  test("the testnet record yields the Perk contracts, the v4 singletons and the quote tokens", () => {
    const d = loadDeployment(1952);
    const has = (key: string) => {
      const raw = JSON.parse(readFileSync(d.deploymentsPath, "utf8")) as Record<string, string>;
      return d.systemAddresses.includes(getAddress(raw[key]));
    };
    for (const key of ["poolManager", "positionManager", "curve", "feeRouter", "distributor", "treasury", "lpGrantVault", "locker", "hook", "factory", "graduationManager"]) {
      expect(has(key)).toBe(true);
    }
    expect(has("deployer")).toBe(false);
  });
});

describe("buildExclusions", () => {
  test("always holds zero, 0xdead, the meme and the quote; sorted and deduplicated", () => {
    const meme = "0x00000000000000000000000000000000000000aa";
    const quote = "0x00000000000000000000000000000000000000bb";
    const out = buildExclusions({ system: [quote, quote.toUpperCase().replace("0X", "0x")], meme, quote });
    expect(out).toEqual([zeroAddress, getAddress(meme), getAddress(quote), DEAD_ADDRESS].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ));
  });

  test("rejects garbage", () => {
    expect(() => buildExclusions({ system: ["0x123"], meme: zeroAddress, quote: zeroAddress })).toThrow();
  });
});

describe("parseAddressList / applyExclusions", () => {
  test("parses comma and space separated lists", () => {
    expect(parseAddressList(" 0x00000000000000000000000000000000000000aa,0x00000000000000000000000000000000000000bb ")).toHaveLength(2);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(() => parseAddressList("0xnope")).toThrow();
  });

  test("drops excluded accounts case-insensitively and reports them", () => {
    const a = getAddress("0x00000000000000000000000000000000000000aa");
    const b = getAddress("0x00000000000000000000000000000000000000bb");
    const { kept, removed } = applyExclusions(new Map([[a, 1n], [b, 2n]]), [b.toLowerCase() as `0x${string}`]);
    expect([...kept.keys()]).toEqual([a]);
    expect(removed).toEqual([{ account: b, twab: 2n }]);
  });
});
