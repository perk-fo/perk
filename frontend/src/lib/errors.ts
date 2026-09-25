import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Hex,
} from "viem";
import {
  bondingCurveAbi,
  feeRouterAbi,
  graduationManagerAbi,
  holderRewardDistributorAbi,
  launchFactoryAbi,
  lpGrantVaultAbi,
  perkComposableHookV1Abi,
  perkMemeTokenAbi,
  poolSwapTestAbi,
  referralRegistryAbi,
  templateRegistryAbi,
} from "@/generated/abis";
import { formatAmount } from "@/lib/format";
import zhCN from "@/i18n/messages/zh-CN";
import type { TFn } from "@/i18n/provider";

/** Every error fragment from the synced ABIs, used to decode reverts into readable messages. */
const ALL_ABIS = [
  ...launchFactoryAbi,
  ...bondingCurveAbi,
  ...templateRegistryAbi,
  ...perkComposableHookV1Abi,
  ...graduationManagerAbi,
  ...feeRouterAbi,
  ...holderRewardDistributorAbi,
  ...lpGrantVaultAbi,
  ...referralRegistryAbi,
  ...perkMemeTokenAbi,
  ...poolSwapTestAbi,
];

/** zh-CN fallback when no translator is passed (non-React callers). */
const fallbackT: TFn = (key, vars) =>
  (zhCN[key] ?? key).replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars && vars[name] !== undefined ? String(vars[name]) : raw,
  );

/**
 * Errors whose friendly message names one of the revert's arguments: the variables each message interpolates.
 * Meme amounts are read with the meme token's fixed 18 decimals (PerkMemeToken.decimals).
 */
const ERROR_VARS: Record<string, (args: readonly unknown[]) => Record<string, string>> = {
  InsufficientInventory: ([remaining]) => ({
    remaining: typeof remaining === "bigint" ? formatAmount(remaining, 18, { maxFrac: 0 }) : String(remaining),
  }),
};

function formatDecoded(errorName: string, args: readonly unknown[] | undefined, t: TFn): string {
  const vars = args && ERROR_VARS[errorName] ? ERROR_VARS[errorName](args) : undefined;
  const friendly = t(`errors.name.${errorName}`, vars);
  if (friendly !== `errors.name.${errorName}`) return friendly;
  if (!args || args.length === 0) return t("errors.contractRejected", { name: errorName });
  const rendered = args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
  return t("errors.contractRejectedArgs", { name: errorName, args: rendered });
}

/**
 * Turn a wagmi/viem write error into a short, readable message, decoding Perk custom errors. Reverts caught by
 * useTx's simulation (flag `precheck`) are prefixed so the user knows nothing was sent and no gas was spent.
 */
export function decodeErrorMessage(error: unknown, t: TFn = fallbackT): string {
  if (!error) return "";
  if ((error as { precheck?: boolean }).precheck) {
    return t("errors.precheck.simulatedPrefix", { reason: decodeCore(error, t) });
  }
  return decodeCore(error, t);
}

function decodeCore(error: unknown, t: TFn): string {
  if (isUserRejection(error)) return t("errors.userRejected");
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) return t("errors.insufficientFunds");
  // stopped by useTx before the wallet opened (key is an i18n key)
  if (error instanceof Error && error.name === "PrecheckError") return t(error.message);
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const decoded = (revert as { data?: { errorName?: string; args?: readonly unknown[] } }).data;
      if (decoded?.errorName) return formatDecoded(decoded.errorName, decoded.args, t);
      const raw = (revert as unknown as { raw?: Hex }).raw;
      if (raw) {
        try {
          const d = decodeErrorResult({ abi: ALL_ABIS, data: raw });
          return formatDecoded(d.errorName, d.args as readonly unknown[], t);
        } catch {
          // fall through to the generic message
        }
      }
    }
    return error.shortMessage || error.message.split("\n")[0];
  }
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/** The user cancelled in their wallet (wagmi wraps the rejection, so walk the cause chain; 4001 per EIP-1193). */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  if (error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError)) return true;
  let e: unknown = error;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === 4001) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
