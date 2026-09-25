# TWAB snapshot design

Why the grant snapshot works the way it does. PRD 6.2 asks for the grant Merkle root to be derived from a
time-weighted average balance (TWAB) of the quote asset over the seven days before graduation, with the dataset
published so anyone can recompute it. The registration-based approach described below was the one adopted; it is
recorded in ADR-008.

## The two quote assets are not equally hard

| Quote asset | Where the holder set comes from | Where historical balances come from | Difficulty |
|-------------|--------------------------------|-------------------------------------|------------|
| ERC-20 such as XDOG | Replay every `Transfer` event since deployment | The same events, accumulated by block, give each address a piecewise balance | Low, and standard |
| Native OKB | **No events.** Any address on the chain may hold it, so the only way is to enumerate state | Every transaction's value, gas deduction and internal call moves a balance, so it takes a per-block trace | High |

Native OKB has two specific obstacles.

1. **Enumerating holders.** Getting every non-zero balance at a given block needs a full state export such as
   `debug_dumpBlock`, which most RPC providers do not expose and which is impractical to run repeatedly at this
   state size. The alternative is a third-party rich list, which makes the result depend on a party nobody can
   audit.
2. **Per-block balance changes.** `debug_traceBlockByNumber` with `prestateTracer` in diff mode yields a balance
   diff per block, but a seven-day window at X Layer's block rate is roughly 200,000 to 600,000 blocks, and it
   would have to run again at every graduation. That needs a self-hosted archive node with the debug API, and each
   run takes hours.

## The approach taken: registration

An address that wants to take part calls `optIn()` once before the snapshot cutoff; any other Perk operation can
register it along the way. That gives:

- A holder set equal to the registered addresses, enumerable on chain, so anyone can recompute it.
- Balances sampled with `eth_getBalance(addr, blockN)` once per stratum of the window, with the TWAB approximated
  from those samples (see "How a snapshot is computed" below for how the sample blocks are drawn). ERC-20 balances
  are still computed exactly from events.
- No need for a debug API: historical `eth_getBalance` is enough, which a paid RPC provides.
- A useful side effect at the product level. Registration is a conversion step in its own right, and it makes a
  wallet's eligibility visible to its owner, which helps with grant discovery.

The cost is that an OKB holder who never registers receives no allocation. That differs from the PRD's wording of
"all quote-asset holders" and was confirmed with the client before being implemented.

## Effort, as estimated at the time

| Approach | Scope | Estimate |
|----------|-------|----------|
| Registration plus sampled TWAB | Indexer (event replay and sampling), Merkle construction, root publication CLI, independent recomputation CLI, published dataset format | About 2 weeks |
| Exact chain-wide native OKB TWAB | A self-hosted archive node, a trace pipeline, state enumeration, and all of the above | About 5 to 6 weeks, plus ongoing node operation |

The Merkle half is identical either way: a leaf is `(account, baseAllocation, inviteeBoost)`, per ADR-007.

## How a snapshot is computed

The rules below are what `snapshot` does and what `verify --recompute` repeats from the inputs a dataset records.

**Before anything is read.** The endpoint must serve the dataset's chain (`eth_chainId`), and the head must be at
least `cutoff + confirmations` (default 64, `--confirmations` / `SNAPSHOT_CONFIRMATIONS`); for a native quote the
seed blocks below must have those confirmations too. The campaign is read at that head, which is recorded as
`inputs.headBlock`.

**Window.** `[cutoff - windowBlocks, cutoff)`, where the cutoff is the campaign's `graduatedAtBlock` and
`windowBlocks` is seven days at the block time measured over the 1,000 blocks before the cutoff.

**ERC-20 quotes.** Every `Transfer` of the quote token is replayed from the token's creation, not from the Perk
deployment: the quote usually existed long before Perk, and a replay that starts later either drives earlier holders
negative or counts them as zero for most of the window. The start comes from `--quote-from-block`, else
`quote-assets.json`, else an `eth_getCode` binary search for the creation block, and is recorded as
`inputs.replayFromBlock`. Whatever its source, the snapshot refuses to run if the token already had code in the block
before the start. After the replay it checks that the replayed balances add up to `totalSupply()` at the cutoff and
that the largest replayed balances equal `balanceOf()` there, which also refuses tokens that mint or rebase without
`Transfer` events.

