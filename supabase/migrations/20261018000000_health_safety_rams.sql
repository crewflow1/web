-- Health & Safety — RAMS (Risk Assessment & Method Statement).
--
-- Every UK construction task legally needs a risk assessment + a safe method of
-- work (CDM 2015). A "RAMS" is the document the site team writes before a job:
-- the activity, the hazards, how likely/severe each is, the control measures that
-- bring the risk down, and the step-by-step safe method. Once ISSUED it is a
-- legal record — it must be immutable, and a change means a new revision.
--
-- This is the operational spine: draft -> issue (frozen, numbered) -> supersede.
-- Milestone 1 = the record + its hazards. Permits-to-work and operative sign-off
-- are later milestones on their own tables.
--
-- Additive + dark + reversible: two brand-new tables nothing else reads until the
-- /health-safety pages ship on this branch. Every convention mirrors the existing
-- tenant tables (snags 20260919, purchase_orders 20261006, hq_approvals immutability):
--   - org_id tenant scoping + RLS via current_org_ids()
--   - admin-only hard delete via is_org_admin() (members withdraw instead)
--   - updated_at maintained by the shared tg_set_updated_at() trigger
--   - per-org human reference RA-NNNN allocated on issue (next_ra_number)
--   - immutability-on-issue enforced in the DB, not the app
-- Reversible: `drop table public.risk_assessment_hazards, public.risk_assessments`
-- + `drop function next_ra_number`. No existing row in any table is mutated.

-- ---------------------------------------------------------------------------
-- risk_assessments — the RAMS header
-- ---------------------------------------------------------------------------
create table if not exists public.risk_assessments (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  -- Optional link to the job/site. Nullable + set-null (keep the H&S record even
  -- if the job is later deleted). Same-org integrity is enforced by a trigger
  -- below (a set-null COMPOSITE fk would null org_id too, which is not allowed).
  job_id            uuid references public.jobs(id) on delete set null,
  -- Human reference RA-NNNN. NULL while draft; allocated per-org on issue.
  reference         text,
  title             text not null,
  -- The task/activity being assessed — "Roof tiling, Plot 4", "Groundworks".
  activity          text not null,
  location          text,
  assessor_id       uuid references public.users(id) on delete set null,
  assessment_date   date,
  -- When it must be reviewed again (RAMS are living documents).
  review_date       date,
  -- Required PPE for the task (hard hat, hi-vis, gloves...). Free-form list.
  ppe               text[] not null default '{}',
  -- The safe method of work — sequential steps as prose for v1.
  method_statement  text,
  status            text not null default 'draft'
    check (status in ('draft', 'issued', 'superseded', 'withdrawn')),
  -- Set on issue; the record is frozen from then on (see immutability trigger).
  issued_at         timestamptz,
  issued_by         uuid references public.users(id) on delete set null,
  -- If this revision superseded an earlier one (new revision on change).
  supersedes_id     uuid references public.risk_assessments(id) on delete set null,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Composite key so children can enforce tenant integrity via a composite FK.
  constraint risk_assessments_id_org_key unique (id, org_id),
  -- One live RA-NNNN per org.
  constraint risk_assessments_org_reference_key unique (org_id, reference),
  -- A reference exists iff the record has left draft.
  constraint risk_assessments_reference_when_issued
    check ((status = 'draft') = (reference is null)),
  -- Issued records must carry their issue stamp.
  constraint risk_assessments_issued_stamp
    check (status = 'draft' or issued_at is not null)
);

create index if not exists risk_assessments_org_idx     on public.risk_assessments (org_id);
create index if not exists risk_assessments_job_idx     on public.risk_assessments (job_id);
create index if not exists risk_assessments_status_idx  on public.risk_assessments (org_id, status);

