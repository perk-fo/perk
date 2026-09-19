import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import {
  decodePerkLog,
  decodeSwapLog,
  decodeTransferLog,
  perkContracts,
  orderForApply,
  sortLogs,
  type PerkContract,
  type RawLog,
} from "../src/chain/events";
import {
  ABI_BY_CONTRACT,
  TEST_DEPLOYMENT as D,
  blockHash,
  makeLog,
  makeSwapLog,
  makeTransferLog,
  type MockLog,
} from "./helpers";

const MEME = "0x0000000000000000000000000000000000001111" as Address;
const BUYER = "0x0000000000000000000000000000000000003333" as Address;
const SELLER = "0x0000000000000000000000000000000000004444" as Address;
const CREATOR = "0x0000000000000000000000000000000000002222" as Address;
const LAUNCH_ID = (`0x${"11".repeat(32)}`) as Hex;
const TEMPLATE_ID = (`0x${"22".repeat(32)}`) as Hex;
const CONFIG_HASH = (`0x${"33".repeat(32)}`) as Hex;
const POOL_ID = (`0x${"44".repeat(32)}`) as Hex;
const QUOTE = "0x0000000000000000000000000000000000000000" as Address;

function perkMap() {
  const m = new Map<string, { name: PerkContract; abi: readonly unknown[] }>();
  for (const c of perkContracts(D)) m.set(c.address.toLowerCase(), { name: c.name, abi: c.abi });
  return m;
}

function asRaw(log: MockLog): RawLog {
  return {
    address: log.address,
    blockNumber: log.blockNumber,
    blockHash: blockHash(log.blockNumber),
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  };
}

function lowerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.startsWith("0x")) out[k] = v.toLowerCase();
    else out[k] = v;
  }
  return out;
}

