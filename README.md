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

## Admin roles

Three roles run the protocol, and only wallets holding one of them see the admin pages (`/admin`); for everyone else
the address does not exist.

| Role | Where it lives | Appointed by | Does |
|---|---|---|---|
| Core Admin | On-chain: owner of every Perk contract | Contract ownership (one wallet now, a Safe later) | Emergency pause, graduation rescue, quote assets and templates, appointing the other roles |
| Grant Admin | On-chain: the LP Grant vault's `publisher` | The Core Admin (`setPublisher`) | Publishes and cancels LP Grant allocation lists, usually as a bot |
| General Admin | Off-chain: a list the API keeps | The Core Admin, on the admin page | Hides launches or their media from the site, picks featured launches, sets how quote assets are shown |

The API learns the two on-chain roles from the contracts' events, so it never has to trust a configured list.
General Admins sign in by signing a message with their wallet (EIP-4361); the API checks the wallet's role again on
every call. Moderation only changes what this site shows: a hidden token stays on-chain and tradable, and its page
stays reachable so holders can sell.

A new quote asset (a newly listed tokenised stock, say) can be listed from the admin page, one transaction per step,
or with `contracts/script/ConfigureQuoteAsset.s.sol`. Both register the same templates.

## Testnet content

`packages/demo-driver` keeps a testnet deployment populated so the app is never demonstrated against an empty
database: it launches tokens on a schedule, trades each one to graduation, then walks its campaign through the
grant cadence. See its README for the plan, state handling and configuration.
