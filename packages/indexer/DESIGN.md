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
- Balances sampled with `eth_getBalance(addr, blockN)` at a fixed interval across the window, with the TWAB
  approximated from those samples. ERC-20 balances are still computed exactly from events. The sampling interval is
  a published template parameter.
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
