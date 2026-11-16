-- ROLLBACK for 20261355000000–20261357000000 (subscription cancellation ledger + state functions).
-- These migrations only CREATE objects; nothing pre-existing is altered. Roll back the APP first
-- (the #1090 code calls these functions), then run this, then:
--   supabase migration repair --status reverted 20261357000000 20261356000000 20261355000000 --linked
-- Drops the cancellation ledger (incl. the tombstones that stop a late webhook reopening a cancelled
-- workspace) — export it first if any rows exist.
begin;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('claim_subscription_cancellation', 'confirm_subscription_cancellation', 'apply_stripe_subscription_state')
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;
drop table if exists public.subscription_cancellations cascade;
commit;
