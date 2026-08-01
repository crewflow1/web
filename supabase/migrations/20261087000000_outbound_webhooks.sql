-- Outbound webhooks (Train A) — org-configurable HTTPS endpoints that fire on
-- domain events. SUBSTRATE, BUILT DARK.
--
-- An org admin registers an HTTPS endpoint and a set of event verbs it wants;
-- when a matching event lands on the HQ Event Spine (20260720000000), a signed
-- POST is delivered to that endpoint with retries + a circuit breaker. Nothing
-- egresses until BOTH the global feature flag (NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS)
-- is on AND the org has an ACTIVE (verified) endpoint — in CI neither is true, so
-- the whole path is inert. The cron short-circuits to 204 before any DB work when
-- the flag is off.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE SECRET IS SERVER-MINTED, SHOWN ONCE, NEVER TENANT-READABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Each endpoint has an HMAC signing secret. It is generated server-side by the
-- create action (lib/webhooks/secret.ts — crypto.randomBytes), returned to the
-- admin exactly once in the create response, and NEVER client-supplied and NEVER
-- read back. Exactly the api_keys stance (20261086): RLS decides which ROWS a
-- tenant sees; it cannot hide a COLUMN. So the `secret` column is excluded from
-- the authenticated role by COLUMN-LEVEL privilege — `revoke select … from
-- authenticated` + an explicit safe-column grant that does NOT name `secret`.
-- CONSEQUENCE: tenant reads of this table MUST name their columns; `select('*')`
-- fails with 42501 by design. The settings page does; the security suite pins it.
-- Adding a column does NOT expose it — it must be granted here by name.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VERIFY-BEFORE-FIRST-EVENT
-- ─────────────────────────────────────────────────────────────────────────────
-- An endpoint is born 'paused' with verified_at NULL. Creation enqueues a signed
-- PING delivery; only when that ping gets a 2xx does the service-role delivery
-- pass stamp verified_at + flip status to 'active'. Real events fan out ONLY to
-- 'active' endpoints, so an unproven URL never receives real event traffic. The
-- trigger below refuses status→'active' while verified_at is NULL FOR EVERY ROLE,
-- so a tenant cannot raw-activate an unverified endpoint via PostgREST.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ORG PINNING (house style, 20261079)
-- ─────────────────────────────────────────────────────────────────────────────
-- Every child binds (endpoint_id, org_id) via a composite FK to
-- webhook_endpoints(id, org_id), so a delivery can never name another tenant's
-- endpoint — unrepresentable for every role including service_role. All FKs on
-- the cascade path are ON DELETE CASCADE (org teardown, the 20261052 lesson); the
-- only SET NULL edges point at public.users. BEFORE UPDATE guards write nothing
-- and cannot fire during a delete cascade.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE SPINE IS THE SOURCE — CONSUMED INDEPENDENTLY (20260720000000)
-- ─────────────────────────────────────────────────────────────────────────────
-- Fan-out reads hq_events in strict id-order behind a PRIVATE, single-row offset
-- (webhook_dispatch_state, §8), advanced transactionally by this train's OWN
-- drain (webhook_dispatch_drain), driven ONLY by the webhook-dispatch cron.
--
-- IT DELIBERATELY DOES NOT register a consumer in hq_event_consumers and DOES NOT
-- touch hq_consumer_apply / the generic spine drainer. An earlier version wired a
-- WHEN branch into hq_consumer_apply; because this migration applies AFTER the
-- timeline-projection migration (20260720040000) had added its own `timeline`
-- branch, reproducing hq_consumer_apply here silently DROPPED that branch and
-- drained the Pulse timeline to empty. Owning a private offset keeps the webhook
-- feature entirely independent of the timeline projection and the global spine
-- kill-switch, and cannot regress any other consumer.
--
-- hq_events carries no org_id, so fan-out resolves the owning org per event from
-- the event's object (curated, exception-safe resolver below) and inserts one
-- delivery per matching ACTIVE endpoint, idempotent via unique(endpoint_id,
-- event_id).

-- Fresh CREATE only; no ALTER on a hot table, so no lock_timeout needed.

