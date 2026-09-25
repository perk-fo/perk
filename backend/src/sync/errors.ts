import { BaseError } from "viem";

/**
 * The chain changed while a window was being read (a log's block hash differs from the block's header, or the window
 * no longer sits on the block the cursor points at). Nothing of the window is written; the next pass reads it again,
 * and rebuilds the index first when the cursor block itself was replaced.
 */
export class ChainChangedError extends Error {
  override name = "ChainChangedError";
}

/**
 * The cursor in sync_state is not where this indexer left it: another indexer applied windows meanwhile. The window is
 * not written; the indexer re-reads its state before the next pass.
 */
export class CursorMovedError extends Error {
  override name = "CursorMovedError";
}

/**
 * How a failure while applying a log should be handled.
 *   transient: the RPC or the database was unavailable; retry the window later, never set the log aside.
 *   data:      Postgres refused the values themselves (SQLSTATE class 22 data exception, 23 integrity constraint,
 *              54 program limit). The same log fails the same way every time.
 *   unknown:   anything else. Retried; set aside only after it has failed on its own several times in a row.
 */
export type FailureKind = "transient" | "data" | "unknown";

/** postgres.js errors for a lost or refused connection (not SQLSTATEs). */
const CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** SQLSTATE classes that describe the server's condition rather than the statement. */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "40", "53", "55", "57", "58", "XX"]);
const DATA_SQLSTATE_CLASSES = new Set(["22", "23", "54"]);

function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof ChainChangedError || err instanceof CursorMovedError) return "transient";
  // every viem error is about talking to the chain: the RPC answered badly, late or not at all
  if (err instanceof BaseError) return "transient";
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    if (CONNECTION_CODES.has(code)) return "transient";
    if (isSqlState(code)) {
      const cls = code.slice(0, 2);
      if (DATA_SQLSTATE_CLASSES.has(cls)) return "data";
      if (TRANSIENT_SQLSTATE_CLASSES.has(cls)) return "transient";
    }
  }
  return "unknown";
}
