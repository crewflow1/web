-- Additive migration: introduce the jobs table and close the RLS-policy gap on
-- existing tenant tables.
--
-- Touches:
--   - functions:  tg_set_updated_at (create), current_org_ids (replace),
--                 is_org_admin (new)
--   - new table:  public.jobs  (org-scoped, links to customers + users)
--   - new policies on: jobs, customers, properties, leads, conversations,
--                       messages, calls, missed_call_textbacks, voice_notes,
--                       service_catalog, quotes, quote_line_items
--   - waitlist is intentionally NOT touched — it's a public-signup form whose
--     access pattern (anon insert) needs a separate decision.
--
-- RLS posture:
--   - SELECT/INSERT/UPDATE: any member of the org
--   - DELETE: admins/owners only
--   - jobs UPDATE: admins/owners only (per Phase-2 spec)
--
-- Quote linkage: prod quotes link to lead_id (NOT job_id) — we do not change
-- that here. jobs is a parallel post-quote-acceptance entity.
--
-- Idempotent: re-running is safe. Tables use IF NOT EXISTS, policies are
-- dropped before recreate, indexes use IF NOT EXISTS, functions use OR REPLACE.

-- ---------------------------------------------------------------------------
-- helper function: bump updated_at on row update
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- helper: org_ids the current user is a member of
-- security definer so policies can SELECT from memberships without hitting
-- memberships' own RLS recursively.
-- ---------------------------------------------------------------------------
create or replace function public.current_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- helper: is current user an admin/owner of the given org?
-- 'owner' is the role inserted by the bootstrap flow; 'admin' is reserved
-- for future role promotion.
-- ---------------------------------------------------------------------------
create or replace function public.is_org_admin(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid()
      and org_id = target_org
      and role in ('owner', 'admin')
  );
$$;

-- ===========================================================================
-- jobs (new table)
-- ===========================================================================
create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL on customer delete: keep job records for audit even
  -- if a customer is removed (GDPR or merge). Pattern matches leads.customer_id.
  customer_id     uuid references public.customers(id) on delete set null,
  -- nullable + SET NULL on user delete: unassigned jobs are valid, and staff
  -- can leave the org without orphaning work history.
  assigned_to     uuid references public.users(id) on delete set null,
  status          text not null default 'new'
    check (status in ('new', 'in-progress', 'completed', 'blocked')),
  scheduled_date  date,
  -- Supabase Storage object paths under the jobs bucket (bucket TBD).
  photos          text[] not null default '{}',
  notes           text,
  -- Phase 5: Anthropic/OpenAI-generated job summary.
  ai_summary      text,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

create index if not exists jobs_org_id_idx        on public.jobs (org_id);
create index if not exists jobs_org_status_idx    on public.jobs (org_id, status);
create index if not exists jobs_org_scheduled_idx on public.jobs (org_id, scheduled_date);
create index if not exists jobs_customer_idx     on public.jobs (customer_id);
create index if not exists jobs_assigned_to_idx  on public.jobs (assigned_to);

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.tg_set_updated_at();

alter table public.jobs enable row level security;

drop policy if exists "jobs: members can select" on public.jobs;
create policy "jobs: members can select" on public.jobs for select to authenticated
using (org_id in (select public.current_org_ids()));

drop policy if exists "jobs: members can insert" on public.jobs;
create policy "jobs: members can insert" on public.jobs for insert to authenticated
with check (org_id in (select public.current_org_ids()));

drop policy if exists "jobs: admins can update" on public.jobs;
create policy "jobs: admins can update" on public.jobs for update to authenticated
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

drop policy if exists "jobs: admins can delete" on public.jobs;
create policy "jobs: admins can delete" on public.jobs for delete to authenticated
using (public.is_org_admin(org_id));

-- ===========================================================================
-- RLS policies for existing org-scoped tables that have RLS enabled but no
-- policies (effectively default-deny right now). All follow the same pattern:
-- members can SELECT/INSERT/UPDATE rows for their org; admins can DELETE.
-- ===========================================================================

-- customers ----------------------------------------------------------------
drop policy if exists "customers: members can select" on public.customers;
create policy "customers: members can select" on public.customers for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "customers: members can insert" on public.customers;
create policy "customers: members can insert" on public.customers for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "customers: members can update" on public.customers;
create policy "customers: members can update" on public.customers for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "customers: admins can delete" on public.customers;
create policy "customers: admins can delete" on public.customers for delete to authenticated
using (public.is_org_admin(org_id));

-- properties ---------------------------------------------------------------
drop policy if exists "properties: members can select" on public.properties;
create policy "properties: members can select" on public.properties for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "properties: members can insert" on public.properties;
create policy "properties: members can insert" on public.properties for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "properties: members can update" on public.properties;
create policy "properties: members can update" on public.properties for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "properties: admins can delete" on public.properties;
create policy "properties: admins can delete" on public.properties for delete to authenticated
using (public.is_org_admin(org_id));

