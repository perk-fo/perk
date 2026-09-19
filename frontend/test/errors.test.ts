import { describe, expect, test } from "bun:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { lpGrantVaultAbi } from "@/generated/abis";
import { decodeErrorMessage } from "@/lib/errors";
import { PrecheckError } from "@/lib/hooks";

function revert(abi: readonly unknown[], errorName: string, args: unknown[] = []) {
  const data = encodeErrorResult({ abi: abi as never, errorName: errorName as never, args: args as never });
  const cause = new ContractFunctionRevertedError({ abi: abi as never, data, functionName: "x" });
  return new ContractFunctionExecutionError(cause, { abi: abi as never, functionName: "x", args: [] });
}

describe("decodeErrorMessage", () => {
  test("known contract errors read as plain language", () => {
    expect(decodeErrorMessage(revert(lpGrantVaultAbi, "MinLpNotElapsed", [123n]))).toBe("还没到最短做市期限，暂时不能退出");
  });
  test("unknown ones fall back to the error name", () => {
    expect(decodeErrorMessage(revert(lpGrantVaultAbi, "RootBudgetExceeded"))).toBe("合约拒绝：RootBudgetExceeded");
  });
  test("reverts caught by the pre-send simulation say nothing was sent", () => {
    const e = Object.assign(revert(lpGrantVaultAbi, "WindowClosed"), { precheck: true });
    expect(decodeErrorMessage(e)).toBe("交易预检未通过：窗口期已结束");
  });
  test("a result check stops with its own message", () => {
    expect(decodeErrorMessage(new PrecheckError("errors.precheck.nothingToClaim"))).toBe("暂无可领取的金额，不会发起交易");
  });
});

describe("wallet rejection", () => {
  test("is recognised when wagmi wraps it", async () => {
    const { UserRejectedRequestError, TransactionExecutionError } = await import("viem");
    const inner = new UserRejectedRequestError(new Error("User rejected the request."));
    const wrapped = new TransactionExecutionError(inner, {} as never);
    expect(decodeErrorMessage(wrapped)).toBe("用户取消了签名");
  });
  test("EIP-1193 code 4001 counts too", async () => {
    const { isUserRejection } = await import("@/lib/errors");
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("x"))).toBe(false);
  });
});
