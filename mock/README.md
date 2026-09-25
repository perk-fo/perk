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

## State and restarts

Progress is written to `.run/driver-state.json` after every action, so stopping the process and starting it again
resumes the same schedule without repeating a transaction. The file records the deployment block it was planned
against; point the simulator at a different deployment and it starts a fresh plan rather than sending transactions
against addresses the plan does not match.

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
