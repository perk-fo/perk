-- ADR-008 §5 revision: grant meme is no longer burned unconditionally at exit.
-- Meme trading fees are paid to the beneficiary (not burned), and the grant meme tops the user back up to their
-- original quote deposit when the position's quote alone no longer covers it.

alter table grant_positions rename column fees_meme_burned to fees_meme_paid;
alter table grant_positions add column if not exists exit_meme_to_user numeric(78,0);
