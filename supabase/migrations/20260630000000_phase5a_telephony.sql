-- =========================================================================
-- Phase 5A — Telephony spine for the AI receptionist (Vapi).
--
-- Goal: a live inbound Vapi call can flow
--   number → organisation → AI conversation → stored call record.
--
-- Two pieces:
--
--   1. phone_numbers (NEW) — the routing table. Maps an inbound E.164
--      number to exactly ONE organisation. An org may own MANY numbers
--      (one row each); a number belongs to ONE org (e164 is UNIQUE).
--      Writes are HQ-only (service-role); org members may SELECT their
--      own rows so the app can show "your number".
--
--   2. calls (EXISTING — baseline schema, 00000000000000) — already
--      Vapi-shaped: provider default 'vapi', provider_call_id,
--      transcript, transcript_json, ai_summary, ai_extracted,
--      caller_number, receiver_number, direction, status, duration_sec,
--      started_at, ended_at — with member-scoped RLS already enforcing
--      cross-org isolation. We do NOT recreate it. We add only what
--      telephony routing + idempotent webhooks need:
--        - phone_number_id  → link a call to the matched number
--        - a PARTIAL UNIQUE index on (provider, provider_call_id) so
--          replayed Vapi webhooks upsert idempotently (the baseline
--          only had a NON-unique index on provider_call_id).
--
-- Multi-tenant safety: a call's org_id is derived from the number lookup
-- (phone_numbers.e164 → org_id), NEVER trusted from the webhook body.
-- RLS on both tables uses public.current_org_ids(), so one org can never
-- read another org's numbers or calls.
--
-- Idempotent: IF NOT EXISTS everywhere; safe to re-run.
-- =========================================================================

-- -------------------------------------------------------------------------
-- phone_numbers — inbound number → organisation routing table
-- -------------------------------------------------------------------------
create table if not exists public.phone_numbers (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- E.164 ("+" + digits). The routing key. One number → one org.
  e164               text not null,
  label              text,
  provider           text not null default 'vapi'
    check (provider in ('vapi', 'twilio')),
  -- The provider's own id for this number (e.g. Vapi phoneNumberId).
  provider_number_id text,
  -- Optional per-number assistant override. When null the webhook builds
  -- the assistant config dynamically from the org's receptionist setup.
  vapi_assistant_id  text,
  status             text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at         timestamp with time zone not null default now(),
  updated_at         timestamp with time zone not null default now()
);

-- One org → many numbers, but each number routes to EXACTLY one org.
create unique index if not exists phone_numbers_e164_unique
  on public.phone_numbers (e164);
create index if not exists phone_numbers_org_idx
  on public.phone_numbers (org_id);

drop trigger if exists tg_phone_numbers_updated_at on public.phone_numbers;
create trigger tg_phone_numbers_updated_at
  before update on public.phone_numbers
  for each row execute function public.tg_set_updated_at();

alter table public.phone_numbers enable row level security;

-- Org members can SEE their own org's numbers (so the app can render
-- "your number"). Reuses the same helper every other tenant table uses.
drop policy if exists phone_numbers_select on public.phone_numbers;
create policy phone_numbers_select on public.phone_numbers
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

-- No INSERT/UPDATE/DELETE policies → writes are SERVICE-ROLE ONLY.
-- HQ provisions numbers via the admin client (which bypasses RLS).

-- -------------------------------------------------------------------------
-- calls (EXISTING) — additive only. Never recreated.
-- -------------------------------------------------------------------------
-- Link a call to the number that routed it (nullable; SET NULL so a
-- number can be retired without deleting call history).
alter table public.calls
  add column if not exists phone_number_id uuid
  references public.phone_numbers(id) on delete set null;

create index if not exists calls_phone_number_id_idx
  on public.calls (phone_number_id);

-- Idempotent webhook replays: a Vapi call id is unique per provider.
-- PARTIAL unique (only when provider_call_id is present) so legacy rows
-- with a null provider_call_id are unaffected.
create unique index if not exists calls_provider_call_id_unique
  on public.calls (provider, provider_call_id)
  where provider_call_id is not null;
