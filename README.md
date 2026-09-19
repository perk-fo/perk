# Perk

A modular Uniswap v4 hook meme launchpad on X Layer. A token is created against a bonding curve, graduates into a
v4 pool once it reaches its quote threshold, and can then run an LP Grant campaign that subsidises liquidity for
eligible holders.

## Layout

The repository is one workspace with three parts plus shared tooling.

```
contracts/            Foundry project: every Solidity contract and its tests
backend/              Indexer + read API (Bun, Hono, Postgres)
frontend/             Web app (Next.js, wagmi), in Chinese, English and Japanese
packages/sim          Graduation maths and LP Grant return simulation
packages/indexer      Registration-based TWAB snapshots and Merkle dataset tooling
packages/demo-driver  Testnet content driver: launches, trades to graduation, grant cadence
```

`contracts/` holds the meme token, holder rewards, the quote-fee hook, fee routing and the community treasury, the
bonding curve, the template/module/asset registries, the launch factory, graduation with initial-LP locking, the
LP Grant vault and the referral registry. Every number the PRD leaves open is a template parameter rather than a
literal, so changing one is a new template version rather than a code change.

`backend/` syncs logs from the deployment block into Postgres with durable cursors and reorg rollback, and serves
launches, trades, candles, holders, grant data and wallet views over REST and WebSocket. It also stores
content-addressed token images and metadata.

## Getting started

```bash
cp .env.example .env.dev    # ALCHEMY_API_KEY is enough to build and test; add DEPLOYER_PRIVATE_KEY to deploy
cd contracts && forge build && forge test
```

Fork tests and deployment scripts read `.env.dev` through a wrapper:

```bash
scripts/with-env.sh env FOUNDRY_PROFILE=fork forge test --root contracts
```

Backend and frontend each run their own checks:

```bash
cd backend  && bun run typecheck && bun test && bun run test:api
cd frontend && bun x tsc --noEmit -p . && bun test && bun run i18n:check
```

## Running the whole stack

`scripts/stack.sh` starts the indexer and API, the web app, and the testnet content driver together. It reads
`.env.dev`, and the paid RPC key it passes to the server-side processes never reaches the browser.

```bash
scripts/stack.sh up        # api + web + driver
scripts/stack.sh status    # service state, web reachability, indexer lag
scripts/stack.sh logs api
scripts/stack.sh down
```

Postgres must already be running; the default database URL is `postgres://localhost:5432/perk_dev`.

## Deployment

- **Backend** - DigitalOcean App Platform, built from `backend/Dockerfile`, with managed Postgres attached.
  Pushing to `main` deploys automatically.
- **Frontend** - Netlify, configured by `netlify.toml`. Pushing to `main` triggers a build through a GitHub
  webhook.

## Contract addresses

`contracts/deployments/<chainId>.json` is the source of truth and is rewritten by `DeployPerk.s.sol`; do not edit
it by hand, and read addresses from it rather than from documentation, which goes stale. Superseded deployments
are kept alongside it under descriptive names.

X Layer testnet is chain **1952** and mainnet is **196**. The testnet stack sits on top of a third-party Uniswap v4
PoolManager, because the testnet has no official v4 deployment; everything around it is deployed by this project.
Quote assets are bound to templates, and a quote may have fewer than 18 decimals, so nothing should assume 18.

Deployment and configuration run in sequence:

```bash
cd contracts
../scripts/with-env.sh forge script script/DeployPerk.s.sol                --rpc-url xlayer_testnet --broadcast
../scripts/with-env.sh forge script script/ConfigurePerk.s.sol             --rpc-url xlayer_testnet --broadcast
../scripts/with-env.sh forge script script/ConfigureTestnetTemplates.s.sol --rpc-url xlayer_testnet --broadcast
```

The testnet templates use accelerated timings (a short grant window, a ten-minute minimum LP hold, a scaled-down
graduation threshold) so a full lifecycle can be observed in hours rather than weeks. Those live in deployment
configuration, never in contract logic.

## Testnet content

`packages/demo-driver` keeps a testnet deployment populated so the app is never demonstrated against an empty
database: it launches tokens on a schedule, trades each one to graduation, then walks its campaign through the
grant cadence. See its README for the plan, state handling and configuration.
