-- Perk indexer schema. Addresses / hashes are lowercase 0x hex text; uint256 values are numeric(78,0).
-- Every table carries chain_id so one database can hold testnet and mainnet.

create table if not exists sync_state (
  chain_id       integer primary key,
  cursor_block   bigint not null,              -- last block fully applied (all tables consistent up to here)
  cursor_hash    text,                         -- hash of cursor_block, used to detect reorgs
  start_block    bigint not null,              -- deployment block the scan started from
  head_block     bigint,                       -- latest chain head observed
  head_time      bigint,                       -- timestamp of head_block (unix seconds)
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_error     text,
  last_error_at  timestamptz
);

create table if not exists blocks (
  chain_id   integer not null,
  number     bigint  not null,
  hash       text    not null,
  ts         bigint  not null,
  primary key (chain_id, number)
);

create table if not exists quote_assets (
  chain_id  integer not null,
  quote     text    not null,                  -- 0x0 = native OKB
  symbol    text    not null,
  name      text,
  decimals  integer not null,
  kind      smallint,                          -- PerkTypes.AssetInfo kind when known
  allowed   boolean not null default true,
  info      jsonb,
  primary key (chain_id, quote)
);

create table if not exists templates (
  chain_id          integer not null,
  template_id       text    not null,
  status            smallint not null,         -- PerkTypes.RegistryStatus
  registered_block  bigint,
  template          jsonb,                     -- decoded PerkTypes.Template (numbers as strings)
  primary key (chain_id, template_id)
);

create table if not exists launches (
  chain_id            integer not null,
  meme                text    not null,
  launch_id           text    not null,
  creator             text    not null,
  quote               text    not null,
  quote_decimals      integer not null default 18,
  template_id         text    not null,
  config_hash         text    not null,
  hook_version        integer,
  module_bitmap       numeric(78,0) not null default 0,
  lp_grant_enabled    boolean not null default false,
  name                text,
  symbol              text,
  decimals            integer not null default 18,
  total_supply        numeric(78,0),
  status              smallint not null default 1,   -- PerkTypes.LaunchStatus (1 CURVE_ACTIVE, 2 GRADUATION_PENDING, 3 GRADUATED)
  pool_id             text,
  created_block       bigint  not null,
  created_log_index   integer not null,
  created_tx          text    not null,
  created_at          bigint  not null,       -- unix seconds
  -- curve config (CurveInitialized)
  virtual_quote_reserve       numeric(78,0),
  virtual_meme_reserve        numeric(78,0),
  curve_supply                numeric(78,0),
  pool_reserve_supply         numeric(78,0),
  graduation_quote_threshold  numeric(78,0),
  total_fee_bps               integer,
  -- curve running state, folded from CurveBuy / CurveSell
  real_quote          numeric(78,0) not null default 0,
  meme_sold           numeric(78,0) not null default 0,
  curve_graduated     boolean not null default false,
  curve_finalized     boolean not null default false,
  -- graduation (LaunchGraduated)
  graduated_block     bigint,
  graduated_at        bigint,
  meme_to_pool        numeric(78,0),
  quote_to_pool       numeric(78,0),
  pool_liquidity      numeric(78,0),
  meme_is_currency0   boolean,
  -- market cache, maintained on every trade
  last_price_quote    numeric(78,0),
  last_price_meme     numeric(78,0),
  last_price          double precision,        -- quote per meme, decimal-adjusted
  last_trade_at       bigint,
  trade_count         integer not null default 0,
  volume_quote_total  numeric(78,0) not null default 0,
  holder_count        integer not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (chain_id, meme)
);
create index if not exists launches_created_idx on launches (chain_id, created_block desc, created_log_index desc);
create index if not exists launches_creator_idx on launches (chain_id, creator);
create index if not exists launches_status_idx  on launches (chain_id, status);

