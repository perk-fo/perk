import postgres, { type Sql } from "postgres";

/**
 * postgres.js infers JS bigint parameters as int8, which rejects any uint256 above 2^63 before it reaches a
 * numeric(78,0) column. patches/postgres@*.patch (applied by `bun install` via package.json
 * patchedDependencies) makes bigint parameters untyped text instead, so Postgres resolves the type from the
 * column (numeric or bigint) and indexes stay usable. postgres.BigInt additionally parses int8 columns into
 * bigint values; numeric columns stay strings (callers convert with BigInt()).
 */
export type Db = Sql<{ bigint: bigint }>;
/** A transaction handle passed into apply functions; same interface as Sql. */
export type Tx = Db;

/** One pooled connection set per process. */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): Db {
  return postgres<{ bigint: typeof postgres.BigInt }>(databaseUrl, {
    max: opts.max ?? 8,
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
    onnotice: () => {},
  });
}
