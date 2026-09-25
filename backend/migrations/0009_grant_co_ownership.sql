-- LP Grant v0.14: a grant position is co-owned by its beneficiary and the protocol.
--
-- The protocol's share g (protocolShareWad, 1e18 = 100%) is fixed when the position is activated. At exit the
-- beneficiary receives 1 - g of the principal valued at the pool's reference price, quote first; the protocol's
-- quote goes to the Community Treasury and its meme is burned. The incentive pool (exit surplus recycled to other
-- grant positions) no longer exists, and invitee boosts are earned as base allocation is actually activated.
--
-- The incentive columns of 0001 (grant_positions.incentive_paid, grant_campaigns.excess_to_incentive,
-- grant_campaigns.incentive_swept) and the pre-v0.14 exit columns (grant_positions.exit_excess_quote,
-- grant_campaigns.excess_to_treasury) are no longer written or served. They are left in place so that the previous
-- release keeps working against this schema while a deploy rolls out; a later migration can drop them.

-- g per position, from GrantActivated (null only for rows indexed before v0.14, which a rebuild replaces)
alter table grant_positions add column if not exists protocol_share_wad numeric(78,0);
-- the protocol's quote sent to the Community Treasury at exit, from GrantPositionExited
alter table grant_positions add column if not exists exit_quote_to_treasury numeric(78,0);
-- sum of exit_quote_to_treasury over the campaign's positions
alter table grant_campaigns add column if not exists quote_to_treasury numeric(78,0) not null default 0;
-- sum of InviteeBoostEarned amounts for the account (the leaf's invitee_boost is the cap)
alter table grant_allocations add column if not exists invitee_boost_earned numeric(78,0) not null default 0;
