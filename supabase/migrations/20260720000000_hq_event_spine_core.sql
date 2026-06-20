-- Module 1 (HQ Event Spine) — PR1: Spine Core.
--
-- CEO Directive #003, Phase 0.1. The single append-only event log that becomes
-- the OS heartbeat (Engineering Bible Ch.03 §03.1 + Ch.04). This migration lands
-- the spine's STORAGE and its WRITE primitive with ZERO user-facing change: no
-- producers are wired yet (table triggers arrive in PR2; consumers in PR3), so it
-- is safe to ship dark.
--
-- What this creates:
--   1. hq_events            — append-only, RANGE-partitioned by ts (monthly),
--                             ordered by a monotonic bigint id (THE total order;
--                             consumers order by id, never ts). RLS:hq.
--   2. hq_create_events_partition(timestamptz) — idempotent partition-creator the
--                             daily cron calls to stay ahead of need. Enables RLS
--                             on each partition it makes (see security note below).
--   3. monthly partitions   — current month + 6 ahead, plus a DEFAULT catch-all so
--                             an insert can never fail on a missing partition.
--   4. append-only guard    — BEFORE UPDATE/DELETE triggers that reject mutation
--                             even under service-role (Ch.16: the spine is
--                             append-only; only partition retention may detach).
--   5. hq_emit_event(...)   — the single validated write entry point. SECURITY
--                             DEFINER, service_role-only (EXECUTE revoked from
--                             PUBLIC). Returns the new bigint id.
--   6. hq_event_consumers   — durable per-consumer offsets (Ch.03 §03.2).
--   7. dead_events          — poison-event side table (Ch.04 failure handling).
--
-- Every table is RLS:hq (RLS enabled, ZERO policies → service-role only; the
-- Supabase service_role has BYPASSRLS, so server code reads/writes while every
-- JWT client — anon/authenticated — is denied). No tenant table is touched, so
-- the change is provably additive (P2).
--
-- SECURITY NOTE — partitions are individually RLS-protected. PostgREST exposes a
-- partition as a queryable table in its own right, and a partitioned PARENT's RLS
-- is NOT inherited by its partitions. So enabling RLS on `hq_events` alone would
-- leave `hq_events_2026_06` etc. readable by anon. We therefore enable RLS on the
-- parent AND on every partition (initial, default, and each one the creator
-- function makes). The integration tier proves both paths are denied to anon.

-- ---------------------------------------------------------------------------
-- 1. hq_events — the append-only spine (partitioned monthly by ts).
-- ---------------------------------------------------------------------------
create table if not exists public.hq_events (
  id             bigint generated always as identity,
  ts             timestamptz not null default now(),
  actor_type     text   not null check (actor_type in ('human','ai_employee','system','tenant')),
  actor_id       text,
  verb           text   not null,
  object_type    text   not null,
  object_id      text   not null,
  target_type    text,
  target_id      text,
  correlation_id uuid   not null,
  causation_id   bigint,
  severity       text   not null default 'info' check (severity in ('info','success','warn','critical')),
  payload        jsonb  not null default '{}'::jsonb,
  visibility     text   not null default 'hq',
  -- The PK must include the partition key (ts). id is globally monotonic via the
  -- parent identity sequence, so (id, ts) is the total order.
  primary key (id, ts)
) partition by range (ts);

create index if not exists hq_events_object_idx   on public.hq_events (object_type, object_id, ts desc);
create index if not exists hq_events_actor_idx    on public.hq_events (actor_type, actor_id, ts desc);
create index if not exists hq_events_corr_idx     on public.hq_events (correlation_id);
create index if not exists hq_events_verb_idx     on public.hq_events (verb, ts desc);
create index if not exists hq_events_severity_idx on public.hq_events (severity, ts desc)
  where severity in ('warn','critical');

-- RLS:hq on the parent — no policies. Querying the parent denies every JWT client.
alter table public.hq_events enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Partition creator — idempotent, UTC-deterministic, RLS-enabling.
--    Called at migration time for the runway and by the daily cron to stay
--    ~2 months ahead of need (Ch.03 "partition-creator cron"). SECURITY DEFINER
--    so the cron's service_role (which lacks CREATE on schema public) can run it.
-- ---------------------------------------------------------------------------
create or replace function public.hq_create_events_partition(p_anchor timestamptz default now())
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Compute the UTC month window deterministically, independent of session TZ.
  v_month_start timestamp   := date_trunc('month', p_anchor at time zone 'UTC');
  v_start       timestamptz := v_month_start at time zone 'UTC';
  v_end         timestamptz := (v_month_start + interval '1 month') at time zone 'UTC';
  v_name        text        := 'hq_events_' || to_char(v_month_start, 'YYYY_MM');