-- ── 1. webhook_endpoints ─────────────────────────────────────────────────────
create table if not exists public.webhook_endpoints (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,

  -- HTTPS ONLY, at the DB and again at dispatch time (lib/webhooks/ssrf.ts). A
  -- plaintext http endpoint would leak the signed payload; refuse it structurally.
  url                  text not null check (url ~ '^https://'),
  description          text,

  -- HMAC signing secret. Server-minted, shown once, NEVER tenant-readable
  -- (column-level grant below) and NEVER client-supplied (no tenant UPDATE grant
  -- names it; the trigger freezes it for every role). The format CHECK pins it to
  -- the generator's shape (whsec_ + 43 base62 = 256 bits) so a raw PostgREST
  -- insert cannot smuggle in a weak/empty/arbitrary string — the DB cannot know a
  -- value's ORIGIN, so it enforces its SHAPE (the api_keys.key_hash stance).
  secret               text not null check (secret ~ '^whsec_[0-9A-Za-z]{43}$'),

  -- Subscribed verbs. VALIDATED IN THE APP LAYER against the build-fact
  -- EXPOSABLE_WEBHOOK_EVENTS registry (lib/webhooks/events.ts — a curated subset
  -- of the spine Verb union); the DB pins shape only (no NULL/blank entries),
  -- because the registry is a compile-time fact the DB cannot see.
  event_verbs          text[] not null default '{}'
    check (array_position(event_verbs, null) is null
           and array_position(event_verbs, '') is null),

  -- Lifecycle. 'paused' until a signed ping is acknowledged (verify-before-event);
  -- 'disabled_by_failures' when the circuit breaker trips. Only service_role, or a
  -- tenant on a VERIFIED endpoint, may reach 'active' (trigger).
  status               text not null default 'paused'
    check (status in ('active', 'paused', 'disabled_by_failures')),

  -- Circuit-breaker counter: consecutive DEAD deliveries. Reset to 0 on any
  -- success. Service-role managed (no tenant UPDATE grant).
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  -- Set once by the delivery pass when the first ping succeeds; the gate that lets
  -- status become 'active'. Immutable once set (trigger).
  verified_at          timestamptz,
  last_delivery_at     timestamptz,

  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Candidate key so children bind (endpoint_id, org_id), not endpoint_id alone.
  constraint webhook_endpoints_id_org_key unique (id, org_id),

  -- Belt-and-braces for the verify-before-event gate, declarative and every-role,
  -- covering INSERT and UPDATE alike: an endpoint can never be 'active' without a
  -- verification stamp. The BEFORE INSERT trigger forces verified_at NULL, so a
  -- raw insert of status='active' can never satisfy this and is refused.
  constraint webhook_endpoints_active_requires_verified
    check (status <> 'active' or verified_at is not null)
);

comment on table public.webhook_endpoints is
  'Org-scoped outbound webhook endpoints (Train A). The HMAC signing secret is server-minted, shown once on create, and EXCLUDED from tenant readback by column-level privilege (revoke select from authenticated + explicit safe-column grant that omits secret) — tenant reads must name columns; select(*) fails by design. Endpoints are born paused and only reach active after a signed ping is acknowledged.';
comment on column public.webhook_endpoints.secret is
  'HMAC-SHA256 signing secret. Server-minted (crypto.randomBytes), returned once from the create action, NEVER read back and NEVER client-supplied. Unreadable by the authenticated role (column privilege) and immutable for every role (trigger).';
comment on column public.webhook_endpoints.event_verbs is
  'Subscribed spine verbs, validated in the app against the build-fact EXPOSABLE_WEBHOOK_EVENTS registry. The DB pins only shape (no NULL/blank).';
comment on column public.webhook_endpoints.verified_at is
  'Stamped once when the first ping delivery gets a 2xx. status cannot become active while this is NULL (trigger, every role) — the verify-before-first-event gate.';

create index if not exists webhook_endpoints_org_idx
  on public.webhook_endpoints (org_id, created_at desc);
-- Fan-out scope: the active endpoints subscribed to a verb, per org.
create index if not exists webhook_endpoints_active_idx
  on public.webhook_endpoints (org_id) where status = 'active';

