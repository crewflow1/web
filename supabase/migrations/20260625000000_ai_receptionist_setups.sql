-- =========================================================================
-- ai_receptionist_setups — white-glove AI receptionist onboarding (Wave 9).
--
-- The customer toggles "Enable AI Receptionist?" during onboarding (or
-- later in /settings). When enabled, they fill in channel handles and
-- preferences. A row in this table is the "ticket" that a founder /
-- super-admin manually works through to configure Twilio + Meta etc.
--
-- Status lifecycle (set by HQ):
--   not_started  → customer enabled but nothing actioned yet
--   in_progress  → HQ has started provisioning
--   testing      → channels wired up, running the checklist
--   live         → fully configured + every checklist item ticked
--
-- The customer only sees a derived "Pending" / "Live" badge based on
-- whether status='live'.
--
-- Test checklist columns capture the manual verification HQ performed
-- (timestamps per check). Once all six are populated, status can move
-- to 'live'.
--
-- RLS:
--   - org members SELECT their own org's row (so they see the badge).
--   - only org admin/owner UPDATE (toggles + channel fields).
--   - status + checklist + configured_at/configured_by are HQ-only —
--     gated at the application layer (super-admin client) since RLS
--     can't easily distinguish per-column writes.
-- =========================================================================

create table if not exists public.ai_receptionist_setups (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- Customer-side: enable toggle.
  enabled         boolean not null default false,
  -- Customer-collected channel handles + preferences.
  business_phone  text,
  whatsapp_number text,
  facebook_page   text,
  instagram_handle text,
  preferred_voice text,
  business_hours  text,
  trade_type      text,
  -- HQ-side: lifecycle + verification.
  status          text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'testing', 'live')),
  test_call_at        timestamp with time zone,
  test_sms_at         timestamp with time zone,
  test_whatsapp_at    timestamp with time zone,
  test_meta_at        timestamp with time zone,
  test_voice_at       timestamp with time zone,
  test_lead_at        timestamp with time zone,
  configured_at   timestamp with time zone,
  configured_by   uuid references public.users(id) on delete set null,
  hq_notes        text,
  -- One row per org. Customers can update the channel fields multiple
  -- times; HQ overwrites the test stamps as it works through them.
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
create unique index if not exists ai_receptionist_setups_org_unique
  on public.ai_receptionist_setups (org_id);
create index if not exists ai_receptionist_setups_status_idx
  on public.ai_receptionist_setups (status, created_at desc);

drop trigger if exists tg_ai_receptionist_setups_updated_at
  on public.ai_receptionist_setups;
create trigger tg_ai_receptionist_setups_updated_at
  before update on public.ai_receptionist_setups
  for each row execute function public.tg_set_updated_at();

alter table public.ai_receptionist_setups enable row level security;

-- Org members can SEE their own row (so /settings can render the
-- badge + form defaults).
drop policy if exists ai_receptionist_setups_select on public.ai_receptionist_setups;
create policy ai_receptionist_setups_select on public.ai_receptionist_setups
  for select using (org_id in (select public.current_org_ids()));

-- Org admins/owners can INSERT (enable + initial save).
drop policy if exists ai_receptionist_setups_insert on public.ai_receptionist_setups;
create policy ai_receptionist_setups_insert on public.ai_receptionist_setups
  for insert with check (public.is_org_admin(org_id));

-- Org admins/owners can UPDATE their org's row (channel fields).
-- HQ-only fields (status/test_*/configured_*) are protected at the
-- application layer; the service role bypasses RLS for those writes.
drop policy if exists ai_receptionist_setups_update on public.ai_receptionist_setups;
create policy ai_receptionist_setups_update on public.ai_receptionist_setups
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- No DELETE policy — once a setup row is created, it persists. HQ
-- handles edge cases via the service role.
