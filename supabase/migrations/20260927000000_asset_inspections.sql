-- Asset Management — Milestone 4a: inspections (immutable execution records).
--
-- A durable, org-scoped, tamper-evident record of every inspection performed on
-- an asset — pre-use checks, LOLER/PUWER, PAT, servicing — with a pass/fail
-- OUTCOME that a later slice (M4b safety-blocking) reads through the M2 custody
-- eligibility seam to stop an unsafe asset being issued.
--
-- Reuses the Site Reports IMMUTABLE-SNAPSHOT pattern EXACTLY — no new framework:
--   content  jsonb  = mutable working answers (checklist responses, notes)
--   snapshot jsonb  = the frozen, audit/customer-visible record, materialised
--                     from `content` at ISSUE time; NULL until issued, WRITE-ONCE
--                     thereafter (a BEFORE trigger enforces it).
-- The outcome is the safety signal, so it too is frozen at issue: an issued
-- inspection MUST carry an outcome + snapshot, and neither can be rewritten.
--
-- Additive + reversible. References assets/users via typed FKs; evidence photos
-- ride the existing tenant_attachments pipeline (CHECK widened below), never a
-- new store.

create table if not exists public.asset_inspections (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  asset_id        uuid not null references public.assets(id) on delete cascade,

  -- What was inspected. `kind` is a coarse class; free-text title for M4a
  -- (reusable versioned templates arrive in M4b and seed `content`).
  title           text not null,
  kind            text
    check (kind is null or kind in
      ('pre_use', 'loler', 'puwer', 'pat', 'service', 'safety', 'other')),

  -- Does a FAIL make the asset unsafe to issue? Recorded on the record itself so
  -- the M4b safety seam acts on the FROZEN inspection, not live template config.
  safety_critical boolean not null default false,

  status          text not null default 'draft'
    check (status in ('draft', 'issued', 'superseded', 'archived')),

  -- The outcome — the safety signal. NULL until issued; REQUIRED at issue and
  -- frozen thereafter (enforced by the immutability trigger below).
  outcome         text
    check (outcome is null or outcome in ('pass', 'pass_with_defects', 'fail')),

  content         jsonb not null default '{}'::jsonb,   -- mutable working answers
  snapshot        jsonb,                                -- frozen at issue, write-once

  inspected_at    timestamp with time zone,             -- when performed
  inspected_by    uuid references public.users(id) on delete set null,
  due_at          timestamp with time zone,             -- next-due (scheduling hook, M4b)

  -- Re-inspection lineage (mirrors site_reports.revision/supersedes_id).
  revision        integer not null default 1,
  supersedes_id   uuid references public.asset_inspections(id) on delete set null,

  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

-- Lookups (indexed, no full scans).
create index if not exists asset_inspections_asset_idx
  on public.asset_inspections (asset_id, created_at desc);
create index if not exists asset_inspections_org_status_idx
  on public.asset_inspections (org_id, status);
-- The safety-seam lookup (M4b): the current issued safety-critical FAILs per asset.
create index if not exists asset_inspections_safety_idx
  on public.asset_inspections (asset_id)
  where safety_critical and status = 'issued' and outcome = 'fail';
create index if not exists asset_inspections_due_idx
  on public.asset_inspections (due_at)
  where due_at is not null and status = 'issued';

-- ── Same-org guard ────────────────────────────────────────────────────────────
-- The inspected asset (and any inspection it supersedes) must belong to the
-- row's org — a cross-tenant asset_id can never be smuggled in past RLS.
create or replace function public.tg_asset_inspections_guard()
returns trigger language plpgsql as $$
declare
  a_org uuid;
begin
  select org_id into a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.supersedes_id is not null
     and not exists (select 1 from public.asset_inspections
                     where id = new.supersedes_id and org_id = new.org_id) then
    raise exception 'superseded inspection % is not in org %', new.supersedes_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_inspections_guard on public.asset_inspections;
create trigger asset_inspections_guard before insert or update on public.asset_inspections
  for each row execute function public.tg_asset_inspections_guard();

-- ── Immutability + issue integrity ────────────────────────────────────────────
-- The heart of the milestone. Mirrors tg_site_reports_immutable and adds the
-- outcome-is-the-safety-signal invariants:
--   1. snapshot is WRITE-ONCE  — once non-null it can never change.
--   2. an ISSUED inspection MUST carry an outcome AND a snapshot.
--   3. content, outcome and safety_critical are FROZEN once issued/superseded/
--      archived (the frozen record can't be quietly re-scored).
-- Deliberately does NOT freeze status transitions (issued -> superseded) or
-- due_at (a re-inspection can schedule the next one).
create or replace function public.tg_asset_inspections_immutable()
returns trigger language plpgsql as $$
begin
  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'asset_inspections.snapshot is immutable once set (inspection %)', old.id
      using errcode = 'check_violation';
  end if;

  if new.status = 'issued' then
    if new.outcome is null then
      raise exception 'an issued inspection requires an outcome (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.snapshot is null then
      raise exception 'an issued inspection requires a snapshot (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  if old.status in ('issued', 'superseded', 'archived') then
    if new.content is distinct from old.content then
      raise exception 'asset_inspections.content is frozen after issue (inspection %, status %)',
        old.id, old.status using errcode = 'check_violation';
    end if;
    if new.outcome is distinct from old.outcome then
      raise exception 'asset_inspections.outcome is frozen after issue (inspection %, status %)',
        old.id, old.status using errcode = 'check_violation';
    end if;
    if new.safety_critical is distinct from old.safety_critical then
      raise exception 'asset_inspections.safety_critical is frozen after issue (inspection %)',
        old.id using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists asset_inspections_immutable on public.asset_inspections;
create trigger asset_inspections_immutable before update on public.asset_inspections
  for each row execute function public.tg_asset_inspections_immutable();

-- Shared updated_at trigger (reused, never duplicated).
drop trigger if exists asset_inspections_set_updated_at on public.asset_inspections;
create trigger asset_inspections_set_updated_at before update on public.asset_inspections
  for each row execute function public.tg_set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.asset_inspections enable row level security;

create policy asset_inspections_select on public.asset_inspections
  for select using (org_id in (select public.current_org_ids()));
create policy asset_inspections_insert on public.asset_inspections
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_inspections_update on public.asset_inspections
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Inspections are a compliance record; only an org admin may hard-delete.
create policy asset_inspections_delete on public.asset_inspections
  for delete using (public.is_org_admin(org_id));

-- ── Attachments: widen the universal CHECK to accept 'asset_inspections' ──────
-- Evidence photos ride the universal attachments pipeline. Widen the shared
-- CHECK by introspection, preserving EVERY prior target (never drop a vertical).
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

-- Preserve EXACTLY the current allowlist (set by 20260925_asset_assignments) and
-- append only the new target.
alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets', 'asset_assignments', 'asset_inspections'));
