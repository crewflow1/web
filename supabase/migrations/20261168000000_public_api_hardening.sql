-- Public API v1 — hardening wave (MP R4).
--
-- The public API (app/api/v1/*, lib/public-api/*, lib/api-auth/*) ships DARK
-- behind FEATURE_PUBLIC_API_JOBS. This migration is the DB half of four
-- hardening deliverables; it changes NO behaviour while the flag is dark:
--
--   1. api_request_log — a per-request ACCESS LOG for the key-authenticated
--      surface. The guard's "per-endpoint audit" claim was previously unmet
--      (only a coarse, debounced last_used_at touch on api_keys). This table is
--      the real audit trail: one row per ADMITTED v1 request, METADATA ONLY
--      (key_id, org_id, method, route, status, ts) — never a request body,
--      header, query string or any secret/PII. Org-pinned, RLS admin-only read,
--      service-role write, append-only, retention-friendly (ts index).
--
--   2. hq_emit_from_activity — the activity → spine producer gains two curated
--      BILLING edges (invoice.created, invoice.paid) so the outbound-webhook
--      catalogue can expose them. Both are REAL registered spine Verbs whose
--      activity actions already flow through _record_activity (the invoices
--      INSERT trigger and the status-change UPDATE trigger), so this completes a
--      producer edge — it does NOT advertise a producer-less verb. No-op while
--      the spine dual-write flag is dark.
--
--   3. webhook_redact_data — the per-verb payload key allowlist (the send-time
--      defence-in-depth mirror of lib/webhooks/events.ts) gains the two new
--      billing verbs. Kept in exact lockstep with the TS map (drift-guard test).
--
-- No new SECURITY DEFINER function is introduced here: hq_emit_from_activity
-- and webhook_redact_data are pre-existing definers, replaced in place with
-- their revoke-all-then-grant-service_role lockdown reproduced verbatim.
--
-- TEARDOWN SAFETY (the 20261052 lesson): api_request_log is additive,
-- org-scoped, org FK ON DELETE CASCADE, key_id ON DELETE CASCADE (a request row
-- never outlives the key it belongs to). No RESTRICT, no AFTER-DELETE trigger.
-- Fresh CREATE only — no hot-table ALTER, no lock_timeout needed.

-- ===========================================================================
-- 1. api_request_log — the public-API per-request access log
-- ===========================================================================
create table if not exists public.api_request_log (
  id          bigint generated always as identity primary key,

  -- The key that authenticated the request, and its org. Both pinned by the
  -- guard from the RESOLVED key (never from client input). ON DELETE CASCADE:
  -- a request row is telemetry about a key, so it dies with the key.
  --
  -- key_id is a COMPOSITE FK — (key_id, org_id) -> api_keys(id, org_id), the
  -- quotes/jobs/leads cross-tenant pattern — against api_keys_id_org_key. This
  -- makes "the logging key lives in the SAME org as this log row" a database
  -- invariant no writer (service-role included) can bypass, so a request can
  -- never be attributed to a key belonging to another tenant. It is defined at
  -- table level (below) because a column-level FK cannot span two columns.
  key_id      uuid not null,
  org_id      uuid not null references public.organizations(id) on delete cascade,

  -- Request METADATA ONLY. No body, no headers, no query string — nothing that
  -- can carry a secret or PII.
  --   method — the HTTP verb (GET/POST/PATCH/…), upper-cased, bounded.
  --   route  — the URL PATHNAME only (e.g. /api/v1/customers). NEVER the query
  --            string: pagination/filter params can carry tenant identifiers,
  --            so they are dropped before this row is written.
  --   status — the guard's disposition for the request. The guard writes this
  --            row for ADMITTED requests, so status is 200 here; the column is
  --            a smallint so a future design that also logs a denial can record
  --            it without a schema change.
  method      text not null check (method ~ '^[A-Z]{3,10}$'),
  route       text not null check (btrim(route) <> '' and route !~ '\?' and length(route) <= 300),
  status      smallint not null check (status between 100 and 599),

  created_at  timestamp with time zone not null default now(),

  -- COMPOSITE cross-tenant FK (the quotes/jobs/leads pattern): the referenced
  -- api_key must be in the SAME org as this log row. ON DELETE CASCADE so a
  -- request row never outlives the key it belongs to. Targets the
  -- api_keys_id_org_key unique (id, org_id) from migration 20261086000000.
  constraint api_request_log_key_id_fkey
    foreign key (key_id, org_id)
    references public.api_keys (id, org_id) on delete cascade
);

comment on table public.api_request_log is
  'Public API v1 per-request ACCESS LOG (MP R4). One row per ADMITTED '
  'key-authenticated request, written by lib/public-api/guard.ts via the '
  'service-role admin client. METADATA ONLY — method, url PATHNAME (no query '
  'string), and status; never a body, header or secret. Org-pinned, append-only, '
  'RLS admin-only read, no tenant write. Retention-friendly via the ts index. '
  'Dark until FEATURE_PUBLIC_API_JOBS is enabled (the whole v1 surface 404s).';
comment on column public.api_request_log.route is
  'The request URL PATHNAME only (e.g. /api/v1/invoices). The query string is '
  'deliberately excluded (CHECK forbids ''?'') so filter/pagination params that '
  'could name tenant rows are never persisted.';
comment on column public.api_request_log.status is
  'The guard disposition (200 for an admitted request). Smallint so a later '
  'design can record a denial status without a migration.';

-- Read paths: "recent requests for this org" and "recent requests for this
-- key". Both lead with org_id (the RLS + query scoper) and order by time desc.
create index if not exists api_request_log_org_ts_idx
  on public.api_request_log (org_id, created_at desc);
create index if not exists api_request_log_key_ts_idx
  on public.api_request_log (key_id, created_at desc);

-- ── RLS — admin-only read, no tenant write (writes are service-role only) ────
-- Mirrors the api_keys posture: this is a SECURITY access log, so a plain org
-- member must not read it, and NO role below service_role may write it. The
-- guard writes through the service-role admin client, which bypasses RLS.
alter table public.api_request_log enable row level security;

-- Admin-only SELECT, NOT current_org_ids: an access log is admin-grade.
drop policy if exists "api_request_log: admins select" on public.api_request_log;
create policy "api_request_log: admins select" on public.api_request_log
  for select to authenticated
  using (public.is_org_admin(org_id));

-- Deliberately NO insert/update/delete policy. RLS default-denies them, and the
-- grants are revoked below as a second, independent lock. The log is
-- append-only and owned by the service role.

-- ── Column / table privileges ───────────────────────────────────────────────
-- Supabase grants ALL on new public tables to anon + authenticated by default.
-- Rebuild explicitly: anon gets nothing; authenticated may SELECT only (RLS
-- still gates to admins of the row's org), never write.
revoke all on table public.api_request_log from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.api_request_log from authenticated;
grant select on table public.api_request_log to authenticated;

-- ===========================================================================
-- 2. hq_emit_from_activity — add the invoice.created / invoice.paid edges
-- ===========================================================================
-- Reproduced from 20260720010000_hq_event_spine_producers.sql with TWO additive
-- v_verb cases and their matching v_payload projections. Everything else — the
-- dark-by-default guard, the actor resolution, the transactional-outbox emit and
-- the revoke/grant lockdown — is byte-for-byte identical, so applying this is a
-- no-op until the spine dual-write flag is enabled. Both new verbs are REAL
-- registered BILLING Verbs (lib/events/registry.ts) whose activity actions
-- already reach this function through _record_activity (the invoices INSERT
-- trigger writes 'invoice.created'; the status-change UPDATE trigger writes
-- 'invoice.' || NEW.status, i.e. 'invoice.paid' on the paid transition).
create or replace function public.hq_emit_from_activity(
  p_org_id       uuid,
  p_actor_id     uuid,
  p_actor_name   text,
  p_action       text,
  p_target_table text,
  p_target_id    uuid,
  p_metadata     jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_verb       text;
  v_actor_type text;
  v_actor_id   text;
  v_payload    jsonb;
begin
  -- Dark by default: do nothing at all until an operator opts in.
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
    -- BILLING edges (MP R4). The invoices INSERT trigger records
    -- 'invoice.created'; the status-change UPDATE trigger records
    -- 'invoice.paid' when NEW.status becomes 'paid'. Both flow through
    -- _record_activity, so these are real producers, not advertised silence.
    when p_action = 'invoice.created' then 'invoice.created'
    when p_action = 'invoice.paid'    then 'invoice.paid'
    else null
  end;

  if v_verb is null then
    return;
  end if;

  -- Curated, NON-PII payload — small safe hints only (status, identifiers,
  -- amounts). Personal data stays in activity_log and never crosses to hq_events.
  v_payload := case v_verb
    when 'customer.updated' then jsonb_build_object('fields', coalesce(p_metadata -> 'fields', '[]'::jsonb))
    when 'job.created'      then jsonb_build_object('status', p_metadata -> 'status')
    when 'job.completed'    then jsonb_build_object('from', p_metadata -> 'from', 'to', p_metadata -> 'to')
    when 'quote.sent'       then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total')
    when 'quote.accepted'   then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total', 'source', p_metadata -> 'source')
    when 'invoice.created'  then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total')
    when 'invoice.paid'     then jsonb_build_object('number', p_metadata -> 'number', 'total', p_metadata -> 'total', 'from', p_metadata -> 'from', 'to', p_metadata -> 'to')
    else '{}'::jsonb
  end;

  -- Actor: an authenticated principal -> 'human' (carry the uuid); otherwise a
  -- trigger with no auth context -> 'system'. actor_name stays in activity_log.
  if p_actor_id is not null then
    v_actor_type := 'human';
    v_actor_id   := p_actor_id::text;
  else
    v_actor_type := 'system';
    v_actor_id   := 'system';
  end if;

  -- Transactional outbox: emit through the single validated entry point, inside
  -- the caller's transaction. object_type is the verb namespace.
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
-- 3. webhook_redact_data — add the invoice.created / invoice.paid allowlists
-- ===========================================================================
-- Reproduced from 20261111000000_webhook_redact_drop_producerless_verbs.sql
-- with the two billing verbs added, kept in exact lockstep with the TS map
-- (lib/webhooks/events.ts WEBHOOK_REDACTION_MAP). A verb absent from the CASE
-- sends '{}'::jsonb (fail-closed).
create or replace function public.webhook_redact_data(p_verb text, p_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_object_agg(key, value)
       from jsonb_each(coalesce(p_data, '{}'::jsonb))
      where key = any (
        case p_verb
          when 'job.created'      then array['status']
          when 'job.completed'    then array['from', 'to']
          when 'customer.created' then array[]::text[]
          when 'customer.updated' then array['fields']
          when 'quote.sent'       then array['number', 'total']
          when 'quote.accepted'   then array['number', 'total', 'source']
          when 'invoice.created'  then array['number', 'total']
          when 'invoice.paid'     then array['number', 'total', 'from', 'to']
          else array[]::text[]
        end
      )),
    '{}'::jsonb
  );
$$;

revoke all on function public.webhook_redact_data(text, jsonb) from public, anon, authenticated;
grant execute on function public.webhook_redact_data(text, jsonb) to service_role;