-- ── 2. webhook_deliveries ────────────────────────────────────────────────────
create table if not exists public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  endpoint_id      uuid not null,

  -- event_id NULL = a PING (verify-before-event) or manual test — it has no source
  -- spine event. For real events it is the hq_events.id provenance and the
  -- idempotency key (unique below). NULLs are distinct in a unique index, so an
  -- admin may re-ping without collision.
  event_id         bigint,
  verb             text not null check (btrim(verb) <> ''),

  -- The redacted envelope actually sent (built at fan-out, re-stamped by the
  -- delivery pass to exactly what went on the wire). Small + non-PII by
  -- construction (the spine producer already curates payloads).
  payload          jsonb not null default '{}'::jsonb,

  attempt          integer not null default 0 check (attempt >= 0),
  state            text not null default 'pending'
    check (state in ('pending', 'delivering', 'delivered', 'dead')),
  next_attempt_at  timestamptz not null default now(),
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- ORG BINDING: a delivery can never name another tenant's endpoint. Composite
  -- FK carries org_id, CASCADE for teardown.
  constraint webhook_deliveries_endpoint_org_fkey
    foreign key (endpoint_id, org_id)
    references public.webhook_endpoints (id, org_id) on delete cascade,

  -- Idempotent fan-out: one delivery per (endpoint, source event).
  constraint webhook_deliveries_endpoint_event_key unique (endpoint_id, event_id),

  constraint webhook_deliveries_id_org_key unique (id, org_id)
);

comment on table public.webhook_deliveries is
  'One outbound delivery attempt-set per (endpoint, spine event). org-pinned via a composite FK to webhook_endpoints(id, org_id); idempotent fan-out via unique(endpoint_id, event_id). Tenant-readable (org-scoped) but NEVER tenant-writable — the service-role delivery pass owns every state transition.';

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where state = 'pending';
create index if not exists webhook_deliveries_org_idx
  on public.webhook_deliveries (org_id, created_at desc);
create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

-- ── 3. Endpoint integrity guard (every role, INSERT + UPDATE) ────────────────
-- Column-level grants stop the AUTHENTICATED role touching secret/counters, but
-- service_role bypasses grants + policies, AND the INSERT column grant is the
-- default full-column grant (the create action writes the secret through the user
-- client). This trigger makes the invariants hold for EVERY role on BOTH ops:
--   INSERT — a fresh endpoint is ALWAYS born unverified and non-active. We force
--            verified_at NULL (so a raw insert cannot pre-stamp it) and refuse
--            status='active'. Verification happens later, ONLY via the delivery
--            pass's NULL→timestamp UPDATE. This closes the "raw-INSERT an active,
--            self-verified endpoint" bypass.
--   UPDATE — secret + org are frozen, verified_at is set-once, and status can
--            never reach 'active' while verified_at is NULL.
-- Writes nothing that could reproduce the org-teardown failure; the BEFORE guard
-- cannot fire during a delete cascade.
create or replace function public.tg_webhook_endpoints_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Verification is earned, never asserted at birth: force it off and refuse a
    -- born-active endpoint. (The table CHECK backstops this declaratively too.)
    new.verified_at := null;
    if new.status = 'active' then
      raise exception 'a webhook endpoint cannot be created active — it must acknowledge a signed ping first'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.secret is distinct from old.secret then
    raise exception 'webhook_endpoints.secret is immutable — delete and recreate the endpoint'
      using errcode = 'check_violation';
  end if;
  if new.org_id is distinct from old.org_id then
    raise exception 'webhook_endpoints.org_id is immutable — an endpoint never changes tenant'
      using errcode = 'check_violation';
  end if;
  -- verified_at is set-once: NULL → timestamp is the only legal move.
  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception 'webhook_endpoints.verified_at is set once and cannot be changed'
      using errcode = 'check_violation';
  end if;
  -- The verify-before-event gate, for EVERY role: no path activates an unverified
  -- endpoint. The delivery pass stamps verified_at and status='active' together,
  -- so a genuine ping success is allowed; a tenant raw-update to 'active' on an
  -- unverified endpoint is refused.
  if new.status = 'active' and new.verified_at is null then
    raise exception 'webhook endpoint % cannot be activated before a ping is acknowledged', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists webhook_endpoints_guard on public.webhook_endpoints;
create trigger webhook_endpoints_guard
  before insert or update on public.webhook_endpoints
  for each row execute function public.tg_webhook_endpoints_guard();

drop trigger if exists webhook_endpoints_set_updated_at on public.webhook_endpoints;
create trigger webhook_endpoints_set_updated_at before update on public.webhook_endpoints
  for each row execute function public.tg_set_updated_at();

