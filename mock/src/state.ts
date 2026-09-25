/**
 * Durable driver state. Written atomically after every action so a restart — or a move to the server — resumes
 * exactly where it left off and never repeats a transaction that already landed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenSpec } from "./plan";

export type Stage =
  | "planned"
  | "launched"
  | "trading"
  /** settled below the threshold (TokenSpec.goalBps < 10_000); keeps trading on the curve around its goal */
  | "holding"
  | "graduated"
  | "root_proposed"
  | "root_active"
  | "grant_open"
  | "finalized";

export interface TokenState {
  index: number;
  stage: Stage;
  meme?: string;
  launchTx?: string;
  graduatedAt?: number;
  /** trade times already executed, by their index in TokenSpec.tradeAt */
  tradesDone: number[];
  /** post-graduation pool swaps, unix seconds of the last one */
  lastPoolSwapAt?: number;
  /** curve trades while holding, unix seconds of the last one */
  lastHoldTradeAt?: number;
  rootProposedAt?: number;
  rootActivatedAt?: number;
  grantEndsAt?: number;
  datasetPath?: string;
  /** where the dataset was published (ipfs://…), proposed with the root */
  datasetUri?: string;
  participantsActivated?: string[];
  exitsDone?: string[];
  /** set when an action failed hard enough to stop retrying this token */
  error?: string;
}

export interface DriverState {
  version: 1;
  chainId: number;
  /** deployment block the plan was built against; a redeploy invalidates the state */
  deploymentBlock: number;
  createdAt: number;
  plan: TokenSpec[];
  tokens: Record<number, TokenState>;
  funded: boolean;
  optedIn: string[];
}

export function emptyState(chainId: number, deploymentBlock: number, plan: TokenSpec[]): DriverState {
  const tokens: Record<number, TokenState> = {};
  for (const s of plan) tokens[s.index] = { index: s.index, stage: "planned", tradesDone: [] };
  return {
    version: 1,
    chainId,
    deploymentBlock,
    createdAt: Math.floor(Date.now() / 1000),
    plan,
    tokens,
    funded: false,
    optedIn: [],
  };
}

export function loadState(path: string): DriverState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as DriverState;
}

export function saveState(path: string, state: DriverState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}
