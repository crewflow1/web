-- Module 1 (HQ Event Spine) — PR5: The Pulse (the HQ Timeline read-model).
--
-- CEO Directive #005. PR1–PR4 built the WRITE side: the append-only spine
-- (hq_events), the dual-write producers, the generic offset consumer, and the
-- historical backfill that replays legacy rows INTO the spine. This migration
-- lands the FIRST read-model on top of that spine — "The Pulse", the HQ
-- Timeline — and it is a textbook CQRS projection (Engineering Bible Ch.05
-- "Read models / projections").
--
-- THE ONE RULE this enforces structurally: nothing reads hq_events directly. The
-- UI reads THIS table (hq_timeline). The spine is the truth; the timeline is a
-- derived, disposable view of it. Drop it, replay the consumer from 0, and it
-- rebuilds byte-for-byte from history — which is exactly what hq_timeline_reset()
-- does, and exactly why we can afford to denormalise aggressively here (a search
-- vector, a namespace) without ever putting the source of truth at risk.
--
-- STEP 1 + STEP 2 of the directive land together, because in this architecture
-- they ARE one thing. The "timeline consumer" is not a new process — it is one
-- new WHEN branch on the existing hq_consumer_apply seam (PR3), driven by the
-- existing spine-drain cron (which already iterates EVERY registered consumer),
-- writing into the projection table this migration creates. Maximum reuse,
-- minimum complexity, one architecture (CEO decision D1): no second framework,
-- no bespoke timeline drainer, no client-side transaction. Registration at
-- offset 0 means the consumer replays the ENTIRE company history — including the
-- PR4-backfilled legacy events — the moment the drain gate is opened.
--
-- DARK SHIP. Applying this migration changes NO customer-visible behaviour:
--   • the projection table is created EMPTY;
--   • the `timeline` consumer is registered, but the global drain gate
--     (event_spine.consumer_enabled, PR3) is still false in production, so the
--     cron skips it (fail-dark) and nothing is ever written here;
--   • no UI is wired to it yet (that is PR5 STEP 5).
-- The reveal is a runtime operation performed during production verification:
-- flip dual_write_enabled → backfill_enabled → consumer_enabled, in that order,
-- and the timeline fills itself from history with no deploy.
--
-- WHAT THIS CREATES:
--   1. hq_timeline            — the projection table (one row per spine event,
--                               keyed by event_id for idempotency), with a
--                               generated `namespace` (the verb prefix) and a
--                               generated, weighted full-text `search` vector.
--                               RLS:hq (service-role only).
--   2. indexes                — the feed keyset (ts desc, event_id desc), the
--                               category / severity / actor filters, the
--                               correlation-chain and related-object lookups,
--                               and a GIN index for search.
--   3. hq_consumer_apply(...) — REPLACED to add the `timeline` WHEN branch: the
--                               projection WRITER, an idempotent upsert into
--                               hq_timeline (ON CONFLICT (event_id) DO NOTHING).
--                               The selftest branch and the no-op else are
--                               reproduced verbatim — a pure extension of the
--                               PR3 seam, no dynamic SQL.
--   4. hq_timeline_reset()    — the "drop + replay" rebuild: truncate the
--                               projection and rewind the consumer to 0 so the
--                               next drains re-derive it from history.
--   5. registration           — hq_consumer_register('timeline', 0): replay from
--                               the beginning. Idempotent; inert until the drain
--                               gate is opened.
--
-- Hardening is identical to PR1–PR4: every function is SECURITY DEFINER with a
-- pinned empty search_path, EXECUTE revoked from public/anon/authenticated and
-- granted only to service_role; the table is RLS-enabled with ZERO policies, so
-- no JWT client (anon OR authenticated) can read the projection — the HQ page
-- reads it through the service-role admin client behind requireHqPage(). No
-- tenant table is touched: the change is provably additive (P2).