drop trigger if exists webhook_deliveries_set_updated_at on public.webhook_deliveries;
create trigger webhook_deliveries_set_updated_at before update on public.webhook_deliveries
  for each row execute function public.tg_set_updated_at();

-- ── 4. RLS — admin manage endpoints; org read-only deliveries ────────────────
alter table public.webhook_endpoints enable row level security;

-- Admin-only, NOT current_org_ids: a plain member must neither see endpoints nor
-- create one (an endpoint is an egress + a credential). Per-command policies.
drop policy if exists "webhook_endpoints: admins select" on public.webhook_endpoints;
create policy "webhook_endpoints: admins select" on public.webhook_endpoints
  for select to authenticated
  using (public.is_org_admin(org_id));

drop policy if exists "webhook_endpoints: admins insert" on public.webhook_endpoints;
create policy "webhook_endpoints: admins insert" on public.webhook_endpoints
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "webhook_endpoints: admins update" on public.webhook_endpoints;
create policy "webhook_endpoints: admins update" on public.webhook_endpoints
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "webhook_endpoints: admins delete" on public.webhook_endpoints;
create policy "webhook_endpoints: admins delete" on public.webhook_endpoints
  for delete to authenticated
  using (public.is_org_admin(org_id));

alter table public.webhook_deliveries enable row level security;

-- Deliveries are READ-ONLY to the tenant (org-scoped) and WRITTEN only by the
-- service-role delivery pass. Deliberately only a SELECT policy: RLS
-- default-denies insert/update/delete, and the grants below are revoked as a
-- second, independent lock. Admin-only select — the delivery log lives on the
-- admin settings surface, alongside the endpoints it reports on.
drop policy if exists "webhook_deliveries: admins select" on public.webhook_deliveries;
create policy "webhook_deliveries: admins select" on public.webhook_deliveries
  for select to authenticated
  using (public.is_org_admin(org_id));

-- ── 5. Column-level privileges — the secret readback exclusion (§1) ──────────
-- Supabase grants ALL on new public tables to anon + authenticated by default;
-- RLS alone would still let an admin select `secret` on their own rows. Rebuild
-- the grants explicitly. Idempotent + replay-clean.
revoke all on table public.webhook_endpoints from anon;
revoke all on table public.webhook_deliveries from anon;

revoke select, update, delete, truncate, references, trigger
  on table public.webhook_endpoints from authenticated;

-- The explicit safe column list — every column EXCEPT secret. Adding a column
-- does NOT expose it; it must be granted here by name.
grant select (id, org_id, url, description, event_verbs, status,
              consecutive_failures, verified_at, last_delivery_at,
              created_by, created_at, updated_at)
  on public.webhook_endpoints to authenticated;

-- Tenant updates are config only: description, subscribed verbs, and pause/resume
-- (status). NOT secret, NOT the counters, NOT verified_at — and the trigger stops
-- status reaching 'active' before verification.
grant update (description, event_verbs, status)
  on public.webhook_endpoints to authenticated;

-- INSERT keeps its default full-column grant so the create action can write the
-- secret through the user client (admin-only RLS insert is the authority);
-- READING it back is what is forbidden, and the create action never selects it.

-- Deliveries: tenant may SELECT (RLS admin-only), never write. Revoke write grants
-- as a second lock beside the absent policies.
revoke insert, update, delete, truncate, references, trigger
  on table public.webhook_deliveries from authenticated;

