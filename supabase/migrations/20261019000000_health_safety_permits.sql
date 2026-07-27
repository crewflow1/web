-- Health & Safety — Permits-to-Work (M2).
--
-- High-risk construction tasks (hot works, confined space, working at height,
-- excavation, electrical isolation…) need a PERMIT: a controlled, time-bound
-- authorisation that says "this specific work, in this place, is safe to start
-- now — the controls are in place and confirmed". A permit is an operational
-- RECORD, not legal advice; it references the relevant RAMS and carries the
-- control conditions that must be confirmed before it can be issued.
--
-- Lifecycle: draft -> issued -> active -> (suspended <-> active) -> closed;
-- cancel from any live state; EXPIRY is DERIVED at read (valid_until < now),
-- never a stored state and never a cron — a permit past its window is simply not
-- valid. Contractual/safety fields freeze on issue (evidence-grade).
--
-- Additive + dark + reversible. Conventions mirror the RAMS tables (20261018) +
-- snags/purchase_orders. Reversible: drop the two tables + next_ptw_number.

-- ---------------------------------------------------------------------------
-- permits_to_work — the permit header
-- ---------------------------------------------------------------------------
create table if not exists public.permits_to_work (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  -- The job/site. Nullable + set-null (keep the record for audit); same-org
  -- integrity enforced by trigger (a set-null composite FK would null org_id).
  job_id                 uuid references public.jobs(id) on delete set null,
  -- The RAMS this permit works under. Same-org AND (if the permit is job-scoped)
  -- same-job — enforced by trigger.
  risk_assessment_id     uuid references public.risk_assessments(id) on delete set null,
  reference              text,  -- PTW-NNNN, allocated per-org on issue
  permit_type            text not null
    check (permit_type in (
      'hot_works', 'working_at_height', 'confined_space', 'excavation',
      'electrical_isolation', 'roof_work', 'temporary_works', 'lifting_operations',
      'demolition', 'asbestos', 'general')),
  title                  text not null,
  scope                  text not null,           -- description of the work
  location               text,
  responsible_person     text,                    -- named person in charge on site
  -- Isolation / emergency detail (LOTO points, rescue plan) — free text for v1.
  isolation_details      text,
  emergency_arrangements text,
  -- Validity window. valid_until > valid_from (CHECK). A permit is only valid
  -- BETWEEN these instants; "expired" is derived from valid_until vs now().
  valid_from             timestamptz,
  valid_until            timestamptz,
  status                 text not null default 'draft'
    check (status in ('draft', 'issued', 'active', 'suspended', 'closed', 'cancelled')),
  closeout_notes         text,
  issued_by              uuid references public.users(id) on delete set null,
  issued_at              timestamptz,
  activated_at           timestamptz,
  suspended_at           timestamptz,
  closed_at              timestamptz,
  cancelled_at           timestamptz,
  created_by             uuid references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint permits_id_org_key unique (id, org_id),
  constraint permits_org_reference_key unique (org_id, reference),
  -- A reference exists for every state that has been issued; draft and a
  -- draft-that-was-cancelled (never issued) may have none.
  constraint permits_reference_when_issued
    check (status in ('draft', 'cancelled') or reference is not null),
  constraint permits_issued_stamp
    check (status in ('draft', 'cancelled') or issued_at is not null),
  -- Validity window is ordered when both are present…
  constraint permits_valid_window check (valid_from is null or valid_until is null or valid_until > valid_from),
  -- …and a LIVE permit (issued/active/suspended/closed) MUST carry a full window,
  -- so a permit can never be issued open-ended and therefore never expire (P1-4).
  constraint permits_window_required_when_live
    check (status in ('draft', 'cancelled') or (valid_from is not null and valid_until is not null))
);

create index if not exists permits_org_idx    on public.permits_to_work (org_id);
create index if not exists permits_job_idx     on public.permits_to_work (job_id);
create index if not exists permits_ra_idx      on public.permits_to_work (risk_assessment_id);
create index if not exists permits_status_idx  on public.permits_to_work (org_id, status);
-- Supports the "expiring / expired" dashboard scans without a full-table read.
create index if not exists permits_valid_until_idx on public.permits_to_work (org_id, valid_until)
  where status in ('issued', 'active');

