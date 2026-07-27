-- Module 1 (HQ Event Spine) — PR4: Historical Backfill (the replay adapters).
--
-- CEO Directive #003, Module 1. PR1 landed the append-only log + write primitive;
-- PR2 wired the forward producers (dual-write, dark); PR3 landed the consumer side
-- (the offset drainer). PR4 lands the BACKFILL: replay the surviving historical
-- rows of the three legacy logs into canonical hq_events, so the spine's timeline
-- reaches back before the producers existed (Engineering Bible Ch.04 §Backfill +
-- Ch.11 §the legacy→canonical mapping). It ships DARK behind a third infra
-- kill-switch (`event_spine.backfill_enabled`, default false): applying this
-- migration changes NO behaviour and emits NOT ONE event until an operator opts in.
--
-- THE SOURCES (CEO scope) and how each maps (grounded in the REAL producer
-- vocabulary, not a guessed catalogue):
--   • activity_log       — the tenant operational log. Backfill MIRRORS the live
--                          forward producer (PR2's hq_emit_from_activity) EXACTLY:
--                          the same curated six verbs, so history looks precisely
--                          as if the producer had always run. Richer Ch.11 verbs
--                          (job.scheduled/cancelled, invoice.*) are produced only
--                          when the forward producer is expanded — backfill follows.
--   • admin_activity_log — the HQ-operator audit trail. The Ch.11 mapping assumed
--                          org.suspended/org.trial_converted-style action strings
--                          that DO NOT EXIST in production; the real org/billing
--                          lifecycle is Stripe-webhook-shaped. We project ONLY the
--                          unambiguous canonical billing signals and deliberately do
--                          NOT project operator-audit noise (impersonation, notes,
--                          CRM, support, alerts, AI-config, milestones) — the spine
--                          is the business-event heartbeat, not the operator click
--                          trail. The richer Stripe→canonical mapping (subscription
--                          modes, checkout/trial detection) is deferred to a dedicated
--                          billing-producer PR rather than force-fit here (Ch.11:
--                          "rows with no registry verb are NOT projected").
--   • hq_memory_events   — the shared-memory event log. created → memory.asserted;
--                          a status_changed to 'superseded' → memory.superseded.
--                          NOTE memory creation is ALSO logged in admin_activity_log
--                          as `hq_memory.created`; the memory verb is owned HERE
--                          (one canonical source per verb) so the admin adapter does
--                          not project hq_memory.* — otherwise the same logical event
--                          would appear twice and the (backfill_source, backfill_source_id)
--                          key, which dedups only WITHIN a source, could not collapse it.
--
-- THE FOUR INVARIANTS the CEO pinned, and HOW each is guaranteed here:
--   • "Fully idempotent / no duplicate events." Every emitted event carries
--     {backfill_source, backfill_source_id} in its payload, and hq_backfill_emit
--     inserts ONLY where NOT EXISTS a prior event with that key — so a re-run never
--     re-inserts. The spine is append-only and cannot be reset, so this guard (not a
--     cursor alone) is what makes a FULL replay non-duplicating. The key is namespaced
--     (backfill_*, never a bare `source`) so it can NEVER shadow a curated domain
--     field of the same name — e.g. quote.accepted's payload has its own `source`
--     (the acceptance channel), which must survive untouched (forward/backfill parity).
--   • "Replay-safe / restartable at any point." Progress is a durable per-source
--     cursor (created_at, id) advanced in the SAME transaction as the inserts
--     (PR3's transactional-advance pattern): a crash rolls back BOTH, so the next
--     run resumes exactly where it stopped. hq_backfill_reset rewinds the cursor for
--     a from-scratch redrive; the NOT EXISTS guard keeps that duplicate-free.
--   • "Deterministic ordering." Each source is walked in strict (created_at, id)
--     order (id is the row's uuid PK — a stable total order, no ties), bounded above
--     by a CEILING captured once at start so backfill only ever touches HISTORY and
--     never races the forward path.
--   • "Zero customer downtime / dark shipped." The gate defaults false and lives off
--     the operator UI; with it off every entry point is a cheap no-op.
--
-- HISTORICAL ts — WHY A DEDICATED INSERT, NOT hq_emit_event. hq_events is RANGE
-- partitioned by ts and the validated live entry point hq_emit_event has no ts
-- parameter (it always defaults ts = now()), and PR1's core is frozen. A backfilled
-- event must carry its ORIGINAL ts (the legacy created_at) so it lands in the right
-- partition and orders correctly on the timeline — and that determinism is also what
-- makes replay idempotent. So the backfill path is legitimately distinct: it writes
-- through hq_backfill_emit (a SECURITY DEFINER, service_role-only INSERT carrying the
-- original ts + a DETERMINISTIC correlation_id), never through hq_emit_event. The
-- append-only guard blocks UPDATE/DELETE, not INSERT, so this is permitted.
--
-- Every new table is RLS:hq (RLS enabled, ZERO policies → service-role only). Every
-- new function is SECURITY DEFINER with a pinned empty search_path, EXECUTE revoked
-- from public/anon/authenticated and granted only to service_role — the L-4
-- hardening PR1/PR2/PR3 established. There is NO dynamic SQL (a SECURITY DEFINER
-- escalation surface we refuse on the spine): every source read is static. No tenant
-- table is mutated — the legacy rows are READ, never changed (P2) — so the change is
-- provably additive.

-- ---------------------------------------------------------------------------
-- 1. Global backfill kill-switch — seed event_spine.backfill_enabled = false.
--    Idempotent + non-clobbering (only writes when the key is ABSENT), under the
--    non-UI `event_spine` section, exactly like PR2's dual_write_enabled and PR3's
--    consumer_enabled. Flip on later, at runtime, with no deploy.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object('event_spine',
                coalesce(data -> 'event_spine', '{}'::jsonb)
                  || jsonb_build_object('backfill_enabled', false))
where id = 'singleton'
  and (data #> '{event_spine,backfill_enabled}') is null;

-- ---------------------------------------------------------------------------
-- 2. hq_spine_backfill_enabled() — read the global backfill gate (fail-dark).
--    Mirrors hq_spine_dual_write_enabled / hq_spine_consumer_enabled.
-- ---------------------------------------------------------------------------
create or replace function public.hq_spine_backfill_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (data #> '{event_spine,backfill_enabled}')::boolean
       from public.hq_settings
      where id = 'singleton'),
    false
  );
$$;

revoke all on function public.hq_spine_backfill_enabled() from public, anon, authenticated;
grant execute on function public.hq_spine_backfill_enabled() to service_role;

-- ---------------------------------------------------------------------------
-- 3. hq_backfill_state — durable per-source progress (the cursor + ceiling).
--    One row per source. The cursor (cursor_created_at, cursor_id) is the last
--    row consumed in deterministic order; the ceiling (ceiling_*) is captured ONCE
--    when the run starts so backfill only ever touches rows that existed at start.
--    Sentinels: the cursor starts at (-infinity, all-zero uuid) so the row
--    comparison always works without NULL handling. RLS:hq.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_backfill_state (
  source             text        primary key,
  cursor_created_at  timestamptz not null default '-infinity',
  cursor_id          uuid        not null default '00000000-0000-0000-0000-000000000000',
  ceiling_created_at timestamptz,
  ceiling_id         uuid,
  status             text        not null default 'idle'
                     check (status in ('idle', 'running', 'done')),
  rows_seen          bigint      not null default 0,
  rows_emitted       bigint      not null default 0,
  rows_skipped       bigint      not null default 0,
  started_at         timestamptz,
  updated_at         timestamptz not null default now()
);
alter table public.hq_backfill_state enable row level security;

-- ---------------------------------------------------------------------------
-- 4. The idempotency lookup index. The NOT EXISTS guard probes hq_events by the
--    backfill key (payload->>'backfill_source', payload->>'backfill_source_id'); this
--    btree makes that probe a point lookup instead of a partition scan. Non-unique on
--    purpose: uniqueness is enforced by the guard + the single-active lock (PR3's
--    model), and a partitioned UNIQUE index would have to include the partition key
--    (ts), which buys nothing the guard does not already give. Forward (PR2) events
--    carry no backfill_source key, so they index as NULL — cheap and out of the way.
-- ---------------------------------------------------------------------------
create index if not exists hq_events_backfill_source_idx
  on public.hq_events ((payload ->> 'backfill_source'), (payload ->> 'backfill_source_id'));

-- ---------------------------------------------------------------------------
-- 5. hq_backfill_register — ensure a source's state row exists (idempotent).
--    Mirrors hq_consumer_register. The drainer creates the row on demand too, but
--    an explicit register lets an operator pre-create / inspect a source.
-- ---------------------------------------------------------------------------
create or replace function public.hq_backfill_register(p_source text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.hq_backfill_state (source)
  values (p_source)
  on conflict (source) do nothing;
$$;

revoke all on function public.hq_backfill_register(text) from public, anon, authenticated;
grant execute on function public.hq_backfill_register(text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. hq_backfill_emit — the single historical-insert primitive.
--    Writes ONE canonical event carrying its ORIGINAL ts and a DETERMINISTIC
--    correlation_id (md5(source:source_id) — stable across replays), guarded by a
--    NOT EXISTS on the (backfill_source, backfill_source_id) key so a re-run can never
--    duplicate. Returns TRUE iff a row was actually inserted (FALSE = already present,
--    the replay-safe no-op). This is the ONE place the backfill touches hq_events, so
--    the ts / correlation / dedup contract lives in exactly one auditable spot. The
--    provenance key is namespaced (backfill_*) so it can never collide with a curated
--    domain field that happens to be named `source` (quote.accepted's channel).
-- ---------------------------------------------------------------------------
create or replace function public.hq_backfill_emit(
  p_source     text,
  p_source_id  uuid,
  p_created_at timestamptz,
  p_actor_type text,
  p_actor_id   text,
  p_verb       text,
  p_object_type text,
  p_object_id  text,
  p_severity   text,
  p_payload    jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  insert into public.hq_events (
    ts, actor_type, actor_id, verb, object_type, object_id,
    correlation_id, severity, payload, visibility
  )
  select
    p_created_at,
    p_actor_type,
    p_actor_id,
    p_verb,
    p_object_type,
    p_object_id,
    -- Deterministic correlation: the same (source, id) always yields the same
    -- uuid, so a replay threads identically (md5 → 32 hex → uuid).
    md5(p_source || ':' || p_source_id::text)::uuid,
    p_severity,
    -- The idempotency key travels IN the payload under a namespaced pair
    -- (backfill_source, backfill_source_id) merged ON TOP of the curated mapping
    -- payload. Namespacing is load-bearing: jsonb `||` lets the right side win on a
    -- key clash, so a BARE `source` key would clobber a domain field of the same name
    -- (quote.accepted carries its own `source` = the acceptance channel). backfill_*
    -- can never collide, so domain payloads survive byte-for-byte (PR2 parity).
    coalesce(p_payload, '{}'::jsonb)
      || jsonb_build_object('backfill_source', p_source,
                            'backfill_source_id', p_source_id::text),
    'hq'
  where not exists (
    select 1
      from public.hq_events
     where payload ->> 'backfill_source' = p_source
       and payload ->> 'backfill_source_id' = p_source_id::text
  );
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function public.hq_backfill_emit(
  text, uuid, timestamptz, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.hq_backfill_emit(
  text, uuid, timestamptz, text, text, text, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. hq_backfill_drain — replay one source's next batch. ONE transaction.
--    Order of operations (mirrors hq_drain_consumer):
--      a. fail-dark if the global gate is off;
--      b. reject an unknown source (static allow-list — no dynamic SQL);
--      c. ensure + lock the source's state row (FOR UPDATE SKIP LOCKED → a second
--         concurrent run is a clean no-op, never a double-emit);
--      d. once done, stay done (idempotent no-op until an explicit reset);
--      e. on first run, capture the CEILING (max (created_at,id) now) so the walk
--         is bounded to history; an empty source goes straight to 'done';
--      f. walk up to p_max_rows rows in (created_at,id) order, after the cursor and
--         at/under the ceiling: map each to a canonical event (or skip if it has no
--         verb), emit through the guard, and advance the cursor in THIS transaction;
--      g. if the batch did not fill, the source is caught up → 'done';
--      h. persist cursor + counters + status and return a JSON summary.
-- ---------------------------------------------------------------------------
create or replace function public.hq_backfill_drain(
  p_source   text,
  p_max_rows integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur_at   timestamptz;
  v_cur_id   uuid;
  v_ceil_at  timestamptz;
  v_ceil_id  uuid;
  v_status   text;
  v_limit    integer := greatest(p_max_rows, 1);
  v_rec      record;
  v_count    integer := 0;   -- rows walked this batch
  v_emitted  integer := 0;   -- events newly inserted this batch
  v_skipped  integer := 0;   -- rows with no verb, or already present
  v_verb        text;
  v_object_type text;
  v_object_id   text;
  v_actor_type  text;
  v_actor_id    text;
  v_severity    text;
  v_payload     jsonb;
  v_done     boolean := false;
begin
  -- (a) fail-dark.
  if not public.hq_spine_backfill_enabled() then
    return jsonb_build_object('source', p_source, 'skipped', 'backfill_disabled');
  end if;

  -- (b) static allow-list of sources (no dynamic SQL anywhere in the spine).
  if p_source not in ('activity_log', 'admin_activity_log', 'hq_memory_events') then
    return jsonb_build_object('source', p_source, 'skipped', 'unknown_source');
  end if;

  -- (c) ensure the state row exists, then take the single-active-backfiller lock.
  insert into public.hq_backfill_state (source) values (p_source)
    on conflict (source) do nothing;

  select cursor_created_at, cursor_id, ceiling_created_at, ceiling_id, status
    into v_cur_at, v_cur_id, v_ceil_at, v_ceil_id, v_status
    from public.hq_backfill_state
   where source = p_source
   for update skip locked;
  if not found then
    return jsonb_build_object('source', p_source, 'skipped', 'locked');
  end if;

  -- (d) already finished: a no-op until an explicit reset rewinds the cursor.
  if v_status = 'done' then
    return jsonb_build_object('source', p_source, 'status', 'done', 'done', true,
                              'processed', 0, 'emitted', 0, 'skipped', 0);
  end if;

  -- (e) first run: capture the ceiling (the max row that exists NOW) so the walk
  --     only ever touches history. Static per-source select (no dynamic SQL).
  if v_status = 'idle' then
    case p_source
      when 'activity_log' then
        select created_at, id into v_ceil_at, v_ceil_id
          from public.activity_log order by created_at desc, id desc limit 1;
      when 'admin_activity_log' then
        select created_at, id into v_ceil_at, v_ceil_id
          from public.admin_activity_log order by created_at desc, id desc limit 1;
      when 'hq_memory_events' then
        select created_at, id into v_ceil_at, v_ceil_id
          from public.hq_memory_events order by created_at desc, id desc limit 1;
    end case;

    if v_ceil_at is null then
      -- Empty source: nothing to backfill, go straight to done.
      update public.hq_backfill_state
         set status = 'done', started_at = coalesce(started_at, now()), updated_at = now()
       where source = p_source;
      return jsonb_build_object('source', p_source, 'status', 'done', 'done', true,
                                'processed', 0, 'emitted', 0, 'skipped', 0);
    end if;

    update public.hq_backfill_state
       set status = 'running', started_at = now(),
           ceiling_created_at = v_ceil_at, ceiling_id = v_ceil_id, updated_at = now()
     where source = p_source;
  end if;

  -- (f) walk the next batch in strict (created_at, id) order, bounded by the
  --     ceiling, and map+emit each. The three branches differ ONLY in the table
  --     read and the mapping; the emit/cursor/counter tail is identical.
  case p_source

    -- ----- activity_log: MIRROR PR2's hq_emit_from_activity exactly. ----------
    when 'activity_log' then
      for v_rec in
        select * from public.activity_log
         where (created_at, id) > (v_cur_at, v_cur_id)
           and (created_at, id) <= (v_ceil_at, v_ceil_id)
         order by created_at asc, id asc
         limit v_limit
      loop
        v_count := v_count + 1;
        v_verb := case
          when v_rec.action = 'customer.created' then 'customer.created'
          when v_rec.action = 'customer.updated' then 'customer.updated'
          when v_rec.action = 'job.created'      then 'job.created'
          when v_rec.action = 'job.status_changed'
               and v_rec.metadata ->> 'to' = 'completed' then 'job.completed'
          when v_rec.action = 'quote.sent'     then 'quote.sent'
          when v_rec.action = 'quote.accepted' then 'quote.accepted'
          else null
        end;

        if v_verb is null then
          v_skipped := v_skipped + 1;
        else
          -- Curated, NON-PII payload — byte-for-byte PR2's projection.
          v_payload := case v_verb
            when 'customer.updated' then jsonb_build_object('fields', coalesce(v_rec.metadata -> 'fields', '[]'::jsonb))
            when 'job.created'      then jsonb_build_object('status', v_rec.metadata -> 'status')
            when 'job.completed'    then jsonb_build_object('from', v_rec.metadata -> 'from', 'to', v_rec.metadata -> 'to')
            when 'quote.sent'       then jsonb_build_object('number', v_rec.metadata -> 'number', 'total', v_rec.metadata -> 'total')
            when 'quote.accepted'   then jsonb_build_object('number', v_rec.metadata -> 'number', 'total', v_rec.metadata -> 'total', 'source', v_rec.metadata -> 'source')
            else '{}'::jsonb
          end;
          if v_rec.actor_id is not null then
            v_actor_type := 'human'; v_actor_id := v_rec.actor_id::text;
          else
            v_actor_type := 'system'; v_actor_id := 'system';
          end if;

          if public.hq_backfill_emit(
               'activity_log', v_rec.id, v_rec.created_at,
               v_actor_type, v_actor_id, v_verb,
               split_part(v_verb, '.', 1), v_rec.target_id::text, 'info', v_payload)
          then v_emitted := v_emitted + 1;
          else v_skipped := v_skipped + 1;
          end if;
        end if;

        v_cur_at := v_rec.created_at; v_cur_id := v_rec.id;
      end loop;

    -- ----- admin_activity_log: ONLY the unambiguous canonical billing trio. ---
    when 'admin_activity_log' then
      for v_rec in
        select * from public.admin_activity_log
         where (created_at, id) > (v_cur_at, v_cur_id)
           and (created_at, id) <= (v_ceil_at, v_ceil_id)
         order by created_at asc, id asc
         limit v_limit
      loop
        v_count := v_count + 1;
        v_verb := case
          when v_rec.action = 'stripe.invoice_paid'         then 'invoice.paid'
          when v_rec.action = 'stripe.invoice_failed'       then 'invoice.payment_failed'
          when v_rec.action = 'stripe.subscription_deleted' then 'org.churned'
          else null
        end;
        v_severity := case
          when v_verb = 'invoice.paid' then 'success'
          else 'warn'
        end;

        if v_verb is null then
          v_skipped := v_skipped + 1;
        else
          -- Minimal payload (no raw metadata → no PII leak; full fidelity stays in
          -- the untouched admin_activity_log row).
          v_payload := jsonb_build_object('legacy_action', v_rec.action);
          if v_rec.actor_id is not null then
            v_actor_type := 'human'; v_actor_id := v_rec.actor_id::text;
          else
            v_actor_type := 'system';
            v_actor_id := coalesce(nullif(v_rec.actor_email, ''), 'system');
          end if;

          if public.hq_backfill_emit(
               'admin_activity_log', v_rec.id, v_rec.created_at,
               v_actor_type, v_actor_id, v_verb,
               split_part(v_verb, '.', 1), v_rec.target_id::text, v_severity, v_payload)
          then v_emitted := v_emitted + 1;
          else v_skipped := v_skipped + 1;
          end if;
        end if;

        v_cur_at := v_rec.created_at; v_cur_id := v_rec.id;
      end loop;

    -- ----- hq_memory_events: created → asserted; superseded → superseded. -----
    when 'hq_memory_events' then
      for v_rec in
        select * from public.hq_memory_events
         where (created_at, id) > (v_cur_at, v_cur_id)
           and (created_at, id) <= (v_ceil_at, v_ceil_id)
         order by created_at asc, id asc
         limit v_limit
      loop
        v_count := v_count + 1;
        v_verb := case
          when v_rec.event_type = 'created' then 'memory.asserted'
          when v_rec.event_type = 'status_changed'
               and v_rec.detail ->> 'to' = 'superseded' then 'memory.superseded'
          else null
        end;

        if v_verb is null then
          v_skipped := v_skipped + 1;
        else
          v_payload := coalesce(v_rec.detail, '{}'::jsonb)
                       || jsonb_build_object('legacy_event_type', v_rec.event_type);
          if v_rec.ai_employee_id is not null then
            v_actor_type := 'ai_employee'; v_actor_id := v_rec.ai_employee_id::text;
          else
            v_actor_type := 'human';
            v_actor_id := coalesce(nullif(v_rec.actor_email, ''), 'system');
          end if;

          if public.hq_backfill_emit(
               'hq_memory_events', v_rec.id, v_rec.created_at,
               v_actor_type, v_actor_id, v_verb,
               'memory', v_rec.memory_id::text, 'info', v_payload)
          then v_emitted := v_emitted + 1;
          else v_skipped := v_skipped + 1;
          end if;
        end if;

        v_cur_at := v_rec.created_at; v_cur_id := v_rec.id;
      end loop;
  end case;

  -- (g) a batch that did not fill means the source is caught up to the ceiling.
  if v_count < v_limit then
    v_status := 'done';
    v_done := true;
  else
    v_status := 'running';
  end if;

  -- (h) persist cursor + counters + status in THIS transaction (transactional
  --     advance: a crash rolls back the inserts AND the cursor together).
  update public.hq_backfill_state
     set cursor_created_at = v_cur_at,
         cursor_id         = v_cur_id,
         status            = v_status,
         rows_seen         = rows_seen + v_count,
         rows_emitted      = rows_emitted + v_emitted,
         rows_skipped      = rows_skipped + v_skipped,
         updated_at        = now()
   where source = p_source;

  return jsonb_build_object(
    'source',    p_source,
    'status',    v_status,
    'done',      v_done,
    'processed', v_count,
    'emitted',   v_emitted,
    'skipped',   v_skipped,
    'cursor_id', v_cur_id
  );
end;
$$;

revoke all on function public.hq_backfill_drain(text, integer) from public, anon, authenticated;
grant execute on function public.hq_backfill_drain(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. hq_backfill_reset — rewind a source for a from-scratch redrive.
--    Sets the cursor back to the sentinels, clears the ceiling + counters, and
--    returns the source to 'idle' so the next drain recaptures the ceiling and
--    re-walks from the beginning. SAFE because hq_backfill_emit's NOT EXISTS guard
--    means re-walking re-inserts NOTHING that already exists (the append-only spine
--    is never duplicated). Locks the row so a reset can't race a live drain.
-- ---------------------------------------------------------------------------
create or replace function public.hq_backfill_reset(p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen bigint;
begin
  select rows_seen into v_seen
    from public.hq_backfill_state
   where source = p_source
   for update;
  if not found then
    return jsonb_build_object('source', p_source, 'skipped', 'unregistered');
  end if;

  update public.hq_backfill_state
     set cursor_created_at  = '-infinity',
         cursor_id          = '00000000-0000-0000-0000-000000000000',
         ceiling_created_at = null,
         ceiling_id         = null,
         status             = 'idle',
         rows_seen          = 0,
         rows_emitted       = 0,
         rows_skipped       = 0,
         started_at         = null,
         updated_at         = now()
   where source = p_source;

  return jsonb_build_object('source', p_source, 'reset', true, 'previous_rows_seen', v_seen);
end;
$$;

revoke all on function public.hq_backfill_reset(text) from public, anon, authenticated;
grant execute on function public.hq_backfill_reset(text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. hq_backfill_status — the read-side progress signal (Ch.15 style).
--    One cheap aggregate: the enabled gate + every source's cursor/ceiling/status
--    and counters, so the cron run records backfill progress and an operator can
--    see at a glance whether each source is idle / running / done.
-- ---------------------------------------------------------------------------
create or replace function public.hq_backfill_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'enabled',      public.hq_spine_backfill_enabled(),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source',       s.source,
        'status',       s.status,
        'rows_seen',    s.rows_seen,
        'rows_emitted', s.rows_emitted,
        'rows_skipped', s.rows_skipped,
        'started_at',   s.started_at,
        'updated_at',   s.updated_at
      ) order by s.source)
      from public.hq_backfill_state s
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.hq_backfill_status() from public, anon, authenticated;
grant execute on function public.hq_backfill_status() to service_role;
