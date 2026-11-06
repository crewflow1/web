-- Push / SMS delivery claim — atomic, lease-safe, SKIP LOCKED.
--
-- DEFECT (F-1, double-send). `drainPushQueue` / `drainSmsQueue`
-- (lib/notifications/push.ts, lib/notifications/sms.ts) SELECT the queued-and-due
-- deliveries and then send them, with NO claim step in between. Two overlapping
-- drain ticks (the cron can tick again before a slow send batch finishes, and a
-- redeploy can leave an old invocation draining) therefore read the SAME queued
-- rows and both send them — the user gets the push/SMS twice. This is the exact
-- class the outbound-webhook drain already closed with an atomic claim
-- (`webhook_claim_deliveries`, 20261087 + 20261115 reclaim + 20261176 fairness):
-- flip the row to an in-flight state under `FOR UPDATE ... SKIP LOCKED` BEFORE
-- sending, so overlapping ticks claim disjoint rows and never double-send.
--
-- FIX. Mirror the proven webhook structure for both notification drains:
--   1. Add an in-flight status `'sending'` to each delivery table's status CHECK.
--   2. A claim RPC that, in one statement, selects the claimable set and flips it
--      to `'sending'` (stamping `updated_at` as the lease clock) under
--      `FOR UPDATE OF d SKIP LOCKED`, returning only the rows THIS caller won.
--
-- Claimable set (two paths, same as webhook 20261115):
--   (a) Normal  — status='queued' and scheduled_for <= now().
--   (b) Reclaim — status='sending' whose lease expired (updated_at older than the
--       5-minute window): a tick that crashed / redeployed / timed out mid-send
--       left the row in-flight; without reclaim it would strand forever. The
--       settle step moves a row OUT of 'sending' (to sent/failed/skipped), so a
--       settled row never matches this predicate — the lease only ever covers a
--       genuinely abandoned in-flight row.
--
-- The caller (createAdminClient = service_role) now claims-then-sends: it calls
-- the RPC to win a disjoint batch, sends those, and settles each. Because the
-- claim is atomic and SKIP LOCKED, two concurrent drains get non-overlapping
-- batches — no double-send — and FIFO-by-scheduled_for ordering is preserved.
--
-- Additive / reversible: a new CHECK value + two new functions. No data is
-- rewritten; reverting needs no data change (and no row is left in 'sending' by
-- this migration itself).

-- 1. Widen the status domains to include the in-flight 'sending' state. ----------
alter table public.push_deliveries drop constraint if exists push_deliveries_status_check;
alter table public.push_deliveries
  add constraint push_deliveries_status_check
  check (status = any (array['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]));

alter table public.sms_deliveries drop constraint if exists sms_deliveries_status_check;
alter table public.sms_deliveries
  add constraint sms_deliveries_status_check
  check (status = any (array['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]));

-- 2a. Push claim RPC. ------------------------------------------------------------
create or replace function public.push_claim_deliveries(p_limit integer default 50)
returns table (
  id              uuid,
  notification_id uuid,
  org_id          uuid,
  user_id         uuid,
  category        text,
  retry_count     integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    -- Claimable = queued-and-due OR a stale in-flight row (crashed-tick reclaim).
    -- The lock is taken here on the base table; order FIFO by schedule so the
    -- oldest due delivery is claimed first.
    select d.id
      from public.push_deliveries d
     where (
             (d.status = 'queued' and d.scheduled_for <= now())
             or (d.status = 'sending'
                 and d.updated_at < now() - interval '5 minutes')
           )
     order by d.scheduled_for asc, d.id asc
     limit greatest(p_limit, 1)
     for update of d skip locked
  ),
  claimed as (
    update public.push_deliveries d
       set status = 'sending', updated_at = now()
      from due
     where d.id = due.id
     returning d.id, d.notification_id, d.org_id, d.user_id, d.category, d.retry_count
  )
  select c.id, c.notification_id, c.org_id, c.user_id, c.category, c.retry_count
    from claimed c;
end $$;

-- 2b. SMS claim RPC (identical structure). --------------------------------------
create or replace function public.sms_claim_deliveries(p_limit integer default 50)
returns table (
  id              uuid,
  notification_id uuid,
  org_id          uuid,
  user_id         uuid,
  category        text,
  retry_count     integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id
      from public.sms_deliveries d
     where (
             (d.status = 'queued' and d.scheduled_for <= now())
             or (d.status = 'sending'
                 and d.updated_at < now() - interval '5 minutes')
           )
     order by d.scheduled_for asc, d.id asc
     limit greatest(p_limit, 1)
     for update of d skip locked
  ),
  claimed as (
    update public.sms_deliveries d
       set status = 'sending', updated_at = now()
      from due
     where d.id = due.id
     returning d.id, d.notification_id, d.org_id, d.user_id, d.category, d.retry_count
  )
  select c.id, c.notification_id, c.org_id, c.user_id, c.category, c.retry_count
    from claimed c;
end $$;

-- 3. Grants — service_role only (the drains run as service_role; never client). --
-- These take p_limit (not an org id), so the secdef-org-rpc guard does not apply;
-- they are nonetheless locked to service_role, matching webhook_claim_deliveries.
revoke all on function public.push_claim_deliveries(integer) from public, anon, authenticated;
grant execute on function public.push_claim_deliveries(integer) to service_role;
revoke all on function public.sms_claim_deliveries(integer) from public, anon, authenticated;
grant execute on function public.sms_claim_deliveries(integer) to service_role;
