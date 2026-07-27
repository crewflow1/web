-- Site Management (Stage One) — Site Reports: formal, client-ready progress
-- reports that AGGREGATE existing site information (diary, snags, toolbox talks,
-- photos) into a structured, shareable, auditable deliverable.
--
-- This migration is the DURABLE CORE (increment 1): the data model, the state
-- machine, and — most importantly — the immutability guarantees. PDF rendering,
-- the customer-portal surface, the rich per-section editor and notifications
-- layer on this foundation in later increments; none of them changes this model.
--
-- The load-bearing design decision (CEO requirement): a report separates
--   * editable DRAFT working content            -> `content`  jsonb
--   * the frozen, customer-visible SNAPSHOT      -> `snapshot` jsonb (null until issued)
-- so a historical (issued) report can NEVER silently change when the source
-- records it summarised are later edited. Enforced in the DB by a trigger, not
-- just the app.
--
-- Additive + dark + reversible: nothing reads site_reports until the pages ship.

create table if not exists public.site_reports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- The job/site the report covers. Kept (set null) if the job is later removed
  -- so the contractual record survives; the issued snapshot has already frozen
  -- the site identity anyway.
  job_id         uuid references public.jobs(id) on delete set null,
  -- Denormalised for portal scoping (which customer may see an issued report).
  customer_id    uuid references public.customers(id) on delete set null,
  report_number  text,
  title          text not null,
  period_start   date not null,
  period_end     date not null,
  -- Explicit lifecycle. Transitions are validated server-side (the action layer)
  -- and the terminal-immutability is enforced by the trigger below.
  status         text not null default 'draft'
    check (status in ('draft', 'ready_for_review', 'approved', 'issued',
                      'superseded', 'archived')),
  revision       integer not null default 1 check (revision >= 1),
  -- When a report is re-issued, the new revision points back at the one it
  -- replaces (which moves to 'superseded').
  supersedes_id  uuid references public.site_reports(id) on delete set null,
  -- Editable working content: selected source references, commentary, risks,
  -- next steps, client decisions, section text. Shaped by the app, not the DB.
  content        jsonb not null default '{}'::jsonb,
  -- The frozen customer-visible document, materialised at issue time from
  -- `content` + the resolved sources. NULL until issued; write-once thereafter.
  snapshot       jsonb,
  prepared_by    uuid references public.users(id) on delete set null,
  reviewed_by    uuid references public.users(id) on delete set null,
  approved_by    uuid references public.users(id) on delete set null,
  approved_at    timestamp with time zone,
  issued_at      timestamp with time zone,
  created_at     timestamp with time zone not null default now(),
  updated_at     timestamp with time zone not null default now()
);

create index if not exists site_reports_org_idx
  on public.site_reports (org_id, created_at desc);
create index if not exists site_reports_job_idx
  on public.site_reports (job_id) where job_id is not null;
-- Portal scope: a customer's issued reports (the surface ships in a later
-- increment; the index is cheap and the query shape is known now).
create index if not exists site_reports_portal_idx
  on public.site_reports (customer_id, status) where status = 'issued';
create index if not exists site_reports_status_idx
  on public.site_reports (org_id, status);

alter table public.site_reports enable row level security;

-- Tenant CRUD: any member of the org. (Portal/customer read is a separate,
-- issued-only path added when that surface ships — not a blanket policy here.)
create policy site_reports_select on public.site_reports
  for select using (org_id in (select public.current_org_ids()));
create policy site_reports_insert on public.site_reports
  for insert with check (org_id in (select public.current_org_ids()));
create policy site_reports_update on public.site_reports
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard delete is admin-only AND (see the action layer) draft-only: an issued
-- report is contractual evidence — supersede or archive, never silently erase.
create policy site_reports_delete on public.site_reports
  for delete using (public.is_org_admin(org_id));

drop trigger if exists site_reports_set_updated_at on public.site_reports;
create trigger site_reports_set_updated_at before update on public.site_reports
  for each row execute function public.tg_set_updated_at();

-- --------------------------------------------------------------------------
-- Immutability guarantee (CEO security requirement). Two invariants, enforced
-- at the DB so no application path — present or future, including a future AI
-- writer — can violate them:
--   1. The snapshot is WRITE-ONCE: once materialised it can never change.
--   2. Once a report is issued/superseded/archived, its `content` is FROZEN.
-- Status may still transition (e.g. issued -> superseded) and the audit columns
-- may still be set; only the customer-visible substance is locked.
create or replace function public.tg_site_reports_immutable()
returns trigger language plpgsql as $$
begin
  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'site_reports.snapshot is immutable once set (report %)', old.id
      using errcode = 'check_violation';
  end if;
  if old.status in ('issued', 'superseded', 'archived')
     and new.content is distinct from old.content then
    raise exception 'site_reports.content is frozen after issue (report %, status %)',
      old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists site_reports_immutable on public.site_reports;
create trigger site_reports_immutable before update on public.site_reports
  for each row execute function public.tg_site_reports_immutable();

-- --------------------------------------------------------------------------
-- Report-level attachments (a cover image / extra evidence beyond the source
-- records' own photos). Widen the shared tenant_attachments CHECK by
-- introspection, preserving every Site Management target already added
-- (snags, site_diary_entries, toolbox_talks) so this fourth stacked widening
-- never narrows the constraint.
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
                          'site_diary_entries', 'toolbox_talks', 'site_reports'));
