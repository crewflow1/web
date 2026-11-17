-- ROLLBACK for 20261361000000_privacy_user_erasure (account & data deletion, part 3 of 4).
-- 361 only CREATED five service_role-only functions; nothing pre-existing is replaced.
-- ORDER: after rollback-20261362000000.sql, before rollback-20261360000000.sql.
-- App: #1091 calls these -> roll the APP back first. Production d24295e calls none of them.
-- Then: supabase migration repair --status reverted 20261361000000 --linked
begin;
drop function if exists public.privacy_user_auth_audit_purge(uuid, uuid);
drop function if exists public.privacy_user_identity_scrub(uuid, uuid, text[]);
drop function if exists public.privacy_user_erase_in_org(uuid, uuid, text[], text[], text[], text[], text[]);
drop function if exists public.privacy_user_lockout(uuid);
drop function if exists public._privacy_pii_column_rx();
commit;
