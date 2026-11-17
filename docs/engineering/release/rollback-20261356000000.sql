-- ROLLBACK for 20261356000000_subscription_cancellation_state_functions (billing #1090, part 2 of 3).
-- 356 only CREATED three service_role-only functions; nothing pre-existing is replaced.
-- ORDER: after rollback-20261357000000.sql (which puts back the 6-argument claim function this drops).
-- App: #1090 calls these -> roll the APP back first. Production d24295e calls none of them.
-- Then: supabase migration repair --status reverted 20261356000000 --linked
begin;
drop function if exists public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer);
drop function if exists public.confirm_subscription_cancellation(uuid, text, text, jsonb, uuid, boolean, text);
drop function if exists public.apply_stripe_subscription_state(uuid, text, text, text, timestamptz);
commit;