-- Per-org PTW-NNNN allocator. SECURITY DEFINER, so it must gate the caller to
-- their own org (else a member could probe another org's permit count).
create or replace function public.next_ptw_number(target_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_num int;
begin
  if target_org not in (select public.current_org_ids()) then
    raise exception 'forbidden: not a member of organisation %', target_org;
  end if;
  select coalesce(max(cast(substring(reference from 'PTW-(\d+)') as int)), 0) + 1
    into next_num
  from public.permits_to_work
  where org_id = target_org and reference is not null;
  return 'PTW-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_ptw_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- permit_conditions — the control checks that gate issue (fire watch, isolation
-- confirmed, gas test, edge protection, rescue plan, PPE, exclusion zone…)
-- ---------------------------------------------------------------------------
create table if not exists public.permit_conditions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,           -- trigger-derived from the parent
  permit_id     uuid not null,
  label         text not null,
  required      boolean not null default true,
  confirmed     boolean not null default false,
  confirmed_by  uuid references public.users(id) on delete set null,
  confirmed_at  timestamptz,
  notes         text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  -- Tenant integrity: (parent, org) must match a real parent in the same org.
  constraint permit_conditions_parent_org_fk
    foreign key (permit_id, org_id)
    references public.permits_to_work (id, org_id) on delete cascade,
  -- A confirmed condition carries who + when.
  constraint permit_conditions_confirmed_stamp
    check (confirmed = false or (confirmed_by is not null and confirmed_at is not null))
);

create index if not exists permit_conditions_parent_idx on public.permit_conditions (permit_id);
create index if not exists permit_conditions_org_idx     on public.permit_conditions (org_id);

-- ---------------------------------------------------------------------------
-- Trigger: derive a condition's org_id from its parent; conditions may only be
-- added/changed while the permit is a DRAFT (confirming a check on a live permit
-- is done via a dedicated path that flips `confirmed` — see below).
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_condition_derive_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
  parent_status text;
begin
  -- Reparenting is forbidden — a condition can never move between permits (it
  -- would strip the evidence trail off an issued permit).
  if tg_op = 'UPDATE' and new.permit_id is distinct from old.permit_id then
    raise exception 'a condition cannot be moved to another permit';
  end if;

  select org_id, status into parent_org, parent_status
  from public.permits_to_work where id = new.permit_id;
  if parent_org is null then
    raise exception 'permit % not found', new.permit_id;
  end if;
  new.org_id := parent_org;

  if tg_op = 'INSERT' and parent_status <> 'draft' then
    raise exception 'cannot add conditions to a % permit', parent_status;
  end if;

  if tg_op = 'UPDATE' and parent_status <> 'draft' then
    -- Structure is frozen once the permit leaves draft.
    if (new.label, new.required, new.sort_order) is distinct from (old.label, old.required, old.sort_order) then
      raise exception 'a condition''s structure is frozen once the permit is issued';
    end if;
    -- A confirmed control is evidence: it can't be un-confirmed, and its
    -- who/when can't be rewritten. (Confirming an as-yet-unconfirmed optional
    -- control DURING the works is still allowed.)
    if old.confirmed then
      if not new.confirmed then
        raise exception 'a confirmed control cannot be un-confirmed on a live permit';
      end if;
      if (new.confirmed_by, new.confirmed_at) is distinct from (old.confirmed_by, old.confirmed_at) then
        raise exception 'the confirmation record (who/when) is immutable';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger tg_permit_condition_derive_org_ins
  before insert on public.permit_conditions
  for each row execute function public.tg_permit_condition_derive_org();
create trigger tg_permit_condition_derive_org_upd
  before update on public.permit_conditions
  for each row execute function public.tg_permit_condition_derive_org();

-- Deleting a condition from a non-draft permit would erase evidence — block it
-- (mirrors the RAMS hazard delete-block).
create or replace function public.tg_permit_condition_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_status text;
begin
  select status into parent_status from public.permits_to_work where id = old.permit_id;
  if parent_status is not null and parent_status <> 'draft' then
    raise exception 'cannot delete a condition from a % permit (evidence is frozen)', parent_status;
  end if;
  return old;
end;
$$;

create trigger tg_permit_condition_block_delete
  before delete on public.permit_conditions
  for each row execute function public.tg_permit_condition_block_delete();

-- ---------------------------------------------------------------------------
-- Trigger: same-org (and, when job-scoped, same-job) integrity for the job +
-- RAMS links. Org A can never bind a permit to Org B's job or RAMS; a job-scoped
-- permit can't silently reference a different job's RAMS.
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_validate_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  job_org uuid;
  ra_org  uuid;
  ra_job  uuid;
