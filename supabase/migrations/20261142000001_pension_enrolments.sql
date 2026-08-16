-- P3W2 Payroll — per-employee PENSION AUTO-ENROLMENT tracking.
--
-- WHY THIS EXISTS
-- ---------------
-- Payroll today (lib/payroll/compute.ts) charges the STATUTORY-MINIMUM employer
-- pension — 3% of qualifying earnings — to EVERY employee over the earnings
-- trigger, because the schema holds no per-employee enrolment state. That
-- overstates the employer cost for opted-out staff and understates it for an
-- opted-in low earner (both are listed in NOT_MODELLED in lib/payroll/rates.ts).
--
-- This migration adds the per-employee auto-enrolment register: enrolment
-- status, the scheme's contribution rates, assessment/enrolment/opt-out dates.
-- Where a row exists, the payroll employer-cost ESTIMATE uses the employee's
-- real status + rate instead of the blanket 3% (see
-- employerCostsForStoredLineWithPension in lib/payroll/compute.ts). It stays an
-- ESTIMATE — RTI/filing to a pension provider or HMRC is external and is NOT
-- built here.
--
-- NI numbers and other government identifiers are NOT stored here — those live
-- in the admin-only, DSAR-excluded staff_secrets table. This table holds
-- enrolment status and contribution rates only.
--
-- ACCESS MODEL
-- ------------
-- Per-employee data, keyed (org_id, user_id). Employer-set config: staff READ
-- their OWN row (to see their enrolment status/rates), admins READ any member's
-- row; only ADMINS WRITE. Same shape as holiday_entitlements.
--
-- Additive + idempotent. RLS enabled.
--
-- REVERSE DDL (documented, not executed):
--   drop table if exists public.pension_enrolments;

create table if not exists public.pension_enrolments (
  id                          uuid        primary key default gen_random_uuid(),
  org_id                      uuid        not null references public.organizations (id) on delete cascade,
  user_id                     uuid        not null references public.users (id) on delete cascade,
  -- Auto-enrolment status:
  --   'not_enrolled' — no assessment done / not yet enrolled (default)
  --   'enrolled'     — an active jobholder in the scheme (contributions due)
  --   'opted_out'    — assessed + enrolled but the worker opted out
  --   'postponed'    — enrolment postponed (up to 3 months) to a later date
  status                      text        not null default 'not_enrolled'
    check (status in ('not_enrolled', 'enrolled', 'opted_out', 'postponed')),
  -- Contribution rates as a FRACTION of qualifying earnings (0..1). Defaults are
  -- the statutory minimums (employee 5%, employer 3%). The employer rate feeds
  -- the payroll employer-cost estimate; the employee rate is recorded for the
  -- payslip/scheme record.
  employee_contribution_rate  numeric(5, 4) not null default 0.05
    check (employee_contribution_rate >= 0 and employee_contribution_rate <= 1),
  employer_contribution_rate  numeric(5, 4) not null default 0.03
    check (employer_contribution_rate >= 0 and employer_contribution_rate <= 1),
  scheme_name                 text        check (scheme_name is null or char_length(scheme_name) between 1 and 120),
  -- The dates that make up the auto-enrolment paper trail. opt_out_date is the
  -- opt-out register: a non-null opt_out_date with status 'opted_out' records a
  -- valid opt-out.
  assessment_date             date,
  enrolment_date              date,
  opt_out_date                date,
  postponement_end_date       date,
  created_at                  timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint pension_enrolments_user_org_uniq unique (org_id, user_id)
);

comment on table public.pension_enrolments is
  'Per-employee pension auto-enrolment register: status '
  '(not_enrolled|enrolled|opted_out|postponed), employee/employer contribution '
  'rates, assessment/enrolment/opt-out/postponement dates. Feeds the payroll '
  'employer-cost ESTIMATE (still an estimate; RTI/filing is external). No NI '
  'numbers here (those are in staff_secrets). Read own or admin; write admin only.';

create index if not exists pension_enrolments_org_user_idx
  on public.pension_enrolments (org_id, user_id);

-- The opt-out register selection — cheap to scan as the table grows.
create index if not exists pension_enrolments_opted_out_idx
  on public.pension_enrolments (org_id)
  where status = 'opted_out';

drop trigger if exists pension_enrolments_set_updated_at
  on public.pension_enrolments;
create trigger pension_enrolments_set_updated_at
  before update on public.pension_enrolments
  for each row execute function public.tg_set_updated_at();

alter table public.pension_enrolments enable row level security;

-- SELECT: a member reads their OWN row; org admins read any member's row.
drop policy if exists "pension_enrolments: own or admin select"
  on public.pension_enrolments;
create policy "pension_enrolments: own or admin select"
  on public.pension_enrolments
  for select to authenticated
  using (
    (user_id = auth.uid() and org_id in (select public.current_org_ids()))
    or public.is_org_admin(org_id)
  );

-- WRITE: admins only (a worker must not set their own enrolment/rates).
drop policy if exists "pension_enrolments: admin insert"
  on public.pension_enrolments;
create policy "pension_enrolments: admin insert"
  on public.pension_enrolments
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "pension_enrolments: admin update"
  on public.pension_enrolments;
create policy "pension_enrolments: admin update"
  on public.pension_enrolments
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "pension_enrolments: admin delete"
  on public.pension_enrolments;
create policy "pension_enrolments: admin delete"
  on public.pension_enrolments
  for delete to authenticated
  using (public.is_org_admin(org_id));
