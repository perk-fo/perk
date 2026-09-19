-- Ordinary (non-grant) liquidity positions held through the v4 PositionManager.
--
-- Grant positions live in grant_positions and are owned by the vault on the beneficiary's behalf; these are
-- positions a wallet minted itself, so the two are kept apart and never mixed in a wallet's view.

create table if not exists lp_positions (
  chain_id       integer not null,
  token_id       numeric(78,0) not null,
  owner          text    not null,
  meme           text,                      -- null until the pool is matched to an indexed launch
  pool_id        text,
  liquidity      numeric(78,0) not null default 0,
  created_block  bigint  not null,
  created_at     bigint  not null,
  closed         boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (chain_id, token_id)
);

create index if not exists lp_positions_owner_idx on lp_positions (chain_id, owner) where not closed;
create index if not exists lp_positions_meme_idx  on lp_positions (chain_id, meme)  where not closed;

-- Latest pool price, kept so the web app can size a liquidity position without a storage read: the testnet
-- deployment has no StateView, and every Swap log already carries sqrtPriceX96.
alter table launches add column if not exists last_sqrt_price_x96 numeric(78,0);
