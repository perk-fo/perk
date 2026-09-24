# Perk

Perk is a meme-token launchpad on X Layer built around a Uniswap v4 hook. Anyone can launch a token in one
transaction. It trades on a bonding curve until the curve raises its graduation threshold, then graduates into an
official Uniswap v4 pool that carries the Perk hook, with its initial liquidity locked. Every launch's configuration
is committed on-chain as a `configHash`, so the rules a token was created with can be verified by anyone.

The live deployment is on X Layer testnet (chain 1952): the web app at <https://testnet.perk.fo> and the API at
<https://testnet-api.perk.fo>. Mainnet (chain 196) is not deployed yet.

## Features

- **Launches from templates.** A template is an immutable, registered set of parameters: supply split, curve,
  graduation threshold, fee split, pool settings and which modules are on. Perk Launch enables LP Grant; Standard
  Launch does not. Changing a number means registering a new template, never editing contract code.
- **Bonding curve and graduation.** A constant-product curve with virtual reserves. Graduation is resumable in
  stages, seeds the v4 pool at the curve's final price, locks the initial position permanently and burns any surplus.
- **Perk hook.** Guards the official pool, collects the trading fee on every swap in it and keeps a rate-limited
  reference price.
- **Fees.** 1.00% per trade on the curve and in the pool, split between the creator, the token's holders (paid in
  the pairing asset), liquidity, the Community Treasury and the protocol.
- **LP Grant.** A reserve of the token's supply subsidises liquidity after graduation, allocated by a published
  snapshot with a Merkle root, a public review window, linear decay, a minimum LP time and principal-capped exits.
  Whatever is not used is burned.
- **Referrals.** Permanent on-chain inviter binding that boosts LP Grant allocations.
- **Multiple pairing assets.** Native OKB and whitelisted ERC-20s, including tokenised stocks. Assets may have fewer
  than 18 decimals.
- **Emergency controls.** Pausing covers entry points only (new launches, curve buys, graduation, joining LP Grant);
  selling, withdrawing, claiming and refunds cannot be paused. A graduation stuck before its liquidity is added can
  be rescued into pro-rata refunds after a delay.
- **Indexer and API.** Syncs chain logs into Postgres and serves launches, trades, candles, holders, LP Grant data,
  wallet views and admin functions over REST and WebSocket. Stores token images and metadata.
- **Web app.** Trading, launching, LP Grant, liquidity pools, a wallet view and role-gated admin pages, in English,
  Simplified Chinese and Japanese.

## Repository layout

```
contracts/            Foundry project: every Solidity contract, tests, deployment scripts and deployment records
backend/              Indexer + read API (Bun, Hono, Postgres)
frontend/             Web app (Next.js, wagmi, viem)
packages/indexer      LP Grant snapshot datasets and Merkle tooling (snapshot, verify, proof, propose)
packages/sim          Graduation maths and LP Grant payoff simulations
packages/demo-driver  Testnet content driver: launches, trades to graduation, LP Grant cadence
scripts/              Shell helpers: environment loading, the local stack, testnet role wallets
docker-compose.yml    Postgres plus the API, for a containerised backend
netlify.toml          Web app build configuration
```

`contracts/src/` holds the meme token, the launch factory, the template, module and asset registries, the bonding
curve, the fee router and holder reward distributor, the composable hook, graduation with the initial liquidity
locker, the LP Grant vault, the referral registry and the Community Treasury.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`). Contracts compile with solc 0.8.26.
- The contract libraries are git submodules: clone with `--recurse-submodules`, or run
  `git submodule update --init --recursive`.
- [Bun](https://bun.sh/) for the backend, frontend and packages. Netlify builds the web app on Node 22.
- PostgreSQL 16 for the backend (or Docker, see below).
- An RPC endpoint for X Layer. An Alchemy key covers everything; the public endpoints
  (`https://testrpc.xlayer.tech`, `https://rpc.xlayer.tech`) work too but serve logs at most 100 blocks at a time,
  so set `LOG_PAGE=100` with them.

## Configuration

Environment files are gitignored; only the `*.example` files are committed.

| File | Used by |
|---|---|
| `.env.example` → `.env.dev` | Foundry scripts and fork tests (through `scripts/with-env.sh`), and `scripts/stack.sh`, which passes it on to the API, the web app and the demo driver |
| `backend/.env.example` → `backend/.env` | The API when started directly from `backend/` (variables already set in the environment take precedence) |
| `frontend/.env.example` → `frontend/.env.local` | The web app: the API URL, optional public RPC overrides and the testnet swap router |
| `backend/test/.env.test.example` | The test database URL for backend tests |