begin
  if to_regclass('public.' || quote_ident(v_name)) is null then
    execute format(
      'create table public.%I partition of public.hq_events for values from (%L) to (%L)',
      v_name, v_start, v_end
    );
    -- Partitions don't inherit the parent's RLS-enabled flag; enable it so a
    -- direct read of this partition is denied to anon/authenticated too.
    execute format('alter table public.%I enable row level security', v_name);
  end if;
  return v_name;
end;
$$;

revoke all on function public.hq_create_events_partition(timestamptz) from public;
grant execute on function public.hq_create_events_partition(timestamptz) to service_role;

-- Pre-create the runway: current month + 6 ahead.
do $$
declare
  i int;
begin
  for i in 0..6 loop
    perform public.hq_create_events_partition(now() + make_interval(months => i));
  end loop;
end $$;

-- DEFAULT catch-all so an insert for an as-yet-uncreated month can never fail
-- (Ch.03 "a default partition catches stragglers safely"). Created after the
-- named runway, while empty, so there is no range to carve out.
create table if not exists public.hq_events_default partition of public.hq_events default;
alter table public.hq_events_default enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Append-only guard — reject UPDATE/DELETE even under service-role.
--    Row-level triggers on the partitioned parent apply to every partition,
--    including ones created later. Partition retention uses DETACH (DDL), not
--    row DELETE, so cold-storage rollover is unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.hq_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_events_no_update on public.hq_events;
create trigger hq_events_no_update
  before update on public.hq_events
  for each row execute function public.hq_events_block_mutation();

drop trigger if exists hq_events_no_delete on public.hq_events;
create trigger hq_events_no_delete
  before delete on public.hq_events
  for each row execute function public.hq_events_block_mutation();

-- ---------------------------------------------------------------------------
-- 4. hq_emit_event — the single validated write entry point.
--    SECURITY DEFINER so a future trigger / non-owner caller can write through
--    it; EXECUTE revoked from PUBLIC and granted only to service_role, so no JWT
--    client can emit an event. The actor_type/severity CHECKs on hq_events reject
--    a malformed envelope (failing the whole transaction, by design — P1). Verb
--    validity is enforced at the producer by the TypeScript registry + a contract
--    test (Ch.04), not by a DB constraint.
-- ---------------------------------------------------------------------------
create or replace function public.hq_emit_event(
  p_actor_type     text,
  p_actor_id       text,
  p_verb           text,
  p_object_type    text,
  p_object_id      text,
  p_correlation_id uuid,
  p_target_type    text    default null,
  p_target_id      text    default null,
  p_causation_id   bigint  default null,
  p_severity       text    default 'info',
  p_payload        jsonb   default '{}'::jsonb,
  p_visibility     text    default 'hq'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.hq_events (
    actor_type, actor_id, verb, object_type, object_id,
    target_type, target_id, correlation_id, causation_id,
    severity, payload, visibility
  ) values (
    p_actor_type, p_actor_id, p_verb, p_object_type, p_object_id,
    p_target_type, p_target_id, p_correlation_id, p_causation_id,
    p_severity, coalesce(p_payload, '{}'::jsonb), p_visibility
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.hq_emit_event(
  text, text, text, text, text, uuid, text, text, bigint, text, jsonb, text
) from public;
grant execute on function public.hq_emit_event(
  text, text, text, text, text, uuid, text, text, bigint, text, jsonb, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 5. hq_event_consumers — durable offsets so projection workers resume exactly
--    where they stopped (Ch.03 §03.2). Written by the drainer in PR3.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_event_consumers (
  consumer      text primary key,
  last_event_id bigint      not null default 0,
  updated_at    timestamptz not null default now()
);
alter table public.hq_event_consumers enable row level security;

-- ---------------------------------------------------------------------------
-- 6. dead_events — poison-event side table. When a consumer fails an event N
--    times it is parked here, the offset advances past it, and a system.alert is
--    raised (Ch.04 failure handling). The unique (consumer, event_id) makes
--    dead-lettering idempotent. Populated by the drainer in PR3.
-- ---------------------------------------------------------------------------
create table if not exists public.dead_events (
  id         bigint generated always as identity primary key,
  consumer   text        not null,
  event_id   bigint      not null,
  event_ts   timestamptz,
  verb       text,
  error      text        not null,
  attempts   integer     not null default 1,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists dead_events_consumer_event_uq
  on public.dead_events (consumer, event_id);
create index if not exists dead_events_created_idx
  on public.dead_events (created_at desc);
alter table public.dead_events enable row level security;
