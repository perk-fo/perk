# backend tests

`bun test` (sync engine, events, migrate, apply) and `PERK_TEST_DATABASE_URL=postgres://localhost:5432/perk_test_api bun test test/api.test.ts` (routes; separate DB so both suites can run side by side) — need a local Postgres with an empty database `perk_test` (`createdb perk_test`), URL from
`PERK_TEST_DATABASE_URL` (default `postgres://localhost:5432/perk_test`). No network: the chain is mocked
(`test/helpers.ts`).

Files (see docs/tasks/T19-indexer-api.md for the required cases):
- `migrate.test.ts` — migrations apply once, are idempotent, schema_migrations recorded.
- `events.test.ts` — encode real event ABIs with viem `encodeEventTopics`/`encodeAbiParameters`, decode back.
- `apply.test.ts` — every handler against a fresh DB.
- `indexer.test.ts` — syncOnce over the mock chain: paging, cursor advance in the same tx, resume after crash,
  new meme inside a window, pool swaps for tracked pools only, reorg rollback, error recorded.
- `api.test.ts` — routes via `app.request()` with seeded rows.