-- ---------------------------------------------------------------------------
-- 1. hq_timeline — the read-model. One row per spine event.
--    event_id (the spine's globally-monotonic id) is the primary key AND the
--    idempotency anchor: at-least-once delivery and replay both re-apply the
--    same event, and ON CONFLICT (event_id) DO NOTHING makes that a no-op. The
--    columns mirror hq_events 1:1 (a faithful, queryable copy) plus two DERIVED
--    columns the read side needs:
--      • namespace — the verb prefix (split_part(verb,'.',1)), the mechanical key
--        the TS category map groups into the CEO's filter chips. Generated, not
--        business logic: the namespace→category mapping lives in TS so adding a
--        category never needs a migration. split_part is IMMUTABLE.
--      • search — a weighted tsvector: identifiers / verb / actor at weight 'A',
--        the payload body at 'D', so an object id ranks above buried JSON text.
--        The two-arg to_tsvector(regconfig, text) with a literal config is
--        IMMUTABLE (the one-arg form is only STABLE, as it reads a GUC), which a
--        STORED generated column requires.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_timeline (
  event_id       bigint      primary key,
  ts             timestamptz not null,
  verb           text        not null,
  namespace      text        generated always as (split_part(verb, '.', 1)) stored,
  severity       text        not null,
  actor_type     text        not null,
  actor_id       text,
  object_type    text        not null,
  object_id      text        not null,
  target_type    text,
  target_id      text,
  correlation_id uuid        not null,
  causation_id   bigint,
  payload        jsonb       not null default '{}'::jsonb,
  visibility     text        not null default 'hq',
  search         tsvector    generated always as (
    setweight(to_tsvector('english',
      verb || ' ' || object_type || ' ' || object_id || ' ' ||
      coalesce(target_type, '') || ' ' || coalesce(target_id, '') || ' ' ||
      coalesce(actor_id, '')), 'A')
    ||
    setweight(to_tsvector('english', coalesce(payload::text, '')), 'D')
  ) stored,
  projected_at   timestamptz not null default now()
);

-- RLS:hq — enabled, ZERO policies. No JWT client can read the projection; the
-- HQ page reads it through the service-role admin client behind requireHqPage().
alter table public.hq_timeline enable row level security;

-- Feed: newest-first keyset pagination. The read API walks
-- WHERE (ts, event_id) < (cursor) ORDER BY ts DESC, event_id DESC.
create index if not exists hq_timeline_feed_idx
  on public.hq_timeline (ts desc, event_id desc);

-- Category chips: namespace = ANY($1), then recency.
create index if not exists hq_timeline_namespace_idx
  on public.hq_timeline (namespace, ts desc);

-- Severity filter / critical canary.
create index if not exists hq_timeline_severity_idx
  on public.hq_timeline (severity, ts desc);

-- Actor-type filter (human / ai_employee / system / tenant).
create index if not exists hq_timeline_actor_idx
  on public.hq_timeline (actor_type, ts desc);

-- Correlation chain — the drawer's "what else happened in this transaction".
create index if not exists hq_timeline_corr_idx
  on public.hq_timeline (correlation_id);

-- Related-object lookup — every event about a given object.
create index if not exists hq_timeline_object_idx
  on public.hq_timeline (object_type, object_id);

-- Full-text search.
create index if not exists hq_timeline_search_idx
  on public.hq_timeline using gin (search);

-- ---------------------------------------------------------------------------
-- 2. hq_consumer_apply — REPLACED to add the `timeline` projection branch.
--    Everything else is reproduced byte-for-byte from PR3: the static CASE
--    dispatch (a deliberate refusal of dynamic SQL — dynamic dispatch in a
--    SECURITY DEFINER function is a privilege-escalation surface), the selftest
--    branch, and the forward-compatible no-op else. The new branch is the
--    projection WRITER (CEO STEP 2): an idempotent upsert keyed by event_id.
--    namespace and search are GENERATED, so they are omitted from the column
--    list and computed by the table; projected_at defaults to now().
-- ---------------------------------------------------------------------------
create or replace function public.hq_consumer_apply(
  p_consumer text,
  p_event    public.hq_events
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  case p_consumer
    when '__spine_selftest__' then
      -- Test-only failure injection, scoped to the selftest consumer so the
      -- generic path carries no magic keys: an event tagged {"__poison__": true}
      -- forces the apply to throw, exercising the dead-letter path.
      if coalesce(p_event.payload ? '__poison__', false) then
        raise exception 'spine selftest poison event %', p_event.id
          using errcode = 'raise_exception';
      end if;
      insert into public.hq_consumer_selftest (consumer, event_id, verb)
      values (p_consumer, p_event.id, p_event.verb)
      on conflict (consumer, event_id) do nothing;
    when 'timeline' then
      -- The Pulse projection: a faithful, idempotent copy of the event. The PK
      -- on event_id makes re-delivery and replay no-ops. Generated columns
      -- (namespace, search) and projected_at are computed/defaulted by the table.
      insert into public.hq_timeline (
        event_id, ts, verb, severity, actor_type, actor_id,
        object_type, object_id, target_type, target_id,
        correlation_id, causation_id, payload, visibility
      )
      values (
        p_event.id, p_event.ts, p_event.verb, p_event.severity,
        p_event.actor_type, p_event.actor_id,
        p_event.object_type, p_event.object_id,
        p_event.target_type, p_event.target_id,
        p_event.correlation_id, p_event.causation_id,
        p_event.payload, p_event.visibility
      )
      on conflict (event_id) do nothing;
    else
      -- Forward-compatible no-op: consume (advance the offset) without projecting.
      null;
  end case;
end;
$$;

revoke all on function public.hq_consumer_apply(text, public.hq_events) from public, anon, authenticated;
grant execute on function public.hq_consumer_apply(text, public.hq_events) to service_role;

-- ---------------------------------------------------------------------------
-- 3. hq_timeline_reset — the "drop + replay" rebuild (Bible Ch.05).
--    Truncates the projection and rewinds the `timeline` consumer to 0 via the
--    PR3 replay engine, so subsequent drains re-derive the whole timeline from
--    history. The projection is disposable BY DESIGN — this is the operation that
--    proves it. Because the apply is idempotent and the offset is the only
--    authority, the rebuild converges regardless of any concurrent drain.
--    SECURITY DEFINER (the function owner has TRUNCATE; the service_role caller
--    does not need it) with a pinned empty search_path.
-- ---------------------------------------------------------------------------
create or replace function public.hq_timeline_reset()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
begin
  truncate table public.hq_timeline;
  v_replay := public.hq_replay_consumer('timeline', 0);
  return jsonb_build_object(
    'reset',      true,
    'projection', 'hq_timeline',
    'replay',     v_replay
  );
end;
$$;

revoke all on function public.hq_timeline_reset() from public, anon, authenticated;
grant execute on function public.hq_timeline_reset() to service_role;

-- ---------------------------------------------------------------------------
-- 4. Read surface (PR5 STEP 3) — purpose-built, service_role-only readers.
--    The projection is RLS:hq with ZERO policies, so rather than lean on
--    service-role bypassing RLS through PostgREST we expose exactly three
--    SECURITY DEFINER read functions and keep "the grant IS the gate" (the same
--    posture as hq_spine_golden_signals / hq_backfill_status). The TS service is
--    a thin, typed wrapper over these — every hq_timeline access is behind a
--    named function granted only to service_role, and the table is never exposed
--    to the PostgREST surface at all.
--
--  (a) hq_timeline_page — the feed. Newest-first KEYSET pagination on
--      (ts, event_id): pass the previous page's last (ts, event_id) as the cursor
--      and walk strictly older. Every filter is optional and AND-combined; NULL
--      means "no constraint". next_cursor is the page's last tuple when the page
--      came back full (there may be more), else NULL (this was the last page).
--      Search runs the stored tsvector against websearch_to_tsquery, so operators
--      get quoted phrases / OR / -negation for free. p_limit is clamped to
--      [1, 200] so a caller can never ask for an unbounded scan.
-- ---------------------------------------------------------------------------
create or replace function public.hq_timeline_page(
  p_limit        integer     default 50,
  p_before_ts    timestamptz default null,
  p_before_id    bigint      default null,
  p_namespaces   text[]      default null,
  p_severities   text[]      default null,
  p_actor_types  text[]      default null,
  p_search       text        default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select greatest(least(coalesce(p_limit, 50), 200), 1) as lim
  ),
  page as (
    select t.event_id, t.ts, t.verb, t.namespace, t.severity,
           t.actor_type, t.actor_id, t.object_type, t.object_id,
           t.target_type, t.target_id, t.correlation_id, t.causation_id,
           t.payload, t.visibility, t.projected_at
      from public.hq_timeline t
     where (p_before_ts is null or p_before_id is null
            or (t.ts, t.event_id) < (p_before_ts, p_before_id))
       and (p_namespaces  is null or t.namespace  = any(p_namespaces))
       and (p_severities  is null or t.severity   = any(p_severities))
       and (p_actor_types is null or t.actor_type = any(p_actor_types))
       and (p_search is null or p_search = ''
            or t.search @@ websearch_to_tsquery('english', p_search))
     order by t.ts desc, t.event_id desc
     limit (select lim from params)
  )
  select jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(to_jsonb(page) order by page.ts desc, page.event_id desc)
         from page), '[]'::jsonb),
    'next_cursor', (
      case when (select count(*) from page) >= (select lim from params)
        then (select jsonb_build_object('ts', page.ts, 'event_id', page.event_id)
                from page order by page.ts asc, page.event_id asc limit 1)
        else null
      end)
  );
