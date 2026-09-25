-- Chain logs the indexer could not apply and set aside so that the rest of the chain keeps being indexed. Nothing in
-- the index reflects them. GET /health reports that they exist; an operator reads them here, fixes the cause and
-- rebuilds the index, which empties this table and applies every log again.

create table if not exists quarantined_logs (
  chain_id        integer not null,
  tx_hash         text    not null,
  log_index       integer not null,
  block_number    bigint  not null,
  block_hash      text    not null,
  address         text    not null,
  event_name      text    not null,             -- contract.Event as decoded, e.g. factory.LaunchCreated
  topics          jsonb   not null,
  data            text    not null,
  error           text    not null,             -- error class and short message, no URLs
  attempts        integer not null,             -- failures before it was set aside
  quarantined_at  timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists quarantined_logs_block_idx on quarantined_logs (chain_id, block_number);