-- ── 6. webhook_resolve_org — curated, exception-safe org attribution ─────────
-- hq_events carries no org_id (it is an HQ-level log; the tenant operations
-- producer keeps org in activity_log only). Fan-out therefore resolves the owning
-- org from the event's object by its verb namespace. STATIC, curated dispatch —
-- no dynamic SQL in a SECURITY DEFINER function. A bad/unknown object id returns
-- NULL (the honest "cannot attribute" — that event simply does not fan out); a
-- delivery is org-pinned by composite FK regardless, so a mis-resolution can
-- never target another tenant's endpoint.
create or replace function public.webhook_resolve_org(
  p_object_type text,
  p_object_id   text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  begin
    v_id := p_object_id::uuid;
  exception when others then
    return null;  -- object_id is not a uuid (e.g. an org.* event carries the org id itself, handled below)
  end;

  case p_object_type
    when 'job' then
      select org_id into v_org from public.jobs where id = v_id;
    when 'customer' then
      select org_id into v_org from public.customers where id = v_id;
    when 'quote' then
      select org_id into v_org from public.quotes where id = v_id;
    when 'invoice' then
      select org_id into v_org from public.invoices where id = v_id;
    when 'support' then
      select org_id into v_org from public.support_tickets where id = v_id;
    when 'org' then
      select id into v_org from public.organizations where id = v_id;
    else
      v_org := null;
  end case;

  return v_org;
end $$;

revoke all on function public.webhook_resolve_org(text, text) from public, anon, authenticated;
grant execute on function public.webhook_resolve_org(text, text) to service_role;

-- ── 6b. webhook_redact_data — per-verb payload key allowlist (defence in depth) ─
-- The STORED delivery row must never hold un-redacted event data (a failed/dead/
-- pending row is on disk and tenant-readable). So redaction happens at FAN-OUT,
-- here, not only on the wire. The producer already curates payloads to non-PII;
-- this drops anything outside the per-verb allowlist so a future producer change
-- that starts emitting more keys can never silently widen what a webhook stores
-- or sends. This CASE is a hand-mirror of lib/webhooks/events.ts
-- WEBHOOK_REDACTION_MAP; __tests__/security/outbound-webhooks.test.ts pins the two
-- against drift. An unknown/non-exposable verb drops ALL data (fail-closed) — the
-- ping path builds its own payload and never comes through here.
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
          when 'job.scheduled'    then array['status']
          when 'job.completed'    then array['from', 'to']
          when 'job.cancelled'    then array['from', 'to', 'status']
          when 'customer.created' then array[]::text[]
          when 'customer.updated' then array['fields']
          when 'quote.sent'       then array['number', 'total']
          when 'quote.accepted'   then array['number', 'total', 'source']
          else array[]::text[]
        end
      )),
    '{}'::jsonb
  );
$$;

revoke all on function public.webhook_redact_data(text, jsonb) from public, anon, authenticated;
grant execute on function public.webhook_redact_data(text, jsonb) to service_role;

-- ── 7. webhook_fan_out_event — one idempotent delivery per matching endpoint ──
-- The single source of fan-out logic, called by BOTH the feature's own drain
-- (§8) and the generic spine drainer's apply seam (§9). Resolves the org, then
-- inserts a pending delivery for every ACTIVE endpoint in that org subscribed to
-- the verb, ON CONFLICT DO NOTHING (idempotent). Builds the redacted envelope
-- actually sent — small + non-PII (the producer already curated the payload).
create or replace function public.webhook_fan_out_event(p_event public.hq_events)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  v_org := public.webhook_resolve_org(p_event.object_type, p_event.object_id);
  if v_org is null then
    return;
  end if;

  insert into public.webhook_deliveries
    (org_id, endpoint_id, event_id, verb, payload, state, next_attempt_at)
  select
    v_org,
    e.id,
    p_event.id,
    p_event.verb,
    jsonb_build_object(
      'id',     p_event.id,
      'verb',   p_event.verb,
      'ts',     p_event.ts,
      'org_id', v_org,
      'object', jsonb_build_object('type', p_event.object_type, 'id', p_event.object_id),
      -- REDACTED at store time — the on-disk row never holds un-allowlisted data.
      'data',   public.webhook_redact_data(p_event.verb, coalesce(p_event.payload, '{}'::jsonb))
    ),
    'pending',
    now()
  from public.webhook_endpoints e
  where e.org_id = v_org
    and e.status = 'active'
    and p_event.verb = any (e.event_verbs)
  on conflict (endpoint_id, event_id) do nothing;
end $$;

revoke all on function public.webhook_fan_out_event(public.hq_events) from public, anon, authenticated;
grant execute on function public.webhook_fan_out_event(public.hq_events) to service_role;