$$;

revoke all on function public.hq_timeline_page(integer, timestamptz, bigint, text[], text[], text[], text) from public, anon, authenticated;
grant execute on function public.hq_timeline_page(integer, timestamptz, bigint, text[], text[], text[], text) to service_role;

--  (b) hq_timeline_event — one event plus its FULL correlation chain (every event
--      sharing its correlation_id, in causal id-order) for the drawer's "what else
--      happened in this transaction". Returns NULL when the id is unknown.
create or replace function public.hq_timeline_event(p_event_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select t.event_id, t.ts, t.verb, t.namespace, t.severity,
           t.actor_type, t.actor_id, t.object_type, t.object_id,
           t.target_type, t.target_id, t.correlation_id, t.causation_id,
           t.payload, t.visibility, t.projected_at
      from public.hq_timeline t
     where t.event_id = p_event_id
  )
  select case when not exists (select 1 from target) then null
    else jsonb_build_object(
      'event', (select to_jsonb(target) from target),
      'correlation', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.ts asc, c.event_id asc)
          from (
            select t.event_id, t.ts, t.verb, t.namespace, t.severity,
                   t.actor_type, t.actor_id, t.object_type, t.object_id,
                   t.target_type, t.target_id, t.correlation_id, t.causation_id,
                   t.payload, t.visibility, t.projected_at
              from public.hq_timeline t
             where t.correlation_id = (select correlation_id from target)
          ) c
      ), '[]'::jsonb)
    )
  end;