-- leads --------------------------------------------------------------------
drop policy if exists "leads: members can select" on public.leads;
create policy "leads: members can select" on public.leads for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "leads: members can insert" on public.leads;
create policy "leads: members can insert" on public.leads for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "leads: members can update" on public.leads;
create policy "leads: members can update" on public.leads for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "leads: admins can delete" on public.leads;
create policy "leads: admins can delete" on public.leads for delete to authenticated
using (public.is_org_admin(org_id));

-- conversations ------------------------------------------------------------
drop policy if exists "conversations: members can select" on public.conversations;
create policy "conversations: members can select" on public.conversations for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "conversations: members can insert" on public.conversations;
create policy "conversations: members can insert" on public.conversations for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "conversations: members can update" on public.conversations;
create policy "conversations: members can update" on public.conversations for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "conversations: admins can delete" on public.conversations;
create policy "conversations: admins can delete" on public.conversations for delete to authenticated
using (public.is_org_admin(org_id));

-- messages -----------------------------------------------------------------
drop policy if exists "messages: members can select" on public.messages;
create policy "messages: members can select" on public.messages for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "messages: members can insert" on public.messages;
create policy "messages: members can insert" on public.messages for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "messages: members can update" on public.messages;
create policy "messages: members can update" on public.messages for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "messages: admins can delete" on public.messages;
create policy "messages: admins can delete" on public.messages for delete to authenticated
using (public.is_org_admin(org_id));

-- calls --------------------------------------------------------------------
drop policy if exists "calls: members can select" on public.calls;
create policy "calls: members can select" on public.calls for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "calls: members can insert" on public.calls;
create policy "calls: members can insert" on public.calls for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "calls: members can update" on public.calls;
create policy "calls: members can update" on public.calls for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "calls: admins can delete" on public.calls;
create policy "calls: admins can delete" on public.calls for delete to authenticated
using (public.is_org_admin(org_id));

-- missed_call_textbacks ----------------------------------------------------
drop policy if exists "missed_call_textbacks: members can select" on public.missed_call_textbacks;
create policy "missed_call_textbacks: members can select" on public.missed_call_textbacks for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "missed_call_textbacks: members can insert" on public.missed_call_textbacks;
create policy "missed_call_textbacks: members can insert" on public.missed_call_textbacks for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "missed_call_textbacks: members can update" on public.missed_call_textbacks;
create policy "missed_call_textbacks: members can update" on public.missed_call_textbacks for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "missed_call_textbacks: admins can delete" on public.missed_call_textbacks;
create policy "missed_call_textbacks: admins can delete" on public.missed_call_textbacks for delete to authenticated
using (public.is_org_admin(org_id));

-- voice_notes --------------------------------------------------------------
drop policy if exists "voice_notes: members can select" on public.voice_notes;
create policy "voice_notes: members can select" on public.voice_notes for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "voice_notes: members can insert" on public.voice_notes;
create policy "voice_notes: members can insert" on public.voice_notes for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "voice_notes: members can update" on public.voice_notes;
create policy "voice_notes: members can update" on public.voice_notes for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "voice_notes: admins can delete" on public.voice_notes;
create policy "voice_notes: admins can delete" on public.voice_notes for delete to authenticated
using (public.is_org_admin(org_id));

-- service_catalog ----------------------------------------------------------
drop policy if exists "service_catalog: members can select" on public.service_catalog;
create policy "service_catalog: members can select" on public.service_catalog for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "service_catalog: members can insert" on public.service_catalog;
create policy "service_catalog: members can insert" on public.service_catalog for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "service_catalog: members can update" on public.service_catalog;
create policy "service_catalog: members can update" on public.service_catalog for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "service_catalog: admins can delete" on public.service_catalog;
create policy "service_catalog: admins can delete" on public.service_catalog for delete to authenticated
using (public.is_org_admin(org_id));

-- quotes -------------------------------------------------------------------
drop policy if exists "quotes: members can select" on public.quotes;
create policy "quotes: members can select" on public.quotes for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "quotes: members can insert" on public.quotes;
create policy "quotes: members can insert" on public.quotes for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "quotes: members can update" on public.quotes;
create policy "quotes: members can update" on public.quotes for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "quotes: admins can delete" on public.quotes;
create policy "quotes: admins can delete" on public.quotes for delete to authenticated
using (public.is_org_admin(org_id));

-- quote_line_items ---------------------------------------------------------
-- quote_line_items has its own org_id column (denormalized from parent quote).
drop policy if exists "quote_line_items: members can select" on public.quote_line_items;
create policy "quote_line_items: members can select" on public.quote_line_items for select to authenticated
using (org_id in (select public.current_org_ids()));
drop policy if exists "quote_line_items: members can insert" on public.quote_line_items;
create policy "quote_line_items: members can insert" on public.quote_line_items for insert to authenticated
with check (org_id in (select public.current_org_ids()));
drop policy if exists "quote_line_items: members can update" on public.quote_line_items;
create policy "quote_line_items: members can update" on public.quote_line_items for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));
drop policy if exists "quote_line_items: admins can delete" on public.quote_line_items;
create policy "quote_line_items: admins can delete" on public.quote_line_items for delete to authenticated
using (public.is_org_admin(org_id));
