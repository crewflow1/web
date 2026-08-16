-- MP R2 Payroll — per-employee TAX INPUTS for the fidelity calculators.
--
-- WHY THIS EXISTS
-- ---------------
-- lib/payroll/compute.ts can already apply Scottish income-tax bands, student-loan
-- repayments and salary sacrifice (computeEmployeeDeductionsForStoredLine), but until
-- now there was NO per-employee input source for them, so those paths were dead — the
-- overlay always ran with defaults (rest-of-UK, no student loan, no sacrifice). This
-- migration adds the per-employee register those inputs come from, so the fidelity
-- actually applies to real runs.
--
-- WHY A NEW TABLE, NOT A COLUMN ON pension_enrolments
-- ---------------------------------------------------
-- pension_enrolments already carries per-employee payroll attributes and the right
-- RLS shape, so it was the obvious candidate. But its mere PRESENCE is meaningful:
-- the payroll run page treats any pension_enrolments row as an authoritative
-- enrolment declaration and, for a row whose status is not 'enrolled', charges £0
-- employer pension (employerCostsForStoredLineWithPension). Creating a row just to
-- record someone's tax region would therefore SILENTLY ZERO their employer-pension
-- estimate — a regression. Tax region / student loan / salary sacrifice are
-- independent of auto-enrolment, so they get their own table and cannot perturb the
-- pension estimate.
--
-- ACCESS MODEL (identical to pension_enrolments / holiday_entitlements)
-- --------------------------------------------------------------------
-- Per-employee data keyed (org_id, user_id). Employer-set config: staff READ their
-- OWN row, admins READ any member's row; only ADMINS WRITE. One row per employee.
--
-- ESTIMATES, NOT A FILED PAYROLL. These inputs feed the on-screen ESTIMATE only; the
-- run page keeps its "confirm with HMRC Basic PAYE Tools before RTI" caveat.
--
-- No NI numbers / government identifiers here (those stay in staff_secrets).
--
-- Additive + idempotent. RLS enabled. Registered for GDPR export in
-- lib/gdpr/org-tables.json (business payroll config — exported, NOT excluded), same
-- classification as pension_enrolments.
--
-- REVERSE DDL (documented, not executed):
--   drop table if exists public.payroll_tax_profiles;

create table if not exists public.payroll_tax_profiles (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations (id) on delete cascade,
  user_id       uuid        not null references public.users (id) on delete cascade,
  -- Income-tax region. Drives which income-tax scale the estimate uses:
  --   'rest_of_uk' — England/Wales/NI three-band scale (DEFAULT ⇒ unchanged behaviour)
  --   'scotland'   — the six-band Scottish scale (their tax code carries an 'S')
  tax_region    text        not null default 'rest_of_uk'
    check (tax_region in ('rest_of_uk', 'scotland')),
  -- Student-loan plan. 'none' (default) ⇒ no student-loan deduction, unchanged.
  student_loan_plan text    not null default 'none'
    check (student_loan_plan in ('none', 'plan_1', 'plan_2', 'plan_4', 'postgraduate')),
  -- Salary sacrifice as an ANNUAL amount in PENCE (integer money, mirroring the
  -- app's pence convention). Sacrificed pay is outside income tax AND NI, so it
  -- reduces PAYE, employee NI, employer NI and take-home alike. 0 (default) ⇒ none.
  salary_sacrifice_annual_pence bigint not null default 0
    check (salary_sacrifice_annual_pence >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint payroll_tax_profiles_user_org_uniq unique (org_id, user_id)
);

comment on table public.payroll_tax_profiles is
  'Per-employee payroll TAX INPUTS: income-tax region (rest_of_uk|scotland), '
  'student-loan plan (none|plan_1|plan_2|plan_4|postgraduate) and annual salary '
  'sacrifice (pence). Feeds the payroll take-home ESTIMATE '
  '(computeEmployeeDeductionsForStoredLine); still an estimate, RTI is external. '
  'Kept separate from pension_enrolments so it cannot affect the employer-pension '
  'estimate. Read own or admin; write admin only.';

create index if not exists payroll_tax_profiles_org_user_idx
  on public.payroll_tax_profiles (org_id, user_id);

drop trigger if exists payroll_tax_profiles_set_updated_at
  on public.payroll_tax_profiles;
create trigger payroll_tax_profiles_set_updated_at
  before update on public.payroll_tax_profiles
  for each row execute function public.tg_set_updated_at();

alter table public.payroll_tax_profiles enable row level security;

-- SELECT: a member reads their OWN row; org admins read any member's row.
drop policy if exists "payroll_tax_profiles: own or admin select"
  on public.payroll_tax_profiles;
create policy "payroll_tax_profiles: own or admin select"
  on public.payroll_tax_profiles
  for select to authenticated
  using (
    (user_id = auth.uid() and org_id in (select public.current_org_ids()))
    or public.is_org_admin(org_id)
  );

-- WRITE: admins only (a worker must not set their own tax region / sacrifice).
drop policy if exists "payroll_tax_profiles: admin insert"
  on public.payroll_tax_profiles;
create policy "payroll_tax_profiles: admin insert"
  on public.payroll_tax_profiles
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "payroll_tax_profiles: admin update"
  on public.payroll_tax_profiles;
create policy "payroll_tax_profiles: admin update"
  on public.payroll_tax_profiles
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "payroll_tax_profiles: admin delete"
  on public.payroll_tax_profiles;
create policy "payroll_tax_profiles: admin delete"
  on public.payroll_tax_profiles
  for delete to authenticated
  using (public.is_org_admin(org_id));
