-- Asset Management (Stage One) — Milestone 1: the asset register foundation.
--
-- Every physical asset a construction firm owns or hires — vans, excavators,
-- generators, scaffolding, PPE — as one durable, org-scoped record. Built on the
-- exact proven Site Management pattern (snags/diary/toolbox/site_reports):
-- org_id + RLS via current_org_ids(), admin-only hard delete, the shared
-- tg_set_updated_at() trigger, indexes for the list + search, and images /
-- manuals / certificates via the EXISTING tenant_attachments pipeline (CHECK
-- widened to 'assets' — no new bucket).
--
-- Ownership (owned/hired) and lifecycle status (active/retired/sold/lost/stolen/
-- written_off) are separate concerns and separate columns. Suppliers reuse the
-- existing suppliers table (the supplier or hire company).
--
-- Additive + dark + reversible. Assignment, QR, inspections, maintenance and
-- document-category management are later milestones that reference THIS table;
-- they add no competing asset store.

create table if not exists public.assets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  -- Free text (sites don't share a category taxonomy); a managed category list
  -- is a later milestone. e.g. "Excavator", "Van", "Power tool", "PPE".
  category          text,
  -- Internal reference / fleet number the firm already uses.
  asset_ref         text,
  manufacturer      text,
  model             text,
  serial_number     text,
  registration      text,
  ownership         text not null default 'owned'
    check (ownership in ('owned', 'hired')),
  status            text not null default 'active'
    check (status in ('active', 'retired', 'sold', 'lost', 'stolen', 'written_off')),
  -- The supplier or hire company (reuses the existing suppliers table).
  supplier_id       uuid references public.suppliers(id) on delete set null,
  purchase_date     date,
  purchase_price    numeric(12, 2),
  current_value     numeric(12, 2),
  warranty_expires_at date,
  -- Hire window (for ownership='hired'); nullable for owned assets.
  hire_start        date,
  hire_end          date,
  hire_rate         numeric(12, 2),
  notes             text,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

-- List: this org's assets, newest first.
create index if not exists assets_org_idx
  on public.assets (org_id, created_at desc);
-- Status board (active vs. disposed).
create index if not exists assets_status_idx
  on public.assets (org_id, status);
-- Search by the identifiers a user actually types (serial / registration).
create index if not exists assets_serial_idx
  on public.assets (org_id, serial_number) where serial_number is not null;
create index if not exists assets_registration_idx
  on public.assets (org_id, registration) where registration is not null;
-- Hire expiry sweep (a future reminder cron; index is cheap now).
create index if not exists assets_hire_end_idx
  on public.assets (hire_end) where hire_end is not null;

alter table public.assets enable row level security;

create policy assets_select on public.assets
  for select using (org_id in (select public.current_org_ids()));
create policy assets_insert on public.assets
  for insert with check (org_id in (select public.current_org_ids()));
create policy assets_update on public.assets
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard delete admin-only: an asset carries purchase/finance history and is
-- audit-worthy — members retire/write-off via status, owners/admins delete.
create policy assets_delete on public.assets
  for delete using (public.is_org_admin(org_id));

drop trigger if exists assets_set_updated_at on public.assets;
create trigger assets_set_updated_at before update on public.assets
  for each row execute function public.tg_set_updated_at();

-- --------------------------------------------------------------------------
-- Asset images / manuals / certificates ride the existing universal attachments
-- pipeline. Widen the shared tenant_attachments CHECK by introspection,
-- preserving every prior target (customers … site_reports) so this stacked
-- widening never narrows the constraint.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets'));
