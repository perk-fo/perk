-- Published LP-grant allocation datasets (fetched from campaign.root_uri) and per-wallet Merkle proofs.

create table if not exists grant_datasets (
  chain_id    integer not null,
  meme        text    not null,
  root        text    not null,
  uri         text,
  status      text    not null check (status in ('verified', 'mismatch', 'unreachable')),
  accounts    integer not null default 0,
  error       text,
  checked_at  bigint  not null,
  primary key (chain_id, meme, root)
);

create table if not exists grant_leaves (
  chain_id          integer not null,
  meme              text    not null,
  root              text    not null,
  account           text    not null,
  base_allocation   numeric(78,0) not null,
  invitee_boost     numeric(78,0) not null,
  proof             jsonb   not null,
  primary key (chain_id, meme, root, account)
);
