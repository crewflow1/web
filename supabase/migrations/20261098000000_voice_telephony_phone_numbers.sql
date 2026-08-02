-- Voice Telephony (Wave 8) — the DARK inbound-voice substrate.
--
-- WHAT THIS IS. The database half of "a customer dials the org's number and the
-- AI receptionist answers": org↔dialed-number ROUTING (phone_numbers), the
-- append-only lifecycle AUDIT of every call (call_events), and the two keys the
-- existing `calls` table needs before a child can bind to it or a provider event
-- can be deduplicated. It reuses the EXISTING `calls` table (the origination
-- record) and the EXISTING `ai_receptionist_setups` table (per-org voice config);
-- it introduces NO redundant config table.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- Nothing here is reachable while the feature is off. The webhook routes
-- (app/api/webhooks/twilio/voice, .../voice/status, .../vapi) 503 before any
-- work unless NEXT_PUBLIC_FEATURE_VOICE_INBOUND="true" AND a voice provider is
-- credential-resolvable — both false in prod, CI and dev. A `phone_numbers` row
-- is admin-provisioned; a `call_events` row is written ONLY by the service-role
-- webhook handler. This migration writes nothing.
--
-- ── ORG ATTRIBUTION IS A DB LOOKUP, NOT A GUESS ─────────────────────────────
-- A single Twilio/Vapi account signs every tenant's inbound webhook, so — as
-- with whatsapp_number_routes — org attribution is a lookup on the DIALED number
-- (the infra identity the caller reached), never a per-org credential. A call to
-- a number with no active route is ack-dropped, never processed against a
-- guessed org.
--
-- ── PROVIDER SECRET IS SERVICE-ROLE-ONLY ON READ (column privilege) ──────────
-- phone_numbers.provider_auth_secret is a secret (a per-number signing/auth
-- token used at activation). RLS is ROW-level, so the member-read SELECT policy
-- would otherwise let any org member read it back over PostgREST. It is stripped
-- from the authenticated/anon read surface by a COLUMN privilege at the foot of
-- this migration — the accounting_connections / api_keys idiom: revoke the
-- table-wide SELECT, grant SELECT back on every column EXCEPT the secret. Only
-- service_role reads it. NULL today (dark).
--
-- ── CANNOT BE "ACTIVE" WITHOUT BEING PROVISIONED ────────────────────────────
-- A CHECK forbids active=true unless provider_number_sid is present. There is no
-- way to route a live call to a number the provider never actually provisioned.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE ─────────────────────────────────
-- Org-pinned with a composite candidate key (id, org_id). Every member may READ
-- the org's numbers, its calls and its call_events (operators see what's wired
-- and what happened); only an admin may WRITE phone_numbers (provisioning is an
-- admin act). call_events has NO authenticated write policy at all — it is an
-- append-only audit the service-role webhook handler owns.
--
-- Additive and reversible. To roll back:
--   drop table public.call_events;
--   drop table public.phone_numbers;
--   drop index if exists public.calls_provider_call_uniq;
--   alter table public.calls drop constraint if exists calls_id_org_key;

-- ── (a) calls: the keys the substrate needs ──────────────────────────────────
-- The `calls` PK is (id) only. A composite FK from call_events to
-- calls(id, org_id) needs a UNIQUE(id, org_id) target — add it. And a partial
-- unique on (provider, provider_call_id) makes a provider redelivery of the same
-- call idempotent at the DB, not just in code.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calls_id_org_key' and conrelid = 'public.calls'::regclass
  ) then
    alter table public.calls add constraint calls_id_org_key unique (id, org_id);
  end if;
end $$;

create unique index if not exists calls_provider_call_uniq
  on public.calls (provider, provider_call_id)
  where provider_call_id is not null;