$$;

revoke all on function public.hq_timeline_event(bigint) from public, anon, authenticated;
grant execute on function public.hq_timeline_event(bigint) to service_role;

--  (c) hq_timeline_facets — counts by namespace / severity / actor_type (+ total)
--      for the filter-chip badges. Bounded aggregates over the projection; the UI
--      calls this once on mount, not per page.
create or replace function public.hq_timeline_facets()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'total', (select count(*) from public.hq_timeline),
    'namespaces', coalesce((
      select jsonb_object_agg(namespace, n)
        from (select namespace, count(*) as n
                from public.hq_timeline group by namespace) s
    ), '{}'::jsonb),
    'severities', coalesce((
      select jsonb_object_agg(severity, n)
        from (select severity, count(*) as n
                from public.hq_timeline group by severity) s
    ), '{}'::jsonb),
    'actor_types', coalesce((
      select jsonb_object_agg(actor_type, n)
        from (select actor_type, count(*) as n
                from public.hq_timeline group by actor_type) s
    ), '{}'::jsonb)
  );
$$;

revoke all on function public.hq_timeline_facets() from public, anon, authenticated;
grant execute on function public.hq_timeline_facets() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Register the `timeline` consumer at offset 0 — replay ALL history.
--    Idempotent (ON CONFLICT (consumer) DO NOTHING inside hq_consumer_register),
--    so a re-run never rewinds a live consumer. Inert until
--    event_spine.consumer_enabled is opened: the drainer fail-darks while the
--    gate is off, so the projection stays EMPTY in production until the
--    deliberate reveal.
-- ---------------------------------------------------------------------------
select public.hq_consumer_register('timeline', 0);