describe("events", () => {
  test("LaunchCreated round-trip", () => {
    const args = {
      launchId: LAUNCH_ID,
      meme: MEME,
      creator: CREATOR,
      quote: QUOTE,
      templateId: TEMPLATE_ID,
      configHash: CONFIG_HASH,
    };
    const log = makeLog({
      address: D.factory,
      abi: ABI_BY_CONTRACT.factory,
      eventName: "LaunchCreated",
      args,
      blockNumber: 1000n,
    });
    const decoded = decodePerkLog(asRaw(log), perkMap());
    expect(decoded).not.toBeNull();
    expect(decoded!.eventName).toBe("LaunchCreated");
    expect(decoded!.contract).toBe("factory");
    const got = lowerArgs(decoded!.args as Record<string, unknown>);
    expect(got.launchId).toBe(LAUNCH_ID);
    expect(got.meme).toBe(MEME);
    expect(got.creator).toBe(CREATOR);
    expect(got.quote).toBe(QUOTE);
    expect(got.templateId).toBe(TEMPLATE_ID);
    expect(got.configHash).toBe(CONFIG_HASH);
  });

  test("CurveBuy round-trip", () => {
    const args = {
      meme: MEME,
      buyer: BUYER,
      recipient: BUYER,
      quoteGross: 100n,
      fee: 1n,
      quoteNet: 99n,
      memeOut: 1000n,
    };
    const log = makeLog({
      address: D.curve,
      abi: ABI_BY_CONTRACT.curve,
      eventName: "CurveBuy",
      args,
      blockNumber: 1001n,
    });
    const decoded = decodePerkLog(asRaw(log), perkMap())!;
    expect(decoded.eventName).toBe("CurveBuy");
    expect(decoded.args.quoteGross).toBe(100n);
    expect(decoded.args.fee).toBe(1n);
    expect(decoded.args.quoteNet).toBe(99n);
    expect(decoded.args.memeOut).toBe(1000n);
    expect((decoded.args.buyer as string).toLowerCase()).toBe(BUYER);
  });

  test("CurveSell round-trip", () => {
    const args = {
      meme: MEME,
      seller: SELLER,
      recipient: SELLER,
      memeIn: 500n,
      quoteGross: 40n,
      fee: 1n,
      quoteNet: 39n,
    };
    const log = makeLog({
      address: D.curve,
      abi: ABI_BY_CONTRACT.curve,
      eventName: "CurveSell",
      args,
      blockNumber: 1002n,
    });
    const decoded = decodePerkLog(asRaw(log), perkMap())!;
    expect(decoded.eventName).toBe("CurveSell");
    expect(decoded.args.memeIn).toBe(500n);
    expect(decoded.args.quoteGross).toBe(40n);
    expect(decoded.args.quoteNet).toBe(39n);
  });

  test("Swap round-trip", () => {
    const log = makeSwapLog({
      poolManager: D.poolManager,
      id: POOL_ID,
      sender: BUYER,
      amount0: -10n,
      amount1: 200n,
      blockNumber: 1003n,
    });
    const decoded = decodeSwapLog(asRaw(log))!;
    expect(decoded.eventName).toBe("Swap");
    expect(decoded.contract).toBe("poolManager");
    expect(decoded.args.id.toLowerCase()).toBe(POOL_ID);
    expect(decoded.args.amount0).toBe(-10n);
    expect(decoded.args.amount1).toBe(200n);
    expect(decoded.args.sender.toLowerCase()).toBe(BUYER);
  });

  test("Transfer round-trip", () => {
    const log = makeTransferLog({
      token: MEME,
      from: BUYER,
      to: SELLER,
      value: 42n,
      blockNumber: 1004n,
    });
    const decoded = decodeTransferLog(asRaw(log))!;
    expect(decoded.eventName).toBe("Transfer");
    expect(decoded.contract).toBe("memeToken");
    expect(decoded.args.from.toLowerCase()).toBe(BUYER);
    expect(decoded.args.to.toLowerCase()).toBe(SELLER);
    expect(decoded.args.value).toBe(42n);
  });

  test("GrantActivated round-trip", () => {
    const args = {
      positionId: 7n,
      meme: MEME,
      beneficiary: BUYER,
      baseActivated: 10n,
      inviteeBoostActivated: 1n,
      inviterCreditActivated: 2n,
      quoteDeposited: 5n,
      liquidity: 99n,
    };
    const log = makeLog({
      address: D.lpGrantVault,
      abi: ABI_BY_CONTRACT.lpGrantVault,
      eventName: "GrantActivated",
      args,
      blockNumber: 1005n,
    });
    const decoded = decodePerkLog(asRaw(log), perkMap())!;
    expect(decoded.eventName).toBe("GrantActivated");
    expect(decoded.args.positionId).toBe(7n);
    expect(decoded.args.baseActivated).toBe(10n);
    expect(decoded.args.liquidity).toBe(99n);
    expect((decoded.args.beneficiary as string).toLowerCase()).toBe(BUYER);
  });

  test("unknown selector on a Perk address returns null", () => {
    const raw: RawLog = {
      address: D.factory,
      blockNumber: 1n,
      blockHash: blockHash(1n),
      transactionHash: (`0x${"ab".repeat(32)}`) as Hex,
      logIndex: 0,
      topics: [(`0x${"de".repeat(32)}`) as Hex],
      data: "0x",
    };
    expect(decodePerkLog(raw, perkMap())).toBeNull();
  });

  test("sortLogs orders by block then log index", () => {
    const mk = (block: bigint, idx: number): RawLog => ({
      address: D.factory,
      blockNumber: block,
      blockHash: blockHash(block),
      transactionHash: (`0x${block.toString(16).padStart(64, "0")}`) as Hex,
      logIndex: idx,
      topics: [],
      data: "0x",
    });
    const logs = [mk(3n, 1), mk(1n, 9), mk(2n, 0), mk(3n, 0), mk(1n, 1)];
    const sorted = sortLogs(logs);
    expect(sorted.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(["1:1", "1:9", "2:0", "3:0", "3:1"]);
  });

  test("orderForApply moves LaunchCreated in front of its transaction siblings", () => {
    const tx = (`0x${"11".repeat(32)}`) as Hex;
    const mk = (idx: number, contract: string, eventName: string, hash: Hex = tx) => ({
      address: D.factory,
      blockNumber: 5n,
      blockHash: blockHash(5n),
      transactionHash: hash,
      logIndex: idx,
      topics: [] as [],
      data: "0x" as Hex,
      contract,
      eventName,
      args: {},
    });
    const other = (`0x${"22".repeat(32)}`) as Hex;
    const logs = [
      mk(19, "factory", "LaunchCreated"),
      mk(15, "memeToken", "Transfer"),
      mk(18, "curve", "CurveInitialized"),
      mk(20, "factory", "LaunchTemplateSelected"),
      mk(3, "curve", "CurveBuy", other),
    ];
    const ordered = orderForApply(logs).map((l) => `${l.logIndex}:${l.eventName}`);
    expect(ordered).toEqual(["3:CurveBuy", "19:LaunchCreated", "15:Transfer", "18:CurveInitialized", "20:LaunchTemplateSelected"]);
  });
});