-- ── 8. webhook_dispatch_state — the feature's OWN, PRIVATE offset ────────────
-- DELIBERATELY NOT a row in hq_event_consumers, and this migration DELIBERATELY
-- does NOT touch hq_consumer_apply. The generic spine drainer iterates every
-- hq_event_consumers row and applies via static dispatch; putting our consumer
-- there (or editing that apply) would (a) risk the generic drainer advancing our
-- offset via its no-op `else` and stealing events from our fan-out when the
-- global spine gate is on, and (b) — the regression this fixes — require
-- reproducing hq_consumer_apply, which silently dropped the `timeline` projection
-- branch a later migration had added, draining the Pulse timeline to empty.
-- So outbound webhooks own a private single-row offset, read+advanced ONLY by
-- webhook_dispatch_drain (§8b), completely independent of the timeline path.
create table if not exists public.webhook_dispatch_state (
  id            text primary key default 'singleton' check (id = 'singleton'),
  last_event_id bigint not null default 0,
  updated_at    timestamptz not null default now()
);
comment on table public.webhook_dispatch_state is
  'Single-row (singleton) offset for the outbound-webhook fan-out. Deliberately separate from the shared spine consumer registry so the generic spine drainer never touches it — the webhook feature owns its offset entirely. Service-role only (RLS on, zero policies).';
-- Service-role only: RLS enabled with NO policies (the hq-spine internal-table
-- posture); anon/authenticated grants revoked.
alter table public.webhook_dispatch_state enable row level security;
revoke all on table public.webhook_dispatch_state from anon, authenticated;