begin
  if new.job_id is not null then
    select org_id into job_org from public.jobs where id = new.job_id;
    if job_org is null or job_org <> new.org_id then
      raise exception 'job % does not belong to this organisation', new.job_id;
    end if;
  end if;
  if new.risk_assessment_id is not null then
    select org_id, job_id into ra_org, ra_job from public.risk_assessments where id = new.risk_assessment_id;
    if ra_org is null or ra_org <> new.org_id then
      raise exception 'risk assessment % does not belong to this organisation', new.risk_assessment_id;
    end if;
    -- If both are job-scoped, they must agree.
    if new.job_id is not null and ra_job is not null and ra_job <> new.job_id then
      raise exception 'risk assessment % belongs to a different job', new.risk_assessment_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger tg_permit_validate_links
  before insert or update on public.permits_to_work
  for each row execute function public.tg_permit_validate_links();

-- ---------------------------------------------------------------------------
-- Trigger: lifecycle + issue-gate + immutability. The DB is the authority for
-- valid transitions, the "all required conditions confirmed before issue" gate,
-- and the freeze of contractual/safety fields once issued.
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  unconfirmed int;
  ra_status text;
begin
  -- A permit is ALWAYS born a draft. Issuing (and every other state) is only ever
  -- reached via an UPDATE that runs the matrix + issue-gate below — so a direct
  -- INSERT can never mint an already-issued permit and skip the controls (P0-1).
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a permit is created as a draft, then issued';
    end if;
    return new;
  end if;

  -- IMMUTABILITY runs whenever the permit has left draft, regardless of whether
  -- this UPDATE also changes status — so an edit can't ride in on a transition
  -- (P0-2). Contractual/safety fields + provenance are frozen; only status, the
  -- lifecycle stamps and closeout_notes may move.
  if old.status <> 'draft' then
    if (new.permit_type, new.title, new.scope, new.location, new.job_id,
        new.risk_assessment_id, new.reference, new.responsible_person,
        new.isolation_details, new.emergency_arrangements, new.valid_from,
        new.valid_until, new.issued_by, new.issued_at, new.created_by, new.created_at)
       is distinct from
       (old.permit_type, old.title, old.scope, old.location, old.job_id,
        old.risk_assessment_id, old.reference, old.responsible_person,
        old.isolation_details, old.emergency_arrangements, old.valid_from,
        old.valid_until, old.issued_by, old.issued_at, old.created_by, old.created_at)
    then
      raise exception 'an issued permit is immutable; only its lifecycle status + closeout may change';
    end if;
  end if;

  if old.status = new.status then
    return new;
  end if;

  -- Status IS changing — enforce the transition matrix.
  if not (
       (old.status = 'draft'     and new.status in ('issued', 'cancelled'))
    or (old.status = 'issued'    and new.status in ('active', 'suspended', 'closed', 'cancelled'))
    or (old.status = 'active'    and new.status in ('suspended', 'closed', 'cancelled'))
    or (old.status = 'suspended' and new.status in ('active', 'closed', 'cancelled'))
  ) then
    raise exception 'invalid permit transition % -> %', old.status, new.status;
  end if;

  -- Issue gate: every REQUIRED condition confirmed, AND (if referenced) the RAMS
  -- must itself be ISSUED — a permit cannot work under a draft/withdrawn RAMS (P1-5).
  if new.status = 'issued' then
    select count(*) into unconfirmed
    from public.permit_conditions
    where permit_id = new.id and required = true and confirmed = false;
    if unconfirmed > 0 then
      raise exception 'cannot issue: % required condition(s) not confirmed', unconfirmed;
    end if;
    if new.risk_assessment_id is not null then
      select status into ra_status from public.risk_assessments where id = new.risk_assessment_id;
      if ra_status is distinct from 'issued' then
        raise exception 'cannot issue: the linked risk assessment is % (must be issued)', coalesce(ra_status, 'missing');
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger tg_permit_lifecycle
  before insert or update on public.permits_to_work
  for each row execute function public.tg_permit_lifecycle();

create trigger permits_set_updated_at
  before update on public.permits_to_work
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — tenant isolation (mirrors RAMS / snags)
-- ---------------------------------------------------------------------------
alter table public.permits_to_work  enable row level security;
alter table public.permit_conditions enable row level security;

create policy permits_select on public.permits_to_work
  for select using (org_id in (select public.current_org_ids()));
create policy permits_insert on public.permits_to_work
  for insert with check (org_id in (select public.current_org_ids()));
create policy permits_update on public.permits_to_work
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy permits_delete on public.permits_to_work
  for delete using (public.is_org_admin(org_id));

create policy permit_conditions_select on public.permit_conditions
  for select using (org_id in (select public.current_org_ids()));
create policy permit_conditions_insert on public.permit_conditions
  for insert with check (org_id in (select public.current_org_ids()));
create policy permit_conditions_update on public.permit_conditions
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy permit_conditions_delete on public.permit_conditions
  for delete using (org_id in (select public.current_org_ids()));
