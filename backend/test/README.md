# backend tests

`bun test` (sync engine, events, migrate, apply) and `PERK_TEST_DATABASE_URL=postgres://localhost:5432/perk_test_api bun test test/api.test.ts` (routes; separate DB so both suites can run side by side) — need a local Postgres with an empty database `perk_test` (`createdb perk_test`), URL from
`PERK_TEST_DATABASE_URL` (default `postgres://localhost:5432/perk_test`). No network: the chain is mocked
(`test/helpers.ts`).

Files (see docs/tasks/T19-indexer-api.md for the required cases):
- `migrate.test.ts` — migrations apply once, are idempotent, schema_migrations recorded.
- `events.test.ts` — encode real event ABIs with viem `encodeEventTopics`/`encodeAbiParameters`, decode back.
- `apply.test.ts` — every handler against a fresh DB.
- `indexer.test.ts` — syncOnce over the mock chain: paging, cursor advance in the same tx, resume after crash,
  new meme inside a window, pool swaps for tracked pools only, reorg rebuild, error recorded.
- `indexer-robustness.test.ts` — strings Postgres cannot hold, logs set aside instead of stopping the indexer, RPC
  failures retried rather than stored as placeholders, no RPC URL in health or logs, reorg rebuilds, a chain that
  changes while a window is read, and one indexer per chain (cursor check and advisory lock).
- `api.test.ts` — routes via `app.request()` with seeded rows.
- `admin.test.ts`, `media.test.ts`, `datasets.test.ts`, `ws.test.ts`, `pacing.test.ts` — admin sign-in and roles,
  uploads and the metadata resolver, grant datasets, WebSocket push, indexer pacing.
- `prices.test.ts` — quote-asset USD prices: source strings and PRICE_SOURCES, the OKX and Stooq answers, the
  background refresh (last good value kept, stale after 15 minutes, never a zero price) and GET /v1/prices. Every
  fetch is mocked.
- `net.test.ts`, `log.test.ts`, `config.test.ts` — address classification and the outbound fetch guard, secret
  redaction, configuration checks. No database.
