-- HQ Event Spine — PR2: Domain Event Producers (Module 1, CEO Directive #003).
--
-- PR1 landed the spine's storage + write primitive DARK. PR2 wires the first
-- PRODUCERS: it generalises the existing public._record_activity() chokepoint so
-- that every domain mutation which already writes activity_log ALSO emits the
-- canonical hq_events row — in the SAME database transaction (decision D1; Ch.04
-- "transactional outbox"). State and its narrative become inseparable (P1): if the
-- mutation rolls back, so does its event; there is no second event framework and
-- no client-side transaction layer.
--
-- Ships DARK. The dual-write is gated by a feature flag that defaults OFF, so
-- APPLYING this migration changes no behaviour: activity_log is written exactly as
-- before and not one hq_events row is produced until an operator flips the flag.
-- Backwards compatibility is total — _record_activity()'s existing path is
-- byte-for-byte unchanged; the spine is one additive trailing call that no-ops
-- while dark or when the action is outside the curated subset.
--
-- Engineering Bible references: Ch.04 (event spine & taxonomy, producer contract),
-- Ch.03 (data model), Ch.16 (append-only). Registry: lib/events/registry.ts.

-- ===========================================================================
-- 1. The dual-write feature flag.
--
-- Reuse the existing HQ settings singleton (public.hq_settings, RLS:hq) rather
-- than inventing a flag store ("maximum reuse, minimum complexity"). It is kept
-- under a top-level `event_spine` section that is NOT in the settings TS
-- SECTION_IDS, so the operator settings page never renders it and mergeSettings()
-- ignores it: this is a low-level infra kill-switch, not an operator product flag.
--
-- Seed it false (DARK) WITHOUT clobbering a value an operator may already have
-- set — the WHERE guard only seeds when the key is absent, so re-application is
-- safe. Flip on later, at runtime and with no deploy, via:
--   update public.hq_settings
--     set data = jsonb_set(data, '{event_spine,dual_write_enabled}', 'true')
--   where id = 'singleton';
-- ===========================================================================
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object(
                'event_spine',
                coalesce(data -> 'event_spine', '{}'::jsonb)
                  || jsonb_build_object('dual_write_enabled', false)
              )
where id = 'singleton'
  and (data #> '{event_spine,dual_write_enabled}') is null;

-- ===========================================================================
-- 2. hq_spine_dual_write_enabled() — read the flag; default false on any miss.
--
-- SECURITY DEFINER (hq_settings is RLS:hq) with a pinned empty search_path, like
-- every other spine function. EXECUTE is revoked from public, anon AND
-- authenticated and granted only to service_role (L-4: Supabase's default
-- privileges grant EXECUTE on new public functions directly to the JWT roles, so
-- revoking from PUBLIC alone is not enough).
-- ===========================================================================
create or replace function public.hq_spine_dual_write_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select (data #>> '{event_spine,dual_write_enabled}')::boolean
      from public.hq_settings
      where id = 'singleton'
    ),
    false
  );
$$;

revoke all on function public.hq_spine_dual_write_enabled()
  from public, anon, authenticated;
grant execute on function public.hq_spine_dual_write_enabled()
  to service_role;

-- ===========================================================================
-- 3. hq_emit_from_activity(...) — the curated activity → canonical-event mapper.
--
-- Called once per _record_activity() write. It is a NO-OP unless BOTH (a) the
-- flag is on AND (b) the action is one of the curated OPERATIONS verbs in the
-- frozen registry (lib/events/registry.ts). Every other activity action is
-- intentionally NOT mirrored to the spine — the registry's OPERATIONS group is a
-- deliberate subset ("mirrored from activity_log"), not the whole activity log.
--
-- When it does emit, it emits THROUGH hq_emit_event() — the single validated
-- write entry point shared with the PR1 service path — in the caller's
-- transaction, so the event is atomic with the state change.
--
-- The curated map (jobs.status vocabulary is 'new'|'in-progress'|'completed'|
-- 'blocked', so only a transition TO 'completed' yields a canonical job verb;
-- registry verbs job.scheduled / job.cancelled have no source action yet and are
-- simply not produced):
--   customer.created                                  -> customer.created
--   customer.updated                                  -> customer.updated
--   job.created                                       -> job.created
--   job.status_changed  (metadata->>'to' = completed) -> job.completed
--   quote.sent                                        -> quote.sent
--   quote.accepted                                    -> quote.accepted
-- ===========================================================================
create or replace function public.hq_emit_from_activity(
  p_org_id        uuid,
  p_actor_id      uuid,
  p_actor_name    text,
  p_action        text,
  p_target_table  text,
  p_target_id     uuid,
  p_metadata      jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verb       text;
  v_actor_type text;
  v_actor_id   text;
  v_payload    jsonb;
begin
  -- Dark by default: do nothing at all until an operator opts in. This is the
  -- whole reason applying PR2 is a no-op — the curated mapping below is never
  -- even evaluated while the spine is dark.
  if not public.hq_spine_dual_write_enabled() then
    return;
  end if;

  -- Curated activity → canonical-verb map. Anything not listed is NOT a spine
  -- event (it still writes activity_log unchanged).
  v_verb := case
    when p_action = 'customer.created' then 'customer.created'
    when p_action = 'customer.updated' then 'customer.updated'
    when p_action = 'job.created'      then 'job.created'
    when p_action = 'job.status_changed'
         and p_metadata ->> 'to' = 'completed' then 'job.completed'
    when p_action = 'quote.sent'     then 'quote.sent'
    when p_action = 'quote.accepted' then 'quote.accepted'
    else null
  end;

  if v_verb is null then
    return;
  end if;

  -- Curated, NON-PII payload. The spine is a lean event log, not a second copy of
  -- tenant PII (Ch.04: payloads are small, structured, never PII-heavy). So we
  -- project only the safe hints from the activity metadata — status, identifiers,
  -- amounts — and DELIBERATELY drop personal data: a customer's name/email/phone
  -- and a quote signer's name stay in activity_log and never cross into hq_events.
  v_payload := case v_verb
    when 'customer.updated' then jsonb_build_object('fields', coalesce(p_metadata -> 'fields', '[]'::jsonb))
    when 'job.created'      then jsonb_build_object('status', p_metadata -> 'status')
    when 'job.completed'    then jsonb_build_object('from', p_metadata -> 'from', 'to', p_metadata -> 'to')
    when 'quote.sent'       then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total')
    when 'quote.accepted'   then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total', 'source', p_metadata -> 'source')
    else '{}'::jsonb
  end;

  -- Actor: an authenticated principal performed it -> 'human' (carry the uuid);
  -- otherwise the change came from a trigger with no auth context (e.g. a
  -- customer-signed quote via the public link) -> 'system'. The human-readable
  -- actor_name stays in activity_log; it is never carried into the event.
  if p_actor_id is not null then
    v_actor_type := 'human';
    v_actor_id   := p_actor_id::text;
  else
    v_actor_type := 'system';
    v_actor_id   := 'system';
  end if;

  -- Transactional outbox: emit through the single validated entry point, inside
  -- the caller's transaction. correlation_id threads an end-to-end intent when
  -- the caller has set the GUC (coalesce convention, Ch.04); otherwise each event
  -- starts its own trace. object_type is the verb namespace.
  perform public.hq_emit_event(
    p_actor_type     => v_actor_type,
    p_actor_id       => v_actor_id,
    p_verb           => v_verb,
    p_object_type    => split_part(v_verb, '.', 1),
    p_object_id      => p_target_id::text,
    p_correlation_id => coalesce(
      nullif(current_setting('hq.correlation_id', true), '')::uuid,
      gen_random_uuid()
    ),
    p_payload        => v_payload
  );
end;
$$;

revoke all on function public.hq_emit_from_activity(
  uuid, uuid, text, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.hq_emit_from_activity(
  uuid, uuid, text, text, text, uuid, jsonb
) to service_role;

-- ===========================================================================
-- 4. Generalise public._record_activity().
--
-- Reproduced verbatim from 20260516200000_activity_log.sql with ONE additive
-- change: a trailing call to hq_emit_from_activity() AFTER the activity_log
-- insert. The signature, the actor-resolution logic and the activity_log insert
-- are byte-for-byte identical, so every existing trigger keeps behaving exactly
-- as before. The new call no-ops while the flag is dark — the only generalisation
-- is that this one chokepoint now also feeds the spine.
-- ===========================================================================
create or replace function public._record_activity(
  p_org_id        uuid,
  p_action        text,
  p_target_table  text,
  p_target_id     uuid,
  p_metadata      jsonb default null,
  p_actor_override text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid;
  v_actor_name text;
begin
  v_actor_id := auth.uid();
  if p_actor_override is not null and p_actor_override <> '' then
    v_actor_name := p_actor_override;
  elsif v_actor_id is not null then
    select coalesce(full_name, email)
    into v_actor_name
    from public.users
    where id = v_actor_id;
  else
    v_actor_name := 'System';
  end if;

  insert into public.activity_log (
    org_id, actor_id, actor_name, action,
    target_table, target_id, metadata
  )
  values (
    p_org_id, v_actor_id, v_actor_name, p_action,
    p_target_table, p_target_id, p_metadata
  );

  -- PR2 (Module 1): dual-write the canonical HQ event in THIS transaction so
  -- state and narrative are inseparable (D1, Ch.04). No-op while the spine flag
  -- is dark or the action is outside the curated OPERATIONS subset, so existing
  -- activity logging is byte-for-byte unchanged until an operator opts in.
  perform public.hq_emit_from_activity(
    p_org_id, v_actor_id, v_actor_name,
    p_action, p_target_table, p_target_id, p_metadata
  );
end;
$$;
