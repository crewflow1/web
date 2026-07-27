-- Module 1 (HQ Event Spine) — PR3: Offset Consumer (the drainer).
--
-- CEO Directive #003, Module 1. PR1 landed the append-only log + write primitive;
-- PR2 wired the producers (dual-write, dark). PR3 lands the CONSUMER side: the
-- generic offset drainer, replay, dead-lettering and the golden-signal reads
-- (Engineering Bible Ch.04 "Consuming events" + Ch.15 "Golden signals"). It ships
-- DARK — a second infra kill-switch (`event_spine.consumer_enabled`, default
-- false) means applying this migration changes NO behaviour until an operator
-- opts in, and in prod there are no registered consumers yet, so the cron is a
-- no-op regardless.
--
-- THE CONTRACT (Ch.04). A consumer reads new events since its `last_event_id`,
-- applies them idempotently, and advances the offset *transactionally*. Because
-- supabase-js has no client-side multi-statement transaction and we do not invent
-- one (CEO decision D1), the apply+advance unit lives in SQL — exactly where PR1
-- put the write primitive and PR2 put the producer. The TS layer (cron) only
-- *triggers* a drain; the atomic work is `hq_drain_consumer`.
--
-- THE THREE INVARIANTS the CEO pinned, and HOW each is guaranteed here:
--   • "Fully idempotent."            apply is idempotent (the selftest projection
--                                    upserts ON CONFLICT DO NOTHING — the bible's
--                                    byte-identical oracle) AND the drain itself
--                                    is a no-op when there is nothing new.
--   • "Never process an event twice." strict id-order read (`id > offset ORDER BY
--                                    id`), a single-active-drainer row lock
--                                    (`FOR UPDATE SKIP LOCKED`), and the offset
--                                    advancing in the SAME transaction as the
--                                    apply. A crash rolls back BOTH, so the next
--                                    run resumes exactly where it stopped — no gap,
--                                    no double-apply (Ch.04 failure handling).
--   • "Replay always identical."     the offset is the only state; resetting it
--                                    (`hq_replay_consumer`) and redriving rebuilds
--                                    a deterministic read-model from history.
--
-- We never claim exactly-once (a fiction, P8): at-least-once + idempotent =
-- effectively-once. A redelivery re-applies the same (consumer, event.id) as a
-- no-op.
--
-- WHAT THIS CREATES:
--   1. event_spine.consumer_enabled   — global drain kill-switch (default false),
--                                       seeded only when absent (never clobbers an
--                                       operator value), off the operator UI — the
--                                       same dark-ship mechanism PR2 used.
--   2. hq_spine_consumer_enabled()    — the flag reader (service_role-only).
--   3. hq_consumer_retries            — transient per-(consumer,event) failure
--                                       counter; a poison event is retried here
--                                       until it crosses the dead-letter threshold.
--   4. hq_consumer_selftest           — the engine's conformance read-model: a
--                                       naturally-idempotent projection keyed by
--                                       (consumer,event_id). Dormant in prod (only
--                                       the integration tier registers the
--                                       `__spine_selftest__` consumer); it exists so
--                                       the drain/replay/dead-letter machinery has a
--                                       real read-model to prove against (Ch.04
--                                       "apply the same event twice, assert the
--                                       read-model is identical").
--   5. hq_consumer_register(...)      — idempotent consumer registration (creates
--                                       the offset row). PR5 registers `timeline`.
--   6. hq_consumer_apply(...)         — the per-consumer projection step. Static
--                                       dispatch (no dynamic SQL — a security
--                                       choice): the selftest branch + a
--                                       forward-compatible no-op `else` (a
--                                       registered consumer with no projection yet
--                                       simply advances its offset). PR5 adds the
--                                       `timeline` branch.
--   7. hq_drain_consumer(...)         — the drainer. One transaction: lock the
--                                       consumer, read a bounded batch in id-order,
--                                       apply+advance each, dead-letter a poison
--                                       event after N attempts (+ system.alert),
--                                       return a JSON summary.
--   8. hq_replay_consumer(...)        — the replay engine: reset a consumer's offset
--                                       (default 0 = from the beginning) and clear
--                                       its retry/dead rows so a redrive is clean.
--   9. hq_spine_golden_signals()      — the read-side golden signals (Ch.15):
--                                       throughput, per-consumer lag (max(id) −
--                                       offset — the canary), dead-event count.
--
-- Every new table is RLS:hq (RLS enabled, ZERO policies → service-role only). Every
-- new function is SECURITY DEFINER with a pinned empty search_path, EXECUTE revoked
-- from public/anon/authenticated and granted only to service_role — the L-4
-- hardening PR1/PR2 established (Supabase's default privileges GRANT EXECUTE to the
-- JWT roles by name, so revoking from `public` alone is not enough). No tenant
-- table is touched, so the change is provably additive (P2).

-- ---------------------------------------------------------------------------
-- 1. Global consumer kill-switch — seed event_spine.consumer_enabled = false.
--    Idempotent and non-clobbering: only writes when the key is ABSENT, so a
--    re-run (or an operator who has already toggled it) is never overwritten.
--    Stored under the non-UI `event_spine` section (the settings SECTION_IDS
--    list omits it), so the operator settings page never renders it — an infra
--    switch, not a feature flag.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object('event_spine',
                coalesce(data -> 'event_spine', '{}'::jsonb)
                  || jsonb_build_object('consumer_enabled', false))
where id = 'singleton'
  and (data #> '{event_spine,consumer_enabled}') is null;

-- ---------------------------------------------------------------------------
-- 2. hq_spine_consumer_enabled() — read the global drain gate.
--    Mirrors hq_spine_dual_write_enabled() (PR2). STABLE, SECURITY DEFINER,
--    search_path='' so it reads hq_settings under the owner regardless of the
--    caller's RLS. Defaults FALSE on a missing key (fail-dark).
-- ---------------------------------------------------------------------------
create or replace function public.hq_spine_consumer_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (data #> '{event_spine,consumer_enabled}')::boolean
       from public.hq_settings
      where id = 'singleton'),
    false
  );
$$;

revoke all on function public.hq_spine_consumer_enabled() from public, anon, authenticated;
grant execute on function public.hq_spine_consumer_enabled() to service_role;

-- ---------------------------------------------------------------------------
-- 3. hq_consumer_retries — transient per-event failure counter.
--    A failing apply increments attempts here; once attempts reach the drain's
--    threshold the event is moved to dead_events and this row is removed. A
--    successfully-applied event's row (if any) is also removed. Steady state is
--    EMPTY — a non-empty retry backlog is itself a golden signal.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_consumer_retries (
  consumer        text        not null,
  event_id        bigint      not null,
  attempts        integer     not null default 1,
  last_error      text,
  first_failed_at timestamptz not null default now(),
  last_failed_at  timestamptz not null default now(),
  primary key (consumer, event_id)
);
alter table public.hq_consumer_retries enable row level security;

-- ---------------------------------------------------------------------------
-- 4. hq_consumer_selftest — the engine's conformance read-model.
--    A naturally-idempotent projection (PK on (consumer,event_id), apply is
--    INSERT … ON CONFLICT DO NOTHING) so re-applying an event is a guaranteed
--    no-op — the byte-identical oracle the bible's idempotency test asserts
--    against (Ch.04 §Testing). DORMANT in production: only the integration tier
--    ever registers the `__spine_selftest__` consumer, so this table stays empty
--    in prod. It earns its place by giving the drain/replay/dead-letter machinery
--    a real read-model to prove behaviour against (P: real infra proves behaviour).
-- ---------------------------------------------------------------------------
create table if not exists public.hq_consumer_selftest (
  consumer   text        not null,
  event_id   bigint      not null,
  verb       text        not null,
  applied_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
alter table public.hq_consumer_selftest enable row level security;

-- ---------------------------------------------------------------------------
-- 5. hq_consumer_register — idempotent consumer registration.
--    Creates the offset row (default start 0 = replay from the beginning; pass
--    the current max(id) to begin at "only new events"). hq_event_consumers is
--    the registry: the drainer iterates the rows here, so a consumer that is not
--    registered is simply not drained. PR5 calls this for `timeline`.
-- ---------------------------------------------------------------------------
create or replace function public.hq_consumer_register(
  p_consumer       text,
  p_start_event_id bigint default 0
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.hq_event_consumers (consumer, last_event_id)
  values (p_consumer, greatest(p_start_event_id, 0))
  on conflict (consumer) do nothing;
$$;

revoke all on function public.hq_consumer_register(text, bigint) from public, anon, authenticated;
grant execute on function public.hq_consumer_register(text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 6. hq_consumer_apply — the per-consumer projection step (the seam PR5 extends).
--    STATIC dispatch on the consumer name (deliberately not a dynamic EXECUTE of
--    a stored handler name: dynamic dispatch in a SECURITY DEFINER function is a
--    privilege-escalation surface we refuse on the spine). The `else` branch is
--    the forward-compatible path (Ch.04 "consumers ignore what they don't
--    handle"): a registered consumer with no projection yet just advances its
--    offset. Adding the `timeline` projection in PR5 is one new WHEN branch.
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
    else
      -- Forward-compatible no-op: consume (advance the offset) without projecting.
      null;
  end case;
end;
$$;

revoke all on function public.hq_consumer_apply(text, public.hq_events) from public, anon, authenticated;
grant execute on function public.hq_consumer_apply(text, public.hq_events) to service_role;

-- ---------------------------------------------------------------------------
-- 7. hq_drain_consumer — the drainer. ONE transaction; bounded batch.
--    Order of operations (Ch.04):
--      a. fail-dark if the global gate is off;
--      b. require the consumer to be registered;
--      c. take a single-active-drainer lock on its row (SKIP LOCKED → a second
--         concurrent run is a clean no-op, never a double-apply);
--      d. read up to p_max_events with id > offset, in id-order;
--      e. for each: apply in a savepoint. On success advance the offset and clear
--         any retry row. On failure increment the retry counter; if it has now
--         reached p_max_attempts, dead-letter the event (park it, advance PAST it,
--         raise system.alert_raised best-effort) and continue; otherwise STOP the
--         batch (head-of-line) and retry it next run;
--      f. persist the advanced offset and return a JSON summary.
--    The whole function is one transaction, so a crash anywhere rolls back every
--    offset advance AND every apply together — the resume-exactly guarantee.
-- ---------------------------------------------------------------------------
create or replace function public.hq_drain_consumer(
  p_consumer     text,
  p_max_events   integer default 500,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offset     bigint;
  v_ev         public.hq_events%rowtype;
  v_processed  integer := 0;
  v_dead       integer := 0;
  v_attempts   integer;
  v_stopped    text := null;   -- why the batch stopped early, if it did
begin
  -- (a) fail-dark: with the gate off this is a no-op even if called directly.
  if not public.hq_spine_consumer_enabled() then
    return jsonb_build_object('consumer', p_consumer, 'skipped', 'consumer_disabled');
  end if;

  -- (b) the consumer must be registered (hq_event_consumers is the registry).
  perform 1 from public.hq_event_consumers where consumer = p_consumer;
  if not found then
    return jsonb_build_object('consumer', p_consumer, 'skipped', 'unregistered');
  end if;

  -- (c) single-active-drainer lock. SKIP LOCKED so an overlapping cron run does
  --     not block or double-process — it simply finds the row locked and leaves.
  select last_event_id into v_offset
    from public.hq_event_consumers
   where consumer = p_consumer
   for update skip locked;
  if not found then
    return jsonb_build_object('consumer', p_consumer, 'skipped', 'locked');
  end if;

  -- (d)/(e) drain a bounded batch in strict id-order.
  for v_ev in
    select *
      from public.hq_events
     where id > v_offset
     order by id asc
     limit greatest(p_max_events, 1)
  loop
    begin
      perform public.hq_consumer_apply(p_consumer, v_ev);
      -- success: advance past this event and forget any prior failure.
      v_offset := v_ev.id;
      v_processed := v_processed + 1;
      delete from public.hq_consumer_retries
        where consumer = p_consumer and event_id = v_ev.id;
    exception when others then
      -- The savepoint rolled back this event's partial apply. Record the failure
      -- (this runs in the restored context, so it persists).
      insert into public.hq_consumer_retries (consumer, event_id, attempts, last_error)
      values (p_consumer, v_ev.id, 1, left(sqlerrm, 2000))
      on conflict (consumer, event_id) do update
        set attempts       = public.hq_consumer_retries.attempts + 1,
            last_error     = excluded.last_error,
            last_failed_at = now();

      select attempts into v_attempts
        from public.hq_consumer_retries
       where consumer = p_consumer and event_id = v_ev.id;

      if v_attempts >= greatest(p_max_attempts, 1) then
        -- Poison event: park it, advance PAST it (one bad event never blocks the
        -- stream — Ch.04), and clear the retry row.
        insert into public.dead_events (consumer, event_id, event_ts, verb, error, attempts, payload)
        values (p_consumer, v_ev.id, v_ev.ts, v_ev.verb, left(sqlerrm, 2000), v_attempts, v_ev.payload)
        on conflict (consumer, event_id) do nothing;
        delete from public.hq_consumer_retries
          where consumer = p_consumer and event_id = v_ev.id;
        v_offset := v_ev.id;
        v_dead := v_dead + 1;

        -- Raise a critical alert through the validated entry point — best-effort:
        -- a failed alert must never abort the drain (and roll back its progress).
        begin
          perform public.hq_emit_event(
            p_actor_type     => 'system',
            p_actor_id       => 'spine-drainer',
            p_verb           => 'system.alert_raised',
            p_object_type    => 'consumer',
            p_object_id      => p_consumer,
            p_correlation_id => gen_random_uuid(),
            p_severity       => 'critical',
            p_payload        => jsonb_build_object(
                                  'reason', 'poison_event',
                                  'consumer', p_consumer,
                                  'event_id', v_ev.id,
                                  'verb', v_ev.verb,
                                  'attempts', v_attempts)
          );
        exception when others then
          null;
        end;
        -- continue to the next event
      else
        -- Not yet poison: leave the offset before this event and stop the batch.
        -- It will be retried on the next run (the cron interval is the backoff).
        v_stopped := 'retry_pending';
        exit;
      end if;
    end;
  end loop;

  -- (f) persist the advanced offset (we still hold the row lock) and report.
  update public.hq_event_consumers
     set last_event_id = v_offset, updated_at = now()
   where consumer = p_consumer;

  return jsonb_build_object(
    'consumer',      p_consumer,
    'processed',     v_processed,
    'dead_lettered', v_dead,
    'new_offset',    v_offset,
    'stopped',       v_stopped,
    'lag',           greatest((select coalesce(max(id), 0) from public.hq_events) - v_offset, 0)
  );
end;
$$;

revoke all on function public.hq_drain_consumer(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hq_drain_consumer(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. hq_replay_consumer — the replay engine.
--    Sets the offset back (default 0 = replay the whole history) and clears this
--    consumer's retry + dead rows so the redrive starts clean. The projection
--    "drop" is the caller's deliberate act for a from-scratch rebuild (the bible's
--    "drop + replay"); for a naturally-idempotent projection the redrive simply
--    re-converges. Locks the consumer row so a replay can't race a live drain.
-- ---------------------------------------------------------------------------
create or replace function public.hq_replay_consumer(
  p_consumer     text,
  p_to_event_id  bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev bigint;
begin
  select last_event_id into v_prev
    from public.hq_event_consumers
   where consumer = p_consumer
   for update;
  if not found then
    return jsonb_build_object('consumer', p_consumer, 'skipped', 'unregistered');
  end if;

  update public.hq_event_consumers
     set last_event_id = greatest(p_to_event_id, 0), updated_at = now()
   where consumer = p_consumer;

  -- Clear transient failure state at or beyond the replay point so it is re-derived.
  delete from public.hq_consumer_retries
    where consumer = p_consumer and event_id > greatest(p_to_event_id, 0);
  delete from public.dead_events
    where consumer = p_consumer and event_id > greatest(p_to_event_id, 0);

  return jsonb_build_object(
    'consumer',       p_consumer,
    'previous_offset', v_prev,
    'new_offset',     greatest(p_to_event_id, 0)
  );
end;
$$;

revoke all on function public.hq_replay_consumer(text, bigint) from public, anon, authenticated;
grant execute on function public.hq_replay_consumer(text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 9. hq_spine_golden_signals — the read-side golden signals (Ch.15).
--    Two scalar reads give lag (the canary), a windowed count gives throughput,
--    and a count of dead_events gives the standing alert input. Cheap and
--    constant: no projection, just bounded aggregates over the hot partition and
--    the small offset/dead tables.
-- ---------------------------------------------------------------------------
create or replace function public.hq_spine_golden_signals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'max_event_id', (select coalesce(max(id), 0) from public.hq_events),
    'throughput', jsonb_build_object(
      'last_1m',  (select count(*) from public.hq_events where ts >= now() - interval '1 minute'),
      'last_1h',  (select count(*) from public.hq_events where ts >= now() - interval '1 hour'),
      'last_24h', (select count(*) from public.hq_events where ts >= now() - interval '24 hours')
    ),
    'consumers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'consumer',      c.consumer,
        'last_event_id', c.last_event_id,
        'lag',           greatest((select coalesce(max(id), 0) from public.hq_events) - c.last_event_id, 0),
        'updated_at',    c.updated_at
      ) order by c.consumer)
      from public.hq_event_consumers c
    ), '[]'::jsonb),
    'dead_event_count',     (select count(*) from public.dead_events),
    'oldest_dead_event_at', (select min(created_at) from public.dead_events),
    'retry_backlog',        (select count(*) from public.hq_consumer_retries)
  );
$$;

revoke all on function public.hq_spine_golden_signals() from public, anon, authenticated;
grant execute on function public.hq_spine_golden_signals() to service_role;
