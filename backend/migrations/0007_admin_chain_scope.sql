-- Admin decisions belong to one chain. A database shared by testnet and mainnet must not let the testnet Core Admin
-- appoint General Admins for mainnet, nor a session opened against one chain's API act on the other's.
--
-- Rows written before this migration name no chain. When the database has indexed exactly one chain they belong to
-- it. Otherwise they cannot be attributed: General Admin appointments are dropped (the Core Admin appoints again) and
-- audit entries keep a null chain_id, so they stay in the table but leave every chain's audit view.

alter table admin_operators add column if not exists chain_id integer;
alter table admin_sessions  add column if not exists chain_id integer;
alter table admin_audit     add column if not exists chain_id integer;

update admin_operators set chain_id = (select min(chain_id) from sync_state)
  where chain_id is null and (select count(*) from sync_state) = 1;
update admin_audit set chain_id = (select min(chain_id) from sync_state)
  where chain_id is null and (select count(*) from sync_state) = 1;
delete from admin_operators where chain_id is null;
-- sessions last twelve hours; everyone signs in again
delete from admin_sessions;

alter table admin_operators alter column chain_id set not null;
alter table admin_operators drop constraint if exists admin_operators_pkey;
alter table admin_operators add primary key (chain_id, address);

alter table admin_sessions alter column chain_id set not null;
drop index if exists admin_sessions_address_idx;
create index if not exists admin_sessions_chain_address_idx on admin_sessions (chain_id, address);

create index if not exists admin_audit_chain_idx on admin_audit (chain_id, id desc);
