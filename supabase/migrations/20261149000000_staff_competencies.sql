-- Staff Competencies — qualifications / certifications against a PERSON, plus the
-- per-job requirement the deterministic scheduler matches them against.
--
-- WHY THIS EXISTS
-- ---------------
-- app/(app)/staff/rota/generate states the gap plainly: the rota picker chooses
-- "who is nearest — never who is best — because CrewFlow stores no skills or
-- certifications against a person." `public.users` describes WHO a person is
-- (name, pay, start date) and NOTHING about what they can DO. This migration adds
-- the two missing halves:
--
--   1. public.staff_qualifications — a per-member record of a card / ticket /
--      certification (CSCS, SMSTS, first aid, a trade ticket, …), with its
--      reference, issue + expiry dates, an OPTIONAL scanned document, and notes.
--      Expiry is the point: an expired CSCS card is a compliance exposure, so the
--      daily briefing surfaces expiring/expired qualifications (lib/briefing).
--
--   2. public.jobs.required_qualifications — a text[] of qualification TYPES a job
--      needs. Additive and defaulted to '{}', so every existing job is unchanged
--      and the scheduler's skill-match term is inert until a requirement is set
--      (backward-compatible by construction, lib/schedule/solver.ts).
--
-- ACCESS MODEL
-- ------------
-- Per-employee competency data, keyed (org_id, user_id). Split: any org MEMBER
-- READS (a supervisor must see the crew's tickets to plan work, a worker sees
-- their own); only ADMINS WRITE (a staff member must not be able to grant
-- themselves a qualification they do not hold). Mirrors holiday_entitlements'
-- read-model, tightened to admin writes — the exact posture the CEO standard
-- mandates for a new org table.
--
-- CROSS-TENANT INTEGRITY
-- ----------------------
-- The person is bound by a COMPOSITE FK (org_id, user_id) -> memberships
-- (org_id, user_id) — the candidate key memberships_org_id_user_id_key. This is
-- strictly stronger than a bare user_id FK to public.users: a qualification can
-- only ever name a CURRENT MEMBER of THIS org, so a poisoned user_id pointing at
-- someone in another tenant is structurally unwritable. On membership removal the
-- competency rows cascade (they are employment-scoped to that org).
--
-- Additive + idempotent + RLS enabled. Holds no secrets ⇒ registered in
-- lib/gdpr/org-tables.json `known` (NOT `excluded`).
--
-- REVERSE DDL (documented, not executed):
--   alter table public.jobs drop column if exists required_qualifications;
--   drop table if exists public.staff_qualifications;

-- ---------------------------------------------------------------------------
-- 1. Per-job required qualification TYPES (additive, backward-compatible).
-- ---------------------------------------------------------------------------
alter table public.jobs
  add column if not exists required_qualifications text[] not null default '{}'::text[];

comment on column public.jobs.required_qualifications is
  'Qualification TYPES this job requires (values from lib/staff/qualifications.ts '
  'QUALIFICATION_TYPES). Default {} = no requirement, so the scheduler skill-match '
  'term (lib/schedule/solver.ts) stays inert and behaviour is unchanged. See '
  '20261149000000.';

-- ---------------------------------------------------------------------------
-- 2. Per-member qualifications / certifications.
-- ---------------------------------------------------------------------------
create table if not exists public.staff_qualifications (
  id                 uuid        primary key default gen_random_uuid(),
  org_id             uuid        not null references public.organizations (id) on delete cascade,
  user_id            uuid        not null,

  -- The qualification TYPE — a small controlled vocabulary. This CHECK MUST stay
  -- byte-identical to QUALIFICATION_TYPES in lib/staff/qualifications.ts (the
  -- security test pins both sides). `other` is the escape hatch; the free-text
  -- `title` carries the detail.
  qualification_type text        not null
    check (qualification_type in (
      'cscs', 'smsts', 'sssts', 'first_aid', 'asbestos_awareness', 'trade_ticket', 'other'
    )),

  -- Human name, e.g. "CSCS Blue Skilled Worker" / "18th Edition". Always present.
  title              text        not null
    check (length(btrim(title)) between 1 and 200),
  -- Card / certificate number, when there is one.
  reference_no       text        check (reference_no is null or length(btrim(reference_no)) <= 120),

  issued_on          date,
  expires_on         date,

  -- OPTIONAL scanned document, set ON INSERT. Stored in a private bucket under an
  -- org-first key; the CHECK below is the DB half of that org-first invariant
  -- (defence-in-depth, mirrors site_inductions_image_path_org_first).
  document_bucket    text,
  document_path      text,

  notes              text        check (notes is null or length(btrim(notes)) <= 2000),

  -- Who recorded it (an admin). SET NULL if that user is later deleted so the
  -- record survives (the material_requests decision-provenance rule).
  created_by         uuid        references public.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Expiry cannot precede issue.
  constraint staff_qualifications_dates_ordered
    check (expires_on is null or issued_on is null or expires_on >= issued_on),

  -- Cross-tenant integrity: the person MUST be a member of THIS org. Composite
  -- FK to memberships_org_id_user_id_key. Cascade: removing the membership
  -- removes the org-scoped competency record with it.
  constraint staff_qualifications_member_org_fkey
    foreign key (org_id, user_id)
    references public.memberships (org_id, user_id)
    on delete cascade,

  -- Org-first storage path (defence-in-depth). org_id is client-supplied on
  -- insert but pinned by RLS `is_org_admin(org_id)` to an org the caller
  -- administers, so the split_part check binds the path to that same org.
  constraint staff_qualifications_document_path_org_first
    check (
      document_path is null
      or split_part(document_path, '/', 1) = org_id::text
    )
);

comment on table public.staff_qualifications is
  'Per-member qualifications / certifications (CSCS, SMSTS, first aid, trade '
  'tickets, …) with reference, issue/expiry dates and an optional scanned '
  'document. Read by any org member; written by admins only. Feeds the daily '
  'briefing expiry signal and the scheduler skill-match. See 20261149000000.';

create index if not exists staff_qualifications_org_user_idx
  on public.staff_qualifications (org_id, user_id);
-- Drives the briefing expiry sweep and the scheduler's non-expired read.
create index if not exists staff_qualifications_org_expiry_idx
  on public.staff_qualifications (org_id, expires_on);
-- Drives skill-match: "who in this org holds type X (still valid)".
create index if not exists staff_qualifications_org_type_idx
  on public.staff_qualifications (org_id, qualification_type);

drop trigger if exists staff_qualifications_set_updated_at on public.staff_qualifications;
create trigger staff_qualifications_set_updated_at
  before update on public.staff_qualifications
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — member read, admin write.
-- SELECT uses current_org_ids() (not is_org_member) so HQ impersonation reads
-- correctly, exactly like holiday_entitlements. Every write policy pins
-- is_org_admin(org_id), which admits only orgs the caller administers — the
-- active-org boundary and the least-privilege gate in one.
-- ---------------------------------------------------------------------------
alter table public.staff_qualifications enable row level security;

drop policy if exists staff_qualifications_select on public.staff_qualifications;
create policy staff_qualifications_select on public.staff_qualifications
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

drop policy if exists staff_qualifications_insert on public.staff_qualifications;
create policy staff_qualifications_insert on public.staff_qualifications
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists staff_qualifications_update on public.staff_qualifications;
create policy staff_qualifications_update on public.staff_qualifications
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists staff_qualifications_delete on public.staff_qualifications;
create policy staff_qualifications_delete on public.staff_qualifications
  for delete to authenticated
  using (public.is_org_admin(org_id));