-- ── (b) phone_numbers — org↔dialed-number routing ────────────────────────────
create table if not exists public.phone_numbers (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  -- The telephony provider that owns this number.
  provider             text not null check (provider in ('twilio', 'vapi')),
  -- The DIALED number in E.164 — the infra identity the caller reaches, and the
  -- routing key the webhook resolves an org from. Distinct from the free-text
  -- ai_receptionist_setups.business_phone display string.
  e164                 text not null,
  -- The provider's handle for the provisioned number (Twilio IncomingPhoneNumber
  -- SID / Vapi number id). NULL until a real provisioning resolves it.
  provider_number_sid  text,
  -- SERVICE-ROLE-ONLY secret (per-number auth/signing token). NULL today (dark);
  -- stripped from the authenticated read surface by the column grant below.
  provider_auth_secret text,
  label                text,
  -- DEFAULT FALSE: a number is dark until an admin activates a provisioned row.
  active               boolean not null default false,
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- One org owns a given (provider, number). A dialed number routes to one org.
  constraint phone_numbers_provider_e164_uniq unique (provider, e164),
  -- Composite-FK target (the (id, org_id) idiom) for any future child.
  constraint phone_numbers_id_org_key unique (id, org_id),
  -- NO-FAKE-PROVISIONED: cannot be active without a provider handle.
  constraint phone_numbers_active_needs_sid check (
    active is false or provider_number_sid is not null
  )
);

create index if not exists phone_numbers_org_idx on public.phone_numbers (org_id);

drop trigger if exists phone_numbers_set_updated_at on public.phone_numbers;
create trigger phone_numbers_set_updated_at before update on public.phone_numbers
  for each row execute function public.tg_set_updated_at();

alter table public.phone_numbers enable row level security;

drop policy if exists "phone_numbers: members can select" on public.phone_numbers;
create policy "phone_numbers: members can select" on public.phone_numbers
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "phone_numbers: admins can insert" on public.phone_numbers;
create policy "phone_numbers: admins can insert" on public.phone_numbers
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "phone_numbers: admins can update" on public.phone_numbers;
create policy "phone_numbers: admins can update" on public.phone_numbers
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "phone_numbers: admins can delete" on public.phone_numbers;
create policy "phone_numbers: admins can delete" on public.phone_numbers
  for delete to authenticated using (public.is_org_admin(org_id));

-- COLUMN-LEVEL PRIVILEGE — the provider_auth_secret readback exclusion. RLS is
-- row-level; without this a member could select=provider_auth_secret over
-- PostgREST. Revoke the table-wide SELECT, grant SELECT back on every column
-- EXCEPT the secret. Adding a new column does NOT expose it — it must be named
-- here. INSERT/UPDATE/DELETE keep their default grants so the admin-write RLS
-- policies stay the authority for writes (writing a secret is fine; READING it
-- back is what is forbidden). Idempotent — replays cleanly on `supabase db reset`.
revoke all on table public.phone_numbers from anon;
revoke select on table public.phone_numbers from authenticated;
grant select (
  id, org_id, provider, e164, provider_number_sid, label, active,
  created_by, created_at, updated_at
) on public.phone_numbers to authenticated;

-- ── (c) call_events — append-only call-lifecycle audit ───────────────────────
create table if not exists public.call_events (
  id                uuid primary key default gen_random_uuid(),
  call_id           uuid not null,
  org_id            uuid not null,
  -- The lifecycle transition. The pure reducer (lib/telephony/state-machine.ts)
  -- advances calls.status from these.
  event_type        text not null check (event_type in (
    'initiated', 'ringing', 'answered', 'in_progress', 'transferred',
    'completed', 'no_answer', 'busy', 'failed', 'canceled'
  )),
  -- The provider's own id for THIS event, when it carries one. Together with
  -- call_id it is the idempotency key for a redelivered status callback.
  provider_event_id text,
  payload           jsonb,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  -- Composite FK: an event belongs to a call OF THE SAME ORG. Binds to the
  -- (id, org_id) candidate key added above, so a mismatched (call_id, org_id) is
  -- rejected by the database, not merely by application code.
  constraint call_events_call_org_fkey
    foreign key (call_id, org_id) references public.calls (id, org_id) on delete cascade,
  -- IDEMPOTENT REDELIVERY: the same provider event for the same call lands once.
  constraint call_events_call_provider_event_uniq unique (call_id, provider_event_id)
);

create index if not exists call_events_call_occurred_idx
  on public.call_events (call_id, occurred_at);

alter table public.call_events enable row level security;

-- MEMBER-READ only. There is deliberately NO insert/update/delete policy for the
-- authenticated role: call_events is an append-only audit written solely by the
-- service-role webhook handler (which bypasses RLS). A member with a JWT can read
-- their org's call history but can never forge, mutate, or delete an event.
drop policy if exists "call_events: members can select" on public.call_events;
create policy "call_events: members can select" on public.call_events
  for select to authenticated using (org_id in (select public.current_org_ids()));

revoke all on table public.call_events from anon;
