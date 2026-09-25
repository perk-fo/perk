# Mock market (simulated testnet activity)

> **Everything this directory produces is mock data.** The launches, trades, liquidity and grant participation it
> creates on X Layer testnet are simulated by wallets this project controls, so the app can be explored with a
> realistic, living market. Nothing here is real user activity, and none of it runs on mainnet. Each simulated token
> says so in its description ("Simulated testnet token.").

The simulator launches tokens on a schedule, trades them on their bonding curves, graduates some of them into their
official Uniswap v4 pools, keeps those pools trading, and walks each LP Grant campaign through its full cadence. It
exists so the app is never demonstrated against an empty database.

## Running

```bash
scripts/stack.sh up          # postgres must already be up; starts api + web + the simulator ("driver")
scripts/stack.sh status      # service state, web reachability and indexer lag
scripts/stack.sh logs driver
```

Standalone:

```bash
cd mock
bun run src/main.ts --plan-only   # write the plan, print the schedule, send nothing
bun run src/main.ts --status      # where every token has got to
bun run src/main.ts               # run the scheduler
```

## What it does

The default plan is 42 tokens, each named after an animal with a matching portrait, alternating between native OKB
and the six-decimal `tAAPL` quote so the lists show more than one market. Each token gets its portrait and a metadata
JSON uploaded through the API's media endpoints, exactly as the launch form does, so its `tokenURI` points at real
content pinned on IPFS.

- **The opening batch** (12 tokens) launches four minutes apart and trades briskly (about 18 trades an hour for 45
  minutes), so a fresh deployment has real history within the first hours: the first graduation lands about 45
  minutes in, eight tokens have hatched after about an hour and a half, and their grant campaigns follow.
- **After that**, one token launches every two hours and trades about ten times an hour for two hours.

Trade times are drawn one per slot across each window, so the average rate holds while the spacing stays irregular.
Each trade reads the launch's progress and is sized to track a straight line towards the token's goal, buying when it
is behind and selling a little when it is ahead, which keeps the chart two-sided.

Goals differ, so the market shows launches at every stage:

- **Most graduate** (two in three of the opening batch, about half afterwards). Their goal is the graduation
  threshold. Once it is crossed the simulator graduates the launch, keeps swapping against the resulting v4 pool
  every ten minutes, and runs the grant cadence: build the public snapshot dataset with the indexer CLI, propose the
  root, wait out the public review delay, activate it, have the simulated participants register and provide
  subsidised liquidity, let one of them exit after the minimum LP time, and finalise when the window closes. The cadence comes from the deployment: the simulator reads the vault's
  configuration rather than assuming it.
- **The rest settle on the curve** somewhere between 20% and 92% of their threshold, and keep trading around that
  level every 15 to 35 minutes: buying below it, selling above it, never enough to graduate.

### Grant activation (LP Grant v0.14: co-ownership, one shared inventory)

Each campaign's whole 15% reserve is a single shared inventory: base, invitee boost and inviter credit activations
all draw from it first come first served, and an activation that asks for more than remains reverts
`InsufficientInventory(remaining)`. The invitee boost is also only ever earned *after* base is actually on-chain (10%
of cumulative base activated, capped by the leaf) — it can never be claimed in the same transaction as the base that
earns it. `registerAndActivate` in `src/grants.ts` reflects both rules: it activates a participant's claimable base
(plus any inviter credit already earned, which does not depend on their own base) in one transaction, then re-reads
`grantBreakdown` and activates whatever invitee boost that just unlocked in a second transaction. Before either
transaction it reads `inventoryRemaining(meme)` and shrinks the request to fit, and if the shared inventory still
runs out from under it (a last-moment race) it logs and skips that bundle rather than failing the participant
outright. Exit settlement (`exitGrantPosition`) has no incentive pool in v0.14 — the simulator only ever reads the
first two return values (`quoteToUser`, `memeToUser`) positionally, so it needed no change there.

`inventoryRemaining` is not yet in the generated ABI (`backend/src/generated/abis.ts`) as of this writing, since the
contracts were still being changed to v0.14 when this was written. `src/grants.ts` calls it through a small local ABI
fragment (`LP_GRANT_VAULT_EXTRA_ABI`, same pattern as `MOCK_ERC20_ABI` in `src/actions.ts`), so this works today and
needs no edit once the generated ABI catches up — at that point the local fragment can be dropped in favour of
`lpGrantVaultAbi` directly, but leaving it is also harmless.

## State and restarts

Progress is written to `.run/driver-state.json` after every action, so stopping the process and starting it again
resumes the same schedule without repeating a transaction. The file records the chain id and deployment block it was
planned against (`DriverState.chainId` / `deploymentBlock`, set from `Deployment.blockNumber` in
`contracts/deployments/<chainId>.json`); `initState` in `src/main.ts` compares both against the deployment the
process is currently pointed at and discards the old state — starting a fresh plan and re-funding every wallet —
the moment either one no longer matches, rather than sending transactions against addresses the plan does not match.

**On a fresh deployment, the operator needs to:**

1. Make sure `contracts/deployments/<chainId>.json` has been updated to the new addresses and block number *before*
   the simulator is (re)started — `initState` keys entirely off that file's `blockNumber`/`chainId`, and does nothing
   to fetch a new one itself.
2. Just start (or restart) `bun run src/main.ts`. No manual state deletion is needed: state, dataset and funding
   handling below all reset themselves once the mismatch is detected — this needed no code change, only confirming
   it (see `initState`, `emptyState` in `src/state.ts`).
3. Optionally clear `.run/datasets/*.json`. Dataset files are keyed by the meme's own address
   (`datasetPathFor` in `src/grants.ts`), and a fresh deployment mints different meme addresses, so old files are
   simply orphaned rather than colliding — safe to leave, but harmless to delete for hygiene.
4. Run `bun run src/verify-lifecycle.ts` once (see below) to prove launch → curve → graduation → snapshot →
   `proposeRoot` before trusting the scheduled plan overnight.

**Moving to a server:** copy `.run/driver-state.json` across with the code. Without it the simulator builds a new
plan and launches another set of tokens alongside the ones already on chain. The indexer needs nothing copied: it
replays from the deployment block and rebuilds every chart from the chain itself.

## Wallets and funding

The creator, four traders and three grant participants are derived from `TEST_MNEMONIC`; the deployer funds them and
tops them up each tick. ERC-20 quote assets are minted directly, which the testnet mocks allow. Grant participants
opt in at startup, before anything graduates, because eligibility for a native-OKB quote is measured against the
opt-in registry at the campaign's graduation block.

Watch the deployer's balance: funding, launches, trading and grant activations all come out of it. Activation size is
capped by what each participant can actually match, so it degrades gracefully as balances fall rather than failing.

## Verifying a fresh deployment

```bash
cd mock && bun run src/verify-lifecycle.ts
```

Launches a throwaway token outside the plan, buys it straight to graduation, graduates it, builds the snapshot and
proposes the root: the downstream half of the cadence that the scheduled plan only reaches hours after a launch. Run
it once after deploying, so a broken path shows up in two minutes rather than overnight.
