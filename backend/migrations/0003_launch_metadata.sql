-- Token metadata URI + resolved view on launches (image / description / links).

alter table launches add column if not exists token_uri text;
alter table launches add column if not exists metadata jsonb;
alter table launches add column if not exists metadata_status text not null default 'pending';
alter table launches add column if not exists metadata_checked_at bigint;

alter table launches drop constraint if exists launches_metadata_status_check;
alter table launches add constraint launches_metadata_status_check
  check (metadata_status in ('pending', 'ok', 'invalid', 'unreachable'));

create index if not exists launches_metadata_status_idx on launches (chain_id, metadata_status);
