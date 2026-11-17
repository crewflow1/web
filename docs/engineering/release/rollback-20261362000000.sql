-- ROLLBACK for 20261362000000_privacy_verification_and_restore (account & data deletion, part 4 of 4).
-- 362 only CREATED six service_role-only functions; nothing pre-existing is replaced.
-- ORDER: first of the deletion set (before rollback-20261361000000.sql).
-- App: #1091 calls these -> roll the APP back first. Production d24295e calls none of them.
-- Then: supabase migration repair --status reverted 20261362000000 --linked
begin;
drop function if exists public.privacy_tombstone_reapply(jsonb);
drop function if exists public.privacy_tombstone_export(timestamptz);
drop function if exists public._privacy_introspect_buckets();
drop function if exists public._privacy_introspect_delete_guards();
drop function if exists public._privacy_introspect_user_refs();
drop function if exists public.privacy_residue_scan(text[]);
commit;
