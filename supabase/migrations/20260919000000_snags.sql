-- Site Management (Stage One) — Snagging / defect tracking.
--
-- A "snag" is a construction defect found on site: a cracked tile, a missing
-- seal, a socket wired wrong. Firms track them from first-spotted through to
-- signed-off so nothing slips before handover. This table is the operational
-- spine — log -> prioritise -> assign -> fix -> verify — with per-snag photos
-- carried by the EXISTING universal tenant_attachments pipeline (no new bucket).
--
-- Additive and dark: a brand-new table nothing else reads until the /snags
-- pages ship on this branch. Every convention mirrors the existing tenant
-- tables (jobs — 20260515150000, compliance_documents — 20260623000000):
--   - org_id tenant scoping + RLS via current_org_ids()
--   - admin-only hard delete via is_org_admin() (members set 'wont_fix' instead)
--   - updated_at maintained by the shared tg_set_updated_at() trigger
--   - indexed for the list + per-job queries it powers
--
-- Reversible: `drop table public.snags` and narrow the tenant_attachments CHECK
-- back. No existing row in any table is mutated by this migration.

create table if not exists public.snags (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- The job/site this defect belongs to. Nullable: a snag can be logged before
  -- it's linked, and if the job is later deleted we KEEP the defect record
  -- (set null) rather than lose the history.
  job_id        uuid references public.jobs(id) on delete set null,
  title         text not null,
  description   text,
  -- Where on site — "Kitchen, north wall", "Plot 4 ensuite". Free text; sites
  -- don't share a location taxonomy.
  location      text,
  -- Responsible trade — "Plumbing", "Electrical". Free text for the same reason.
  trade         text,
  priority      text not null default 'medium'
    check (priority in ('low', 'medium', 'high')),
  -- Lifecycle: open -> in_progress -> fixed -> verified (signed off). 'wont_fix'
  -- dismisses. verified + wont_fix are terminal and drive resolved_at.
  status        text not null default 'open'
    check (status in ('open', 'in_progress', 'fixed', 'verified', 'wont_fix')),
  assigned_to   uuid references public.users(id) on delete set null,
  reported_by   uuid references public.users(id) on delete set null,
  due_date      date,
  -- Stamped when the snag first enters a terminal status; cleared on reopen.
  resolved_at   timestamp with time zone,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

-- The list query is: this org's snags, newest first, optionally filtered by
-- status/priority. A composite (org_id, created_at desc) covers it.
create index if not exists snags_org_idx
  on public.snags (org_id, created_at desc);
-- The per-job "snags on this job" lookup (job-detail integration, fast-follow).
create index if not exists snags_job_idx
  on public.snags (job_id) where job_id is not null;
-- Open-work board: cheap "what's still outstanding for this org".
create index if not exists snags_open_idx
  on public.snags (org_id, status) where status in ('open', 'in_progress', 'fixed');

alter table public.snags enable row level security;

-- Tenant CRUD: any member of the org, scoped to current_org_ids() — exactly
-- like jobs and compliance_documents.
create policy snags_select on public.snags
  for select using (org_id in (select public.current_org_ids()));
create policy snags_insert on public.snags
  for insert with check (org_id in (select public.current_org_ids()));
create policy snags_update on public.snags
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard delete is admin-only: a defect log is audit-worthy, so members dismiss
-- via status='wont_fix' rather than erase. Mirrors compliance_documents_delete.
create policy snags_delete on public.snags
  for delete using (public.is_org_admin(org_id));

-- updated_at maintenance — the shared trigger fn from 20260515150000.
drop trigger if exists snags_set_updated_at on public.snags;
create trigger snags_set_updated_at before update on public.snags
  for each row execute function public.tg_set_updated_at();

-- --------------------------------------------------------------------------
-- Let snags carry photos through the EXISTING universal attachments pipeline
-- (tenant_attachments + the 'tenant-attachments' bucket). The bucket's storage
-- RLS keys on the org-id path prefix, not target_table (20260626000000), so
-- widening this CHECK is the ONLY change needed — no new bucket, no new storage
-- policy. Widening an IN-list CHECK is additive: every existing row still
-- satisfies it.
--
-- Drop the existing single-column check by introspection: the inline check from
-- 20260623000000 has an auto-generated name, and resolving it defensively means
-- we never end up with two overlapping CHECKs (which would silently reject the
-- new 'snags' value).
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
                          'suppliers', 'memberships', 'leads', 'snags'));
