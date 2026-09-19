# @perk/demo-driver

Keeps a testnet deployment populated: launches tokens on a schedule, trades each one to graduation, and then walks
its campaign through the grant cadence. It exists so the app is never demoed against an empty database.

## Running

```bash
scripts/stack.sh up          # postgres must already be up; starts api + web + driver
scripts/stack.sh status      # service state, web reachability and indexer lag
scripts/stack.sh logs driver
```

Standalone:

```bash
cd packages/demo-driver
bun run src/main.ts --plan-only   # write the plan, print the schedule, send nothing
bun run src/main.ts --status      # where every token has got to
bun run src/main.ts               # run the scheduler
```

## What it does

The default plan is 22 tokens: two launched immediately and twenty released one every three hours, alternating
between the native OKB and the six-decimal `tAAPL` quote so the lists show more than one market. Each token gets a
generated image and metadata JSON uploaded through the API's media endpoints, exactly as the launch form does, so
its `tokenURI` points at real content.

Every token is then traded about ten times an hour for two hours. Trade times are drawn one per slot across the
window, so the average rate holds while the spacing stays irregular. Each trade reads the launch's progress and is
sized to track a straight line to the graduation threshold, buying when it is behind and selling a little when it is
ahead — which is what makes the chart two-sided and still guarantees the token graduates near the end of its window.

Once the threshold is crossed the driver graduates the launch, keeps swapping against the resulting v4 pool every ten
minutes, and starts the grant cadence: build the public snapshot dataset with the indexer CLI, propose the root, wait
out the public review delay, activate it, have the demo participants register and provide subsidised liquidity, let
one of them exit after the minimum LP time, and finalise when the window closes. The cadence itself comes from the
deployment — the driver reads `rootDelaySeconds` off the vault rather than assuming it.

## State and restarts

Progress is written to `.run/driver-state.json` after every action, so stopping the process and starting it again
resumes the same schedule without repeating a transaction. The file records the deployment block it was planned
against; point the driver at a different deployment and it starts a fresh plan rather than sending transactions
against addresses the plan does not match.

**Moving to a server:** copy `.run/driver-state.json` across with the code. Without it the driver will build a new
plan and launch another twenty-two tokens alongside the ones already on chain. The indexer needs nothing copied — it
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
cd packages/demo-driver && bun run src/verify-lifecycle.ts
```

Launches a throwaway token outside the plan, buys it straight to graduation, graduates it, builds the snapshot and
proposes the root — the downstream half of the cadence that the scheduled plan only reaches hours after a launch.
Run it once after deploying, so a broken path shows up in two minutes rather than overnight.

**Stop the driver first.** It signs graduation and root transactions with the deployer key, and so does the driver;
two processes sending from one account collide on nonces. The driver recovers on its next tick, but the check may
not.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `DRIVER_TICK_MS` | 15000 | scheduler period |
| `DRIVER_STATE` | `.run/driver-state.json` | state file |
| `DRIVER_DATASETS` | `.run/datasets` | snapshot datasets |
| `DRIVER_WALLET_TARGET_WEI` | 0.04 OKB | per-wallet top-up target |
| `DRIVER_DEV_BUY_DIVISOR` | 25 | creator dev buy, as a fraction of the launch threshold |
| `DRIVER_POOL_SWAP_INTERVAL_S` | 600 | post-graduation swap period |

The plan's own shape — how many tokens, the three-hour spacing, ten trades an hour, the two-hour window — lives in
`DEFAULTS` in `src/plan.ts`.

It refuses to run against chain 196.