create table if not exists trades (
  chain_id        integer not null,
  tx_hash         text    not null,
  log_index       integer not null,
  meme            text    not null,
  block_number    bigint  not null,
  ts              bigint  not null,
  side            text    not null check (side in ('buy','sell')),
  source          text    not null check (source in ('curve','pool')),
  wallet          text    not null,            -- buyer/seller on the curve; tx.from for pool swaps
  router          text,                        -- Swap.sender when it differs from the wallet
  quote_amount    numeric(78,0) not null,      -- gross quote moved by the swapper
  meme_amount     numeric(78,0) not null,
  fee             numeric(78,0),               -- curve fee when known
  price_quote     numeric(78,0) not null,      -- price = price_quote / price_meme (raw units)
  price_meme      numeric(78,0) not null,
  price           double precision not null,   -- decimal-adjusted quote per meme, for charts
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists trades_meme_order_idx on trades (chain_id, meme, block_number desc, log_index desc);
create index if not exists trades_meme_ts_idx    on trades (chain_id, meme, ts);
create index if not exists trades_wallet_idx     on trades (chain_id, wallet, block_number desc);

create table if not exists token_transfers (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  meme          text    not null,
  from_addr     text    not null,
  to_addr       text    not null,
  value         numeric(78,0) not null,
  block_number  bigint  not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists token_transfers_meme_block_idx on token_transfers (chain_id, meme, block_number);

create table if not exists holder_balances (
  chain_id       integer not null,
  meme           text    not null,
  holder         text    not null,
  balance        numeric(78,0) not null,
  updated_block  bigint  not null,
  primary key (chain_id, meme, holder)
);
create index if not exists holder_balances_rank_idx on holder_balances (chain_id, meme, balance desc);

-- HolderRewardDistributor.RewardEligibilityUpdated: excluded system addresses (curve, pool, vault, ...)
create table if not exists holder_exclusions (
  chain_id  integer not null,
  meme      text    not null,
  account   text    not null,
  excluded  boolean not null,
  primary key (chain_id, meme, account)
);

create table if not exists fee_events (
  chain_id        integer not null,
  tx_hash         text    not null,
  log_index       integer not null,
  meme            text    not null,
  source          smallint not null,           -- PerkTypes.FeeSource 0 CURVE, 1 HOOK
  amount          numeric(78,0) not null,
  dev_share       numeric(78,0) not null,
  rewards_share   numeric(78,0) not null,
  lp_share        numeric(78,0) not null,
  treasury_share  numeric(78,0) not null,
  protocol_share  numeric(78,0) not null,
  block_number    bigint not null,
  ts              bigint not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists fee_events_meme_idx on fee_events (chain_id, meme, block_number);

create table if not exists reward_claims (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  meme          text    not null,
  account       text    not null,
  kind          text    not null check (kind in ('quote_rewards','dev_fees')),
  amount        numeric(78,0) not null,
  block_number  bigint  not null,
  ts            bigint  not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists reward_claims_account_idx on reward_claims (chain_id, account, block_number desc);

create table if not exists grant_campaigns (
  chain_id                  integer not null,
  meme                      text    not null,
  pool_id                   text,
  status                    smallint not null,       -- IPerkLPGrantVault.CampaignStatus
  reserve                   numeric(78,0) not null default 0,
  base_pool                 numeric(78,0) not null default 0,
  referral_budget           numeric(78,0) not null default 0,
  root                      text,
  root_uri                  text,
  root_total_base           numeric(78,0),
  root_total_invitee_boost  numeric(78,0),
  root_proposed_at          bigint,
  activatable_at            bigint,
  start_time                bigint,
  end_time                  bigint,
  total_activated           numeric(78,0) not null default 0,
  burned                    numeric(78,0) not null default 0,
  excess_to_incentive       numeric(78,0) not null default 0,
  excess_to_treasury        numeric(78,0) not null default 0,
  incentive_swept           numeric(78,0) not null default 0,
  positions_count           integer not null default 0,
  active_positions          integer not null default 0,
  initialized_block         bigint not null,
  initialized_at            bigint not null,
  finalized_at              bigint,
  cancelled_at              bigint,
  updated_at                timestamptz not null default now(),
  primary key (chain_id, meme)
);
create index if not exists grant_campaigns_status_idx on grant_campaigns (chain_id, status);

create table if not exists grant_allocations (
  chain_id          integer not null,
  meme              text    not null,
  account           text    not null,
  base_allocation   numeric(78,0) not null,
  invitee_boost     numeric(78,0) not null,
  registered_block  bigint  not null,
  registered_at     bigint  not null,
  primary key (chain_id, meme, account)
);

create table if not exists grant_positions (
  chain_id                    integer not null,
  position_id                 numeric(78,0) not null,
  meme                        text    not null,
  beneficiary                 text    not null,
  base_activated              numeric(78,0) not null,
  invitee_boost_activated     numeric(78,0) not null,
  inviter_credit_activated    numeric(78,0) not null,
  quote_deposited             numeric(78,0) not null,
  liquidity                   numeric(78,0) not null,
  activated_block             bigint not null,
  activated_at                bigint not null,
  activated_tx                text   not null,
  fees_quote_paid             numeric(78,0) not null default 0,
  fees_meme_burned            numeric(78,0) not null default 0,
  incentive_paid              numeric(78,0) not null default 0,
  exited                      boolean not null default false,
  exited_at                   bigint,
  exited_tx                   text,
  exit_quote_to_user          numeric(78,0),
  exit_excess_quote           numeric(78,0),
  exit_meme_burned            numeric(78,0),
  primary key (chain_id, position_id)
);
create index if not exists grant_positions_meme_idx        on grant_positions (chain_id, meme, activated_block);
create index if not exists grant_positions_beneficiary_idx on grant_positions (chain_id, beneficiary);

create table if not exists referral_credits (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  meme          text    not null,
  inviter       text    not null,
  invitee       text    not null,
  amount        numeric(78,0) not null,
  block_number  bigint  not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists referral_credits_inviter_idx on referral_credits (chain_id, meme, inviter);

create table if not exists referrals (
  chain_id     integer not null,
  invitee      text    not null,
  inviter      text    not null,
  bound_block  bigint  not null,
  primary key (chain_id, invitee)
);
create index if not exists referrals_inviter_idx on referrals (chain_id, inviter);

create table if not exists opt_ins (
  chain_id  integer not null,
  account   text    not null,
  block     bigint  not null,
  primary key (chain_id, account)
);

-- Every applied log, for idempotency checks and reorg rollback bookkeeping.
create table if not exists applied_logs (
  chain_id      integer not null,
  block_number  bigint  not null,
  tx_hash       text    not null,
  log_index     integer not null,
  address       text    not null,
  event_name    text    not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists applied_logs_block_idx on applied_logs (chain_id, block_number);