Secrets stay server-side: the paid RPC key is only ever given to the API, the driver and scripts. Anything in a
`NEXT_PUBLIC_` variable ships to the browser.

## Running locally

Install dependencies once per package:

```bash
for d in backend frontend packages/indexer packages/demo-driver; do (cd "$d" && bun install); done
```

### The whole stack

`scripts/stack.sh` starts the indexer and API, the web app and the testnet content driver together. It reads
`.env.dev` (or `.env`) from the repository root and requires `ALCHEMY_API_KEY`; set `RPC_URL` (and `LOG_PAGE`) to
use another endpoint.

```bash
cp .env.example .env.dev          # then fill in ALCHEMY_API_KEY
cp frontend/.env.example frontend/.env.local
createdb perk_dev                 # Postgres must already be running
scripts/stack.sh up               # api + web + driver; or name services: scripts/stack.sh up api web
scripts/stack.sh status           # service state, web reachability, indexer lag
scripts/stack.sh logs api
scripts/stack.sh down
```

Defaults: database `postgres://localhost:5432/perk_dev`, API on port 8787, web app on port 3000 (`WEB_PORT`), logs
and process ids under `.run/`. The API applies its database migrations on start. The driver sends testnet
transactions from the deployer key, so leave it out (`scripts/stack.sh up api web`) unless you mean to generate
testnet activity; it refuses to run against mainnet.

### Components on their own

```bash
cd backend && bun run dev         # indexer + API; bun run sync / bun run serve run one role only
cd frontend && bun run dev        # web app, reading NEXT_PUBLIC_API_URL
```

### Backend with Docker

`docker-compose.yml` runs Postgres 16 and the API (built from `backend/Dockerfile`) on port 8787. The web app runs
separately and points `NEXT_PUBLIC_API_URL` at it.

```bash
RPC_URL=https://xlayer-testnet.g.alchemy.com/v2/<key> docker compose up --build
```

Compose forwards only the variables it lists (`RPC_URL`, `CHAIN_ID`, `CONFIRMATIONS`, `CORS_ORIGINS`, the media
settings, `TRUST_PROXY`, `POSTGRES_PASSWORD`). `RPC_URL` is required, and because `LOG_PAGE` is not forwarded, use
an endpoint that serves 1,000-block log ranges. Token media is kept on a named volume, because on-chain token URIs
point at it.

## Tests

```bash
cd contracts && forge build && forge test
scripts/with-env.sh env FOUNDRY_PROFILE=fork forge test --root contracts   # fork tests against X Layer

cd backend && bun run typecheck && bun test && bun run test:api            # needs databases perk_test and perk_test_api
cd frontend && bun x tsc --noEmit -p . && bun test && bun run i18n:check && bun run api:types
cd packages/indexer && bun test
cd packages/sim && bun test
```

Backend tests need a local Postgres with empty databases (`createdb perk_test && createdb perk_test_api`); the chain
is mocked. `i18n:check` enforces key parity across the three locales; `api:types` checks that the web app's API types
match the backend's.

## Deployment

Pushes to `main` deploy the web app and the API.

- **Web app: Netlify.** Configured by `netlify.toml`: the build is scoped to `frontend/`, runs `bun run build` and
  uses the Next.js runtime plugin. `NEXT_PUBLIC_API_URL` is set per deploy context in Netlify. A GitHub webhook
  triggers the build.
- **API: DigitalOcean App Platform.** Built from `backend/Dockerfile` (build context: the repository root) with a
  managed Postgres database attached. Environment variables are set in App Platform. Token images referenced by
  on-chain token URIs must outlive redeploys, so production needs persistent media storage (`MEDIA_DRIVER=pinata`
  or a mounted volume).
- **Contracts: deployed by hand** with Foundry scripts, in sequence:

```bash
cd contracts
../scripts/with-env.sh forge script script/DeployPerk.s.sol                --rpc-url xlayer_testnet --broadcast
../scripts/with-env.sh forge script script/ConfigurePerk.s.sol             --rpc-url xlayer_testnet --broadcast
../scripts/with-env.sh forge script script/ConfigureTestnetTemplates.s.sol --rpc-url xlayer_testnet --broadcast
```

Mainnet uses `--rpc-url xlayer`; `ConfigureTestnetTemplates` refuses to run there. `ConfigurePerk` starts a two-step
ownership transfer to `PROTOCOL_OWNER`, which must then accept ownership on each contract. After a redeploy or a
contract change, regenerate the addresses and ABIs the other parts use and commit them:

```bash
cd contracts && forge build
cd ../backend && bun run sync-abis
cd ../frontend && bun run sync
```

### Contract addresses

`contracts/deployments/<chainId>.json` is the source of truth and is rewritten by `DeployPerk.s.sol`; do not edit
it by hand, and read addresses from it rather than from documentation, which goes stale. Superseded deployments are
kept alongside it under descriptive names.

X Layer testnet is chain **1952** and mainnet is **196**. The testnet has no official Uniswap v4 deployment, so the
testnet stack sits on a third-party PoolManager; everything around it is deployed by this project. Quote assets are
bound to templates, and a quote may have fewer than 18 decimals, so nothing should assume 18.

The testnet adds a fast template (`TEST_FAST_V1`: a scaled-down graduation threshold, a two-hour grant window and a
ten-minute minimum LP hold) and runs with shorter vault and rescue delays, so a full lifecycle can be observed in
hours rather than weeks. Those values live in deployment configuration, never in contract logic: every time window
is passed to the contracts when they are deployed or when a template is registered, and read from there.

| Window | Passed in as | Deploy variable | Default | Testnet |
|--------|--------------|-----------------|---------|---------|
| Grant window (allocation decays to zero over it) | Template parameter | `GRANT_WINDOW_SECONDS` (`TEST_GRANT_WINDOW_SECONDS` for the fast template) | 14 days | 2 hours |
| Minimum LP time before a grant position may exit | Template parameter | `GRANT_MIN_LP_SECONDS` (`TEST_MIN_LP_SECONDS`) | 24 hours | 10 minutes |
| Public review between proposing and activating a grant root | LPGrantVault configuration | `GRANT_ROOT_DELAY_SECONDS` | 1 day | 1 hour |
| Deadline for an active root after graduation | LPGrantVault configuration | `GRANT_ROOT_DEADLINE_SECONDS` | 14 days | 2 hours |
| Delay before a proposed graduation rescue can execute | GraduationManager constructor | `GRAD_RESCUE_DELAY_SECONDS` | 3 days | 1 hour |
| Treasury migration timelock | CommunityTreasury constructor | `TREASURY_TIMELOCK_SECONDS` | 2 days | 2 days |

The template numbers themselves (supply, curve, fees and the two template windows) are built by
`contracts/script/lib/PerkTemplates.sol`, a script library that no deployed contract contains. The one duration in
contract code is a safety floor, not a window: GraduationManager refuses a rescue delay under one hour, so a
deployment can shorten the delay but never make a rescue immediate.

A new quote asset (a newly listed tokenised stock, say) can be listed from the admin pages, one transaction per step,
or with `contracts/script/ConfigureQuoteAsset.s.sol`. Both allow the asset, mark the modules compatible and register
its bound templates; the admin pages also let the Core Admin choose the graduation threshold, while the script
uses the default.

## Admin roles

Three roles run the protocol. Only wallets holding one of them see the admin pages (`/admin`); for everyone else the
address does not exist.

| Role | Where it lives | Appointed by | Does |
|---|---|---|---|
| Core Admin | On-chain: owner of every Perk contract | Contract ownership (one wallet now, a Safe later) | Emergency pause, graduation rescue, quote assets and templates, appointing the other roles |
| Grant Admin | On-chain: the LP Grant vault's `publisher` | The Core Admin (`setPublisher`) | Publishes and cancels LP Grant allocation lists, usually as a bot |
| General Admin | Off-chain: a list the API keeps | The Core Admin, on the admin pages | Hides launches or their media from the site, picks featured launches, sets how quote assets are shown |

The API learns the two on-chain roles from contract events, so it never trusts a configured list. General Admins
sign in by signing a message with their wallet (EIP-4361), and the API checks the wallet's role again on every call.
Moderation only changes what this site shows: a hidden token stays on-chain and tradable, and its page stays
reachable so holders can sell.

## Testnet content

`packages/demo-driver` keeps a testnet deployment populated so the app is never demonstrated against an empty
database: it launches tokens on a schedule, trades each one to graduation, then walks its campaign through the
LP Grant cadence.

## Further documentation

- `frontend/README.md`: web app setup, environment, pages and conventions.
- `frontend/DESIGN.md`: the visual system.
- `contracts/deployments/README.md`: deployment records, environment variables and the ownership handoff.
- `packages/demo-driver/README.md`: the driver's plan, state handling and configuration.
- `packages/indexer/DESIGN.md`: why the LP Grant snapshot works the way it does.
- `backend/test/README.md`: backend test suites and their databases.
