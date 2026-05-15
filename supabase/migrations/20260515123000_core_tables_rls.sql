-- Phase 2 of CrewFlow: core domain tables + multi-tenant RLS.
--
-- Tables: jobs, customers, quotes, quote_line_items.
-- Tenancy: every row scoped to organizations(id) via org_id (NOT NULL).
-- RLS posture:
--   - SELECT / INSERT / UPDATE: any member of the org.
--   - DELETE: admins/owners only (safety default).
--   - jobs UPDATE: admins/owners only (per spec).
--
-- Idempotent: re-running is safe. Tables use IF NOT EXISTS; policies are
-- dropped before recreate; indexes use IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- shared trigger: bump updated_at on row update
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
-- ---------------------------------------------------------------------------
create or replace function public.current_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- helper: is current user an admin/owner of the given org?
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

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete restrict,
  name        text not null,
  email       text,
  phone       text,
  -- jsonb shape: { line1, line2, city, postcode, country }
  -- postcode is the field used for UK locality matching (see onboarding flow)
  address     jsonb,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists customers_org_id_idx on public.customers (org_id);
drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at before update on public.customers
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete restrict,
  customer_id     uuid not null references public.customers(id) on delete restrict,
  -- nullable so unassigned jobs are representable; SET NULL if user leaves org
  assigned_to     uuid references public.users(id) on delete set null,
  status          text not null default 'new'
    check (status in ('new', 'in-progress', 'completed', 'blocked')),
  scheduled_date  date,
  -- Supabase Storage object paths (under jobs bucket — to be created in Phase 4)
  photos          text[] not null default '{}',
  notes           text,
  -- Phase 5: Anthropic/OpenAI-generated summary
  ai_summary      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists jobs_org_id_idx        on public.jobs (org_id);
create index if not exists jobs_org_status_idx    on public.jobs (org_id, status);
create index if not exists jobs_org_scheduled_idx on public.jobs (org_id, scheduled_date);
create index if not exists jobs_customer_idx     on public.jobs (customer_id);
create index if not exists jobs_assigned_to_idx  on public.jobs (assigned_to);
drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- quotes — amounts stored in major units (£) as numeric(12,2)
-- ---------------------------------------------------------------------------
create table if not exists public.quotes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete restrict,
  -- nullable: quotes may exist standalone before a job is created
  job_id       uuid references public.jobs(id) on delete set null,
  customer_id  uuid not null references public.customers(id) on delete restrict,
  status       text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  subtotal     numeric(12,2) not null default 0,
  vat_total    numeric(12,2) not null default 0,
  total        numeric(12,2) not null default 0,
  currency     text not null default 'GBP',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists quotes_org_id_idx      on public.quotes (org_id);
create index if not exists quotes_job_id_idx      on public.quotes (job_id);
create index if not exists quotes_customer_id_idx on public.quotes (customer_id);
drop trigger if exists quotes_set_updated_at on public.quotes;
create trigger quotes_set_updated_at before update on public.quotes
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- quote_line_items — CASCADE on parent delete; default 20% UK VAT
-- ---------------------------------------------------------------------------
create table if not exists public.quote_line_items (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  description  text not null,
  quantity     numeric(12,3) not null default 1,
  unit_price   numeric(12,2) not null default 0,
  -- line_total = quantity * unit_price (ex-VAT); stored for query simplicity
  line_total   numeric(12,2) not null default 0,
  -- UK rates: 20.00 standard, 5.00 reduced, 0.00 zero-rated
  vat_rate     numeric(5,2) not null default 20.00,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists quote_line_items_quote_id_idx on public.quote_line_items (quote_id);
drop trigger if exists quote_line_items_set_updated_at on public.quote_line_items;
create trigger quote_line_items_set_updated_at before update on public.quote_line_items
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- enable RLS
-- ---------------------------------------------------------------------------
alter table public.customers        enable row level security;
alter table public.jobs             enable row level security;
alter table public.quotes           enable row level security;
alter table public.quote_line_items enable row level security;

-- ---------------------------------------------------------------------------
-- customers — members CRUD; admins delete
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- jobs — members select/insert; admins update/delete (per spec)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- quotes — members CRUD; admins delete
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- quote_line_items — gated via parent quote's org
-- ---------------------------------------------------------------------------
drop policy if exists "quote_line_items: members can select" on public.quote_line_items;
create policy "quote_line_items: members can select" on public.quote_line_items for select to authenticated
using (exists (
  select 1 from public.quotes q
  where q.id = quote_line_items.quote_id
    and q.org_id in (select public.current_org_ids())
));

drop policy if exists "quote_line_items: members can insert" on public.quote_line_items;
create policy "quote_line_items: members can insert" on public.quote_line_items for insert to authenticated
with check (exists (
  select 1 from public.quotes q
  where q.id = quote_line_items.quote_id
    and q.org_id in (select public.current_org_ids())
));

drop policy if exists "quote_line_items: members can update" on public.quote_line_items;
create policy "quote_line_items: members can update" on public.quote_line_items for update to authenticated
using (exists (
  select 1 from public.quotes q
  where q.id = quote_line_items.quote_id
    and q.org_id in (select public.current_org_ids())
))
with check (exists (
  select 1 from public.quotes q
  where q.id = quote_line_items.quote_id
    and q.org_id in (select public.current_org_ids())
));

drop policy if exists "quote_line_items: members can delete" on public.quote_line_items;
create policy "quote_line_items: members can delete" on public.quote_line_items for delete to authenticated
using (exists (
  select 1 from public.quotes q
  where q.id = quote_line_items.quote_id
    and q.org_id in (select public.current_org_ids())
));
