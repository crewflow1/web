-- ROLLBACK for 20261355000000_subscription_cancellations (billing #1090, part 1 of 3).
-- 355 only CREATED objects: the subscription_cancellations ledger, its two indexes and two triggers
-- (tg_set_updated_at + the held-org write guard, both pre-existing functions it merely attaches).
-- Dropping the table removes all of them; nothing pre-existing is altered.
-- ORDER: after rollback-20261356000000.sql (356's functions write this table).
-- App: #1090 reads/writes this table -> roll the APP back first. Production d24295e never references it.
-- Drops the ledger INCLUDING the tombstones that stop a late Stripe webhook reopening a cancelled workspace:
-- export it first if any rows exist.
-- Then: supabase migration repair --status reverted 20261355000000 --linked
begin;
drop table if exists public.subscription_cancellations cascade;
commit;