-- ── 8b. webhook_dispatch_drain — the feature's own offset drainer ────────────
-- NOT gated by hq_spine_consumer_enabled and NOT part of the generic drainer: the
-- feature owns its gate through its own cron (which 204-no-ops when the flag is
-- off). One transaction: lock the singleton offset row (SKIP LOCKED — an
-- overlapping cron run is a clean no-op), read a bounded id-ordered batch, fan
-- each out idempotently, advance the offset. Fan-out is conflict-safe and the
-- resolver is exception-safe, so a crash simply re-runs idempotent work on resume.
create or replace function public.webhook_dispatch_drain(p_max_events integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offset    bigint;
  v_ev        public.hq_events%rowtype;
  v_processed integer := 0;
begin
  select last_event_id into v_offset
    from public.webhook_dispatch_state
   where id = 'singleton'
   for update skip locked;
  if not found then
    -- Absent (never seeded) or already locked by a concurrent run: clean no-op.
    return jsonb_build_object('skipped', 'locked_or_unseeded');
  end if;

  for v_ev in
    select *
      from public.hq_events
     where id > v_offset
     order by id asc
     limit greatest(p_max_events, 1)
  loop
    perform public.webhook_fan_out_event(v_ev);
    v_offset := v_ev.id;
    v_processed := v_processed + 1;
  end loop;

  update public.webhook_dispatch_state
     set last_event_id = v_offset, updated_at = now()
   where id = 'singleton';

  return jsonb_build_object(
    'processed',  v_processed,
    'new_offset', v_offset,
    'lag',        greatest((select coalesce(max(id), 0) from public.hq_events) - v_offset, 0)
  );
end $$;

revoke all on function public.webhook_dispatch_drain(integer) from public, anon, authenticated;
grant execute on function public.webhook_dispatch_drain(integer) to service_role;

-- ── 10. webhook_claim_deliveries — atomic claim for the delivery pass ────────
-- Marks a bounded batch of DUE deliveries 'delivering' and returns them with the
-- endpoint url + secret (service-role only), so overlapping cron runs never
-- double-send. FOR UPDATE SKIP LOCKED. Excludes disabled endpoints; a ping
-- (event_id null) to a paused endpoint IS claimable (that is how verification
-- happens) — real-event deliveries only ever exist for active endpoints.
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
     where d.state = 'pending'
       and d.next_attempt_at <= now()
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

-- ── 11. webhook_mark_delivered / webhook_mark_failed — outcome writers ───────
-- The ONLY paths that leave the 'delivering' state, both service-role. The
-- backoff schedule + attempt ceiling live in TS (server/services/webhook-dispatch.ts,
-- unit-tested); these writers just persist the decision and move the endpoint's
-- circuit-breaker counters. p_sent_payload re-stamps the delivery with exactly
-- what went on the wire (post-redaction).
create or replace function public.webhook_mark_delivered(
  p_delivery_id  uuid,
  p_status_code  integer,
  p_sent_payload jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoint uuid;
begin
  update public.webhook_deliveries
     set state            = 'delivered',
         delivered_at     = now(),
         last_status_code = p_status_code,
         last_error       = null,
         attempt          = attempt + 1,
         payload          = coalesce(p_sent_payload, payload),
         updated_at       = now()
   where id = p_delivery_id and state = 'delivering'
   returning endpoint_id into v_endpoint;

  if v_endpoint is null then
    return;  -- lost the race / already resolved
  end if;

  -- Success: reset the breaker, stamp activity, and (verify-before-event) promote
  -- a paused endpoint to active on its first acknowledged ping.
  update public.webhook_endpoints
     set consecutive_failures = 0,
         last_delivery_at     = now(),
         verified_at          = coalesce(verified_at, now()),
         status               = case when status = 'paused' then 'active' else status end,
         updated_at           = now()
   where id = v_endpoint;
end $$;

revoke all on function public.webhook_mark_delivered(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.webhook_mark_delivered(uuid, integer, jsonb) to service_role;

create or replace function public.webhook_mark_failed(
  p_delivery_id     uuid,
  p_status_code     integer,
  p_error           text,
  p_dead            boolean,
  p_next_attempt_at timestamptz,
  p_failure_threshold integer default 5
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoint uuid;
  v_failures integer;
begin
  if p_dead then
    update public.webhook_deliveries
       set state            = 'dead',
           last_status_code = p_status_code,
           last_error       = left(coalesce(p_error, ''), 2000),
           attempt          = attempt + 1,
           updated_at       = now()
     where id = p_delivery_id and state = 'delivering'
     returning endpoint_id into v_endpoint;

    if v_endpoint is null then
      return;
    end if;

    -- Circuit breaker: trip after N consecutive dead deliveries.
    update public.webhook_endpoints
       set consecutive_failures = consecutive_failures + 1,
           status = case
                      when consecutive_failures + 1 >= greatest(p_failure_threshold, 1)
                        then 'disabled_by_failures'
                      else status
                    end,
           updated_at = now()
     where id = v_endpoint
     returning consecutive_failures into v_failures;
  else
    -- Retry pending: keep it claimable at the backoff time TS computed.
    update public.webhook_deliveries
       set state            = 'pending',
           last_status_code = p_status_code,
           last_error       = left(coalesce(p_error, ''), 2000),
           attempt          = attempt + 1,
           next_attempt_at  = p_next_attempt_at,
           updated_at       = now()
     where id = p_delivery_id and state = 'delivering';
  end if;
end $$;

revoke all on function public.webhook_mark_failed(uuid, integer, text, boolean, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.webhook_mark_failed(uuid, integer, text, boolean, timestamptz, integer)
  to service_role;

-- ── 12. webhook_enqueue_ping — the verify-before-event ping ──────────────────
-- Enqueues a signed PING delivery for an endpoint (event_id NULL). Called by the
-- create + re-verify actions through the service-role client AFTER the action has
-- authorised the caller as an org admin (RLS on webhook_endpoints is the
-- authority for that). One live pending ping per endpoint at a time.
create or replace function public.webhook_enqueue_ping(p_endpoint_id uuid, p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Guard: the endpoint must exist in the claimed org. (Belt-and-braces; the
  -- action already proved admin of p_org_id via the user client.)
  perform 1 from public.webhook_endpoints where id = p_endpoint_id and org_id = p_org_id;
  if not found then
    return null;
  end if;

  -- Don't stack pings — reuse an existing pending one.
  select id into v_id
    from public.webhook_deliveries
   where endpoint_id = p_endpoint_id and event_id is null and state = 'pending'
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.webhook_deliveries
    (org_id, endpoint_id, event_id, verb, payload, state, next_attempt_at)
  values (
    p_org_id, p_endpoint_id, null, 'webhook.ping',
    jsonb_build_object('verb', 'webhook.ping', 'ts', now(), 'org_id', p_org_id,
                       'data', jsonb_build_object('message', 'CrewFlow webhook verification ping')),
    'pending', now()
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.webhook_enqueue_ping(uuid, uuid) from public, anon, authenticated;
grant execute on function public.webhook_enqueue_ping(uuid, uuid) to service_role;

-- ── 13. Seed the private offset at the current head (new events only) ────────
-- Start at the current head so a fresh install does NOT replay all history into
-- freshly-created webhooks. ON CONFLICT DO NOTHING keeps a re-apply from rewinding
-- a live offset. This is the ONLY consumer-offset state this train creates — it
-- registers NOTHING in hq_event_consumers and edits NO spine function, so the
-- generic drainer and the timeline projection are wholly unaffected.
insert into public.webhook_dispatch_state (id, last_event_id)
values ('singleton', coalesce((select max(id) from public.hq_events), 0))
on conflict (id) do nothing;