-- Per-org RAMS number allocator (mirrors next_po_number). RA-0001, RA-0002 ...
-- Defined after the table it reads. A unique (org_id, reference) backstops the
-- read-max-then-increment race so a collision fails loudly instead of duplicating.
create or replace function public.next_ra_number(target_org uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select 'RA-' || lpad(
    (coalesce(max(cast(substring(reference from 'RA-(\d+)') as int)), 0) + 1)::text,
    4, '0')
  from public.risk_assessments
  where org_id = target_org and reference is not null;
$$;
grant execute on function public.next_ra_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- risk_assessment_hazards — the assessed hazards (the heart of the document)
-- ---------------------------------------------------------------------------
create table if not exists public.risk_assessment_hazards (
  id                    uuid primary key default gen_random_uuid(),
  -- Derived from the parent by trigger (client value ignored) so a caller can
  -- never anchor a hazard into another tenant.
  org_id                uuid not null,
  risk_assessment_id    uuid not null,
  hazard                text not null,
  who_at_risk           text,
  -- 5x5 matrix. Initial (uncontrolled) risk.
  likelihood            smallint not null check (likelihood between 1 and 5),
  severity              smallint not null check (severity between 1 and 5),
  risk_rating           smallint generated always as (likelihood * severity) stored,
  control_measures      text not null,
  -- Residual (post-control) risk. Optional but both-or-neither (checked).
  residual_likelihood   smallint check (residual_likelihood between 1 and 5),
  residual_severity     smallint check (residual_severity between 1 and 5),
  residual_rating       smallint generated always as (residual_likelihood * residual_severity) stored,
  sort_order            int not null default 0,
  created_at            timestamptz not null default now(),
  -- Tenant integrity: the hazard's (parent, org) must match a real parent row in
  -- the same org (blueprint_pins composite-FK doctrine). Cascade so deleting a
  -- draft RA removes its hazards.
  constraint rah_parent_org_fk
    foreign key (risk_assessment_id, org_id)
    references public.risk_assessments (id, org_id) on delete cascade,
  constraint rah_residual_both_or_neither
    check ((residual_likelihood is null) = (residual_severity is null))
);

create index if not exists rah_parent_idx on public.risk_assessment_hazards (risk_assessment_id);
create index if not exists rah_org_idx     on public.risk_assessment_hazards (org_id);

-- ---------------------------------------------------------------------------
-- Trigger: derive a hazard's org_id from its parent RA (never trust the client)
-- ---------------------------------------------------------------------------
create or replace function public.tg_rah_derive_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
  parent_status text;
begin
  select org_id, status into parent_org, parent_status
  from public.risk_assessments where id = new.risk_assessment_id;
  if parent_org is null then
    raise exception 'risk_assessment % not found', new.risk_assessment_id;
  end if;
  -- Hazards can only be attached to / changed on a DRAFT assessment. Once issued
  -- the document (and its hazards) is frozen.
  if parent_status <> 'draft' then
    raise exception 'cannot modify hazards of a % risk assessment (issued records are immutable)', parent_status;
  end if;
  new.org_id := parent_org;
  return new;
end;
$$;

create trigger tg_rah_derive_org_ins
  before insert on public.risk_assessment_hazards
  for each row execute function public.tg_rah_derive_org();

create trigger tg_rah_derive_org_upd
  before update on public.risk_assessment_hazards
  for each row execute function public.tg_rah_derive_org();

-- Deleting a hazard from an ISSUED assessment must also be blocked.
create or replace function public.tg_rah_block_delete_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_status text;
begin
  select status into parent_status
  from public.risk_assessments where id = old.risk_assessment_id;
  -- parent_status null = parent already gone (cascade) → allow.
  if parent_status is not null and parent_status <> 'draft' then
    raise exception 'cannot delete a hazard from a % risk assessment (issued records are immutable)', parent_status;
  end if;
  return old;
end;
$$;

create trigger tg_rah_block_delete_when_issued
  before delete on public.risk_assessment_hazards
  for each row execute function public.tg_rah_block_delete_when_issued();

-- ---------------------------------------------------------------------------
-- Trigger: same-org integrity for the optional job link
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_validate_job_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  job_org uuid;
begin
  if new.job_id is not null then
    select org_id into job_org from public.jobs where id = new.job_id;
    if job_org is null or job_org <> new.org_id then
      raise exception 'job % does not belong to this organisation', new.job_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger tg_ra_validate_job_org
  before insert or update on public.risk_assessments
  for each row execute function public.tg_ra_validate_job_org();

-- ---------------------------------------------------------------------------
-- Trigger: immutability-on-issue for the header
--   draft   -> may edit anything, or move to issued
--   issued  -> only status may change, and only to superseded/withdrawn
--   superseded/withdrawn -> terminal, no further change
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_immutable_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'draft' then
    return new;  -- drafts are freely editable (incl. the transition to issued)
  end if;

  -- From a non-draft state only the lifecycle status may move, and only forward.
  if new.status is distinct from old.status then
    if old.status = 'issued' and new.status in ('superseded', 'withdrawn') then
      null;  -- allowed lifecycle transition
    else
      raise exception 'invalid RAMS status transition % -> %', old.status, new.status;
    end if;
  end if;

  -- Every content column must be unchanged on a non-draft record.
  if (new.title, new.activity, new.location, new.job_id, new.reference,
      new.assessor_id, new.assessment_date, new.review_date, new.ppe,
      new.method_statement, new.issued_at, new.issued_by, new.supersedes_id)
     is distinct from
     (old.title, old.activity, old.location, old.job_id, old.reference,
      old.assessor_id, old.assessment_date, old.review_date, old.ppe,
      old.method_statement, old.issued_at, old.issued_by, old.supersedes_id)
  then
    raise exception 'a % risk assessment is immutable; raise a new revision instead', old.status;
  end if;

  return new;
end;
$$;

create trigger tg_ra_immutable_when_issued
  before update on public.risk_assessments
  for each row execute function public.tg_ra_immutable_when_issued();

-- updated_at maintenance (shared helper).
create trigger set_updated_at
  before update on public.risk_assessments
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — tenant isolation (mirrors snags / purchase_orders)
-- ---------------------------------------------------------------------------
alter table public.risk_assessments        enable row level security;
alter table public.risk_assessment_hazards enable row level security;

-- risk_assessments: members of the org read/write; only admins hard-delete.
create policy risk_assessments_select on public.risk_assessments
  for select using (org_id in (select public.current_org_ids()));
create policy risk_assessments_insert on public.risk_assessments
  for insert with check (org_id in (select public.current_org_ids()));
create policy risk_assessments_update on public.risk_assessments
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy risk_assessments_delete on public.risk_assessments
  for delete using (public.is_org_admin(org_id));

-- hazards: same org gate; org_id is trigger-derived so insert check is org membership.
create policy rah_select on public.risk_assessment_hazards
  for select using (org_id in (select public.current_org_ids()));
create policy rah_insert on public.risk_assessment_hazards
  for insert with check (org_id in (select public.current_org_ids()));
create policy rah_update on public.risk_assessment_hazards
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy rah_delete on public.risk_assessment_hazards
  for delete using (org_id in (select public.current_org_ids()));
