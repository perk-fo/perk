-- Admin roles and the off-chain duties of General Admins.
--
-- Core Admin and Grant Admin are on-chain facts: the factory's owner and the grant vault's publisher. The indexer
-- records every change as an event row, so the current holder is the latest row and a chain reorg only has to delete
-- rows above the rollback point. General Admins exist only here; the Core Admin adds and removes them.

create table if not exists chain_role_events (
  chain_id     integer not null,
  role         text    not null check (role in ('core', 'grant')),
  address      text    not null,               -- zero address: the role is vacant
  block_number bigint  not null,
  log_index    integer not null,
  primary key (chain_id, role, block_number, log_index)
);

create table if not exists admin_operators (
  address  text primary key,                   -- a General Admin
  added_by text not null,
  added_at timestamptz not null default now()
);

-- Sign-in: a single-use message to sign, then a session. Only a hash of the session token is stored.
create table if not exists admin_nonces (
  nonce      text primary key,
  address    text not null,
  message    text not null,
  expires_at timestamptz not null
);
create table if not exists admin_sessions (
  token_hash text primary key,
  address    text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_sessions_address_idx on admin_sessions (address);

-- Moderation only changes what this site shows; launches stay on-chain and tradable.
-- hidden: out of every discovery list, media withheld. media_hidden: listed, but without its image, text and links.
create table if not exists launch_moderation (
  chain_id     integer not null,
  meme         text    not null,
  hidden       boolean not null default false,
  media_hidden boolean not null default false,
  reason       text,
  updated_by   text    not null,
  updated_at   timestamptz not null default now(),
  primary key (chain_id, meme)
);

create table if not exists launch_featured (
  chain_id   integer not null,
  meme       text    not null,
  position   integer not null,
  updated_by text    not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, meme)
);

-- How a quote currency is presented. Whether it may be used at all is on-chain (quote_assets.allowed).
create table if not exists quote_asset_display (
  chain_id     integer not null,
  quote        text    not null,
  display_name text,
  icon_url     text,
  category     text check (category in ('native', 'ecosystem', 'rwa', 'stablecoin', 'other')),
  notice       jsonb,                          -- { "en": "...", "zh-CN": "...", "ja": "..." }
  sort_order   integer not null default 0,
  listed       boolean not null default true,
  updated_by   text    not null,
  updated_at   timestamptz not null default now(),
  primary key (chain_id, quote)
);

-- Every off-chain admin change, so the Core Admin can see who did what.
create table if not exists admin_audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  address text not null,
  action  text not null,
  target  text,
  detail  jsonb
);

-- Lets a release rebuild the index when it adds a handler for events that are already behind the cursor.
alter table sync_state add column if not exists index_version integer not null default 1;
