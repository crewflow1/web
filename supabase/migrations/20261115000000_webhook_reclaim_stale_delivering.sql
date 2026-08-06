-- ── Outbound webhooks: reclaim stranded 'delivering' deliveries ──────────────
--
-- LAUNCH-BLOCKING DATA-LOSS FIX for the (dark) outbound-webhooks feature.
--
-- The problem (before this migration):
--   webhook_claim_deliveries only ever claimed state='pending' rows. The ONLY
--   exits from 'delivering' are webhook_mark_delivered / webhook_mark_failed,
--   both written by the sequential delivery pass AFTER a row's POST resolves. If
--   that pass crashes, is redeployed, or is killed by the cron's maxDuration
--   mid-flight, every row it had already claimed is stranded in 'delivering'
--   FOREVER — there is no lease, no reclaim, no sweeper. Because fan-out uses
--   ON CONFLICT (endpoint_id, event_id) DO NOTHING, a stranded row is never
--   regenerated, so the event is silently, permanently lost. Flipping the
--   feature flag would expose this loss with no further engineering.
--
-- The fix (mirrors server/services/automation-dispatcher.ts's lease-reclaim):
--   A 'delivering' row whose updated_at is older than a lease cutoff is treated
--   as orphaned and becomes claimable again, alongside the existing 'pending'
--   path. updated_at is stamped = now() on every claim (both explicitly here and
--   by the webhook_deliveries_set_updated_at BEFORE UPDATE trigger), so the lease
--   is measured from claim time. An actively-delivering row (updated_at fresh) is
--   never stolen. The attempt counter and MAX_ATTEMPTS ceiling are untouched —
--   attempt is only ever incremented by the outcome writers, so a
--   permanently-failing endpoint is still bounded and never loops forever.
--
-- The function's signature and return shape are IDENTICAL to 20261087000000.

-- Supporting index: the existing due index is partial on state='pending', so it
-- cannot serve the reclaim scan. This partial index keeps the orphan sweep cheap
-- (the set of 'delivering' rows is tiny in steady state).
create index if not exists webhook_deliveries_stale_delivering_idx
  on public.webhook_deliveries (updated_at)
  where state = 'delivering';

create or replace function public.webhook_claim_deliveries(p_limit integer default 50)
returns table (
  delivery_id uuid,
  endpoint_id uuid,
  org_id      uuid,
  url         text,
  secret      text,
  verb        text,
  payload     jsonb,
  attempt     integer,
  event_id    bigint,
  is_ping     boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id
      from public.webhook_deliveries d
      join public.webhook_endpoints e on e.id = d.endpoint_id
     where (
             -- Normal path: a pending delivery whose backoff has elapsed.
             (d.state = 'pending' and d.next_attempt_at <= now())
             -- Reclaim path: a 'delivering' row abandoned by a pass that
             -- crashed / redeployed / timed out mid-flight. The lease is
             -- measured from updated_at, which is stamped at claim time.
             or (d.state = 'delivering'
                 and d.updated_at < now() - interval '5 minutes')
           )
       and e.status <> 'disabled_by_failures'
     order by d.next_attempt_at asc
     limit greatest(p_limit, 1)
     for update of d skip locked
  ),
  claimed as (
    update public.webhook_deliveries d
       set state = 'delivering', updated_at = now()
      from due
     where d.id = due.id
     returning d.id, d.endpoint_id, d.org_id, d.verb, d.payload, d.attempt, d.event_id
  )
  select
    c.id, c.endpoint_id, c.org_id, e.url, e.secret, c.verb, c.payload, c.attempt,
    c.event_id, (c.event_id is null) as is_ping
  from claimed c
  join public.webhook_endpoints e on e.id = c.endpoint_id;
end $$;

revoke all on function public.webhook_claim_deliveries(integer) from public, anon, authenticated;
grant execute on function public.webhook_claim_deliveries(integer) to service_role;