**Native quotes.** The window is cut into strata of `step` blocks (default 300; the last may be shorter) and one block
is sampled in each. The seed is `keccak256(hash(cutoff+1) ‖ … ‖ hash(cutoff+seedBlocks))` (default 32 blocks,
`--seed-blocks` / `SNAPSHOT_SEED_BLOCKS`): blocks that do not exist when the cutoff is fixed, so whoever completes
graduation cannot know which blocks will count. Stratum `i`, starting at block `s` with length `len`, samples block
`s + uint256(keccak256(abi.encode(bytes32 seed, uint256 i))) mod len`. A balance is weighted by its stratum's length,
and the TWAB is the weighted sum divided by the window length (floor). Every block is equally likely to be sampled,
so holding OKB only on chosen blocks gains nothing in expectation. The scheme (`stratified-blockhash-v1`), the seed
and its blocks are recorded in `inputs.sampling`. Sampling more densely means proportionally more `eth_getBalance`
calls (one per account per stratum), so the default stride is unchanged.

**Exclusions.** No allocation goes to an address that cannot register and activate: every contract address in the
deployment record (the Perk contracts, the v4 PoolManager and PositionManager, Permit2, routers, the quote tokens), the
campaign's hook, the meme and the quote themselves, the zero address and `0xdead`, plus anything passed with
`--exclude` / `SNAPSHOT_EXCLUDE`. They are removed before allocations are computed, so their share goes to real
holders, and the list is published as `dataset.excluded`. People named in the deployment record (deployer, owner,
fee recipient) are not excluded by default.

**Allocations.** `base = floor(basePool * twab / eligibleTwab)`, where `eligibleTwab` (recorded as
`inputs.eligibleTwab`) sums the TWAB of every eligible account, including those later dropped by `minAllocation`;
invitees get a boost of 10% of base, scaled down together if they exceed `referralBudget`.

## Checking a dataset

`verify` checks a dataset during the review window, and `propose` runs the same file checks before printing the
`proposeRoot` command. From the file: the root is rebuilt from the leaves; duplicate accounts (case-insensitive) and
excluded accounts are rejected, using the verifier's own exclusion list as well as the dataset's; the leaf sums must
not exceed the budgets and must equal the declared `totals`; every boost is at most 10% of its base, every base at
least `minAllocation`, and each base follows from its TWAB when `eligibleTwab` is recorded. Against the chain: the
chain id, and the campaign's quote, cutoff, budgets, root and the totals it declared on chain. `propose` prints totals
recomputed from the leaves, never the file's own, and requires the campaign to be waiting for a root.
`verify --recompute` re-runs the snapshot from the recorded inputs and compares the result leaf by leaf.

## RPC settings

The endpoint comes from `RPC_URL`, else an Alchemy URL built from `ALCHEMY_API_KEY`; it is never printed, and error
messages have URLs cut down to their host. `--rpc-url` still works but shows the key to anyone who can list processes,
so the tools warn when it is used.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOG_PAGE` | 1000 | Blocks per `eth_getLogs`. The public X Layer endpoints allow 100; a provider's "range too wide" error also shrinks the page for the rest of the scan |
| `LOG_CONCURRENCY` | 4 | `eth_getLogs` pages in flight |
| `RPC_BATCH_SIZE` | 10 | Calls per JSON-RPC batch; the public X Layer endpoints reject more than 10. 1 disables batching |
| `RPC_CONCURRENCY` | 10 | Balance reads in flight (one pool across all accounts and samples) |
| `RPC_RETRIES` | 6 | Retries per call, with exponential backoff and jitter; reverts and invalid parameters are not retried |
| `RPC_RETRY_DELAY_MS` | 500 | First backoff delay; it doubles per retry, up to 30 s |
| `RPC_TIMEOUT_MS` | 30000 | Per-request timeout |
