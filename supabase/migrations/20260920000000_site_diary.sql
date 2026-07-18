-- Site Management (Stage One) — Daily Site Diary.
--
-- A dated log of what happened on a job/site each day: weather, how many were on
-- site, what got done, any delays, and notes — the record a builder keeps for
-- progress, disputes, and handover. Second vertical in the Site Management
-- cluster, mirroring snags (20260919000000) verbatim: org-scoped RLS via
-- current_org_ids(), admin-only hard delete, shared tg_set_updated_at() trigger,
-- photos via the universal tenant_attachments pipeline.
--
-- Additive and dark: nothing reads this table until the /diary pages ship on
-- this branch. Reversible: drop the table + narrow the tenant_attachments CHECK.

create table if not exists public.site_diary_entries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- The job/site this entry logs. Nullable + on delete set null: a diary entry
  -- is a historical record and outlives the job it referenced.
  job_id        uuid references public.jobs(id) on delete set null,
  -- The day being logged. Defaults to today; one org can have many per day
  -- (different sites), so this is not unique.
  entry_date    date not null default current_date,
  -- Free text — sites don't share a weather taxonomy ("Dry am, heavy rain pm").
  weather       text,
  -- Headcount on site. Nullable; >= 0 when present.
  labour_count  integer check (labour_count is null or labour_count >= 0),
  -- What was done that day (the substance of the entry).
  work_summary  text,
  -- Any delays / stoppages / issues (drives disputes + handover evidence).
  delays        text,
  notes         text,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

-- List query: this org's entries, most recent day first.
create index if not exists site_diary_entries_org_idx
  on public.site_diary_entries (org_id, entry_date desc, created_at desc);
-- Per-job "diary for this site" lookup (job-detail integration, fast-follow).
create index if not exists site_diary_entries_job_idx
  on public.site_diary_entries (job_id) where job_id is not null;

alter table public.site_diary_entries enable row level security;

-- Tenant CRUD: any member of the org, scoped to current_org_ids().
create policy site_diary_entries_select on public.site_diary_entries
  for select using (org_id in (select public.current_org_ids()));
create policy site_diary_entries_insert on public.site_diary_entries
  for insert with check (org_id in (select public.current_org_ids()));
create policy site_diary_entries_update on public.site_diary_entries
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard delete is admin-only: a site diary is legal/handover evidence.
create policy site_diary_entries_delete on public.site_diary_entries
  for delete using (public.is_org_admin(org_id));

drop trigger if exists site_diary_entries_set_updated_at on public.site_diary_entries;
create trigger site_diary_entries_set_updated_at before update on public.site_diary_entries
  for each row execute function public.tg_set_updated_at();

-- --------------------------------------------------------------------------
-- Let diary entries carry photos through the universal attachments pipeline,
-- exactly as snags do (20260919000000). Widen the tenant_attachments
-- target_table CHECK by introspection so we never leave two overlapping checks.
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
                          'site_diary_entries'));
