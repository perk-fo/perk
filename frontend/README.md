# Perk Web (`frontend`)

The Perk web app: Next.js (App Router, TypeScript) with wagmi v2, viem and Tailwind. It uses the `injected()`
connector only. The default chain is X Layer testnet (1952); mainnet (196) is also supported.

## Setup

```bash
cd frontend
cp .env.example .env.local   # set NEXT_PUBLIC_API_URL; RPC overrides are optional
bun install
bun run sync                 # copy deployment addresses and ABIs from contracts/ into src/generated/
bun run dev
bun run build
```

Checks:

```bash
bun x tsc --noEmit -p .
bun test
bun run i18n:check           # key parity across locales, and no hard-coded CJK in components
bun run api:types            # src/lib/api-types.ts must match the backend's wire types
```

Environment variables:

- `NEXT_PUBLIC_API_URL` - the Perk read API. Lists, charts, trades, holders and grant data all come from it.
- `NEXT_PUBLIC_RPC_TESTNET` / `NEXT_PUBLIC_RPC_MAINNET` - optional overrides for the public X Layer RPCs used for
  per-user `eth_call`s. No API keys belong here: anything in a `NEXT_PUBLIC_` variable ships to the browser.
- `NEXT_PUBLIC_TESTNET_SWAP_ROUTER` - the testnet `PoolSwapTest` router used for post-graduation swaps.

`src/generated/deployments.json` and `src/generated/abis.ts` are produced by `bun run sync` and committed. Re-run it
after redeploying or recompiling the contracts. A chain with no `contracts/deployments/<chainId>.json` comes through
as `null`, and the app asks the user to switch networks.

## Pages

The app is organised by intent rather than by contract.

**`/trade`** - discovery and trading. Lists launches from the API with price, progress and market data. A token page
at `/meme/[address]` handles both phases: on the curve it quotes buys and sells through `quoteBuy`/`quoteSell` with
slippage protection; after graduation it swaps against the v4 pool. The page also shows the price chart, recent
trades, holders, claimable quote rewards and creator fees, and the immutable facts of the launch (template, hook,
module bitmap, config hash, pool id).

**`/grant`** - the LP Grant hub. Global opt-in and the invitation flow live here rather than on any one token's page,
because eligibility is measured per wallet, not per launch. `/grant/[address]` covers one campaign: its timeline
(graduation, root proposal, the public review window, activation, decay), the wallet's allocation, activation into a
subsidised position, fee collection, and exit once the minimum LP time has passed. Per-wallet Merkle proofs are
served by the API; users never paste proof JSON.

**`/launch`** - token creation. The form takes a name, symbol, image, description and social links, and uploads the
image and metadata through the API, so no one is asked for a URI. It previews the predicted address, hook, module
bitmap and config hash before signing, and submits only when the config hash still matches the preview. `/create`
redirects here.

**`/me`** - the wallet's own view: holdings, claimable amounts, grant positions, launches and invitations.

## Conventions

Every write simulates first and checks eligibility and network before the wallet opens, then shows preparation,
signing, confirmation and completion. A rejected signature and a mined revert are both failures, not successes.
Custom errors are decoded from the ABI into readable messages in the user's language.

All copy goes through the three-locale system in `src/i18n`; `bun run i18n:check` fails on a missing key or on CJK
hard-coded in a component. The visual system is described in `DESIGN.md`.
