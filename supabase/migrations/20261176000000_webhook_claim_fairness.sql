-- Outbound-webhook delivery claim — per-org fairness.
--
-- `webhook_claim_deliveries` (20261087000000) claimed the p_limit chronologically
-- earliest due deliveries ACROSS ALL ORGS (order by next_attempt_at asc). One org
-- that queues a large simultaneous burst therefore fills the whole claim batch, and
-- a tail org's later-created (but still due) delivery waits behind the burst for
-- ceil(burst / CLAIM_BATCH) passes. Not permanent starvation — ordering is FIFO by
-- time and retries back off — but a real cross-org QoS weakness, the same class the
-- cron-fairness work (bank-sync / telematics-sync, C70-D/C71-C) already closed for
-- the other per-org drains. The outbound-webhook feature is dark
-- (NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS off), so this hardens it before activation.
--
-- FIX — interleave orgs. Rank each org's due deliveries by recency, then claim in
-- rank order: the oldest delivery of EVERY org first, then each org's second, and so
-- on, with next_attempt_at as the within-rank tiebreak. One org's burst can no longer
-- monopolise a pass; every org with due work gets served each pass, and FIFO within
-- an org (and overall recency across the rank tie) is preserved.
--
-- The locking structure is UNCHANGED from the proven original — the same
-- `... ORDER BY ... LIMIT ... FOR UPDATE OF d SKIP LOCKED` on the base table, so
-- concurrency semantics (no double-claim, lease-safe, skip-locked) are identical;
-- only the ORDER BY key changes (via a windowed CTE that carries no lock itself).
-- Return signature, columns, the disabled-endpoint filter and the grants are all
-- byte-for-byte the same. Additive / reversible (re-instating the old body needs no
-- data change).

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
  with ranked as (
    -- Per-org recency rank over the claimable, non-disabled set. No row lock
    -- here — window functions and FOR UPDATE cannot share a query level, so the
    -- lock is taken in `due` below against the base table.
    --
    -- The claimable set is the SAME two-path set migration 20261115000000
    -- established, preserved verbatim so the stranded-'delivering' reclaim is not
    -- lost:
    --   (a) Normal: a pending delivery whose backoff has elapsed.
    --   (b) Reclaim: a 'delivering' row abandoned by a pass that crashed /
    --       redeployed / timed out mid-flight — lease measured from updated_at
    --       (stamped at claim time). Without this, such rows strand forever.
    select d.id,
           d.next_attempt_at,
           row_number() over (
             partition by d.org_id
             order by d.next_attempt_at asc, d.id asc
           ) as org_rank
      from public.webhook_deliveries d
      join public.webhook_endpoints e on e.id = d.endpoint_id
     where (
             (d.state = 'pending' and d.next_attempt_at <= now())
             or (d.state = 'delivering'
                 and d.updated_at < now() - interval '5 minutes')
           )
       and e.status <> 'disabled_by_failures'
  ),
  due as (
    select d.id
      from public.webhook_deliveries d
      join ranked r on r.id = d.id
     order by r.org_rank asc, r.next_attempt_at asc
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
