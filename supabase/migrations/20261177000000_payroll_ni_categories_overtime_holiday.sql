-- Payroll — full NI category letters, overtime, and holiday pay into gross.
--
-- THREE additive, default-safe capabilities, extending the EXISTING payroll
-- authority (lib/payroll/compute.ts + lib/payroll/rates.ts). Nothing here changes an
-- existing run: every new column defaults to the value that reproduces today's maths
-- to the penny (ni_category 'A' = the standard-rate path already applied to everyone;
-- overtime + leave hours/pay = 0; standard_hours_per_day = NULL = no holiday pay).
--
-- 1) NI CATEGORY LETTER + DOB on payroll_tax_profiles
--    ------------------------------------------------
--    Employer NI already varies by category letter in the rate table (rates.ts holds
--    the Upper Secondary Threshold), but the letter was never an input, so everyone
--    was priced as category A. This records the letter (A/B/C/J standard; H/M/V/Z pay
--    0% employer NI up to the UST) so annualEmployerNiForCategory can apply it.
--    date_of_birth is recorded for a NON-BLOCKING consistency warning only
--    (niCategoryAgeWarning) — it never changes the figure; the recorded letter is
--    authoritative, mirroring how tax_region is an input rather than inferred.
--
-- 2) OVERTIME on payroll_lines
--    -------------------------
--    overtime_hours × overtime_multiplier (a per-line input, default 1.5 = time-and-a-
--    half — NOT a single hardcoded rate) added to gross. Defaults to 0 hours, so a
--    generated run is unchanged until an admin records overtime on a DRAFT line
--    (audited — see payroll_line_adjustments). overtime_pay is the stored £ component
--    for auditability; it is always consistent with gross_pay.
--
-- 3) HOLIDAY PAY into gross on payroll_lines
--    --------------------------------------
--    Approved 'holiday' leave_requests overlapping the period are paid ONCE: worked
--    hours come from clocked time_entries and a holiday day has no clocked shift, so
--    the two are disjoint. leave_hours = approved working days in the period ×
--    payroll_tax_profiles.standard_hours_per_day; leave_pay = leave_hours × rate. With
--    standard_hours_per_day unset (NULL), leave_hours stays 0 — holiday pay is opt-in
--    per employee, so existing tenants are unaffected until they record daily hours.
--
-- TENANT SAFETY: payroll_line_adjustments is org-scoped, RLS-enabled, admin-gated, and
-- references payroll_lines via a COMPOSITE (id, org_id) FK so an adjustment can never
-- bind to another tenant's line. Additive + idempotent; no existing migration edited.
--
-- REVERSE DDL (documented, not executed):
--   drop table if exists public.payroll_line_adjustments;
--   alter table public.payroll_lines
--     drop constraint if exists payroll_lines_id_org_key,
--     drop column if exists overtime_hours, drop column if exists overtime_multiplier,
--     drop column if exists overtime_pay, drop column if exists leave_hours,
--     drop column if exists leave_pay;
--   alter table public.payroll_tax_profiles
--     drop constraint if exists payroll_tax_profiles_ni_category_check,
--     drop column if exists ni_category, drop column if exists date_of_birth,
--     drop column if exists standard_hours_per_day;

-- ---------------------------------------------------------------------------
-- 1. payroll_tax_profiles — NI category letter, DOB, standard daily hours
-- ---------------------------------------------------------------------------

alter table public.payroll_tax_profiles
  add column if not exists ni_category text not null default 'A';

alter table public.payroll_tax_profiles
  drop constraint if exists payroll_tax_profiles_ni_category_check;
alter table public.payroll_tax_profiles
  add constraint payroll_tax_profiles_ni_category_check
  check (ni_category in ('A', 'B', 'C', 'J', 'H', 'M', 'V', 'Z'));

-- Recorded only for the non-blocking category/age consistency warning. Nullable:
-- an absent DOB simply means no warning is computed. No government identifier.
alter table public.payroll_tax_profiles
  add column if not exists date_of_birth date;

-- Contracted hours per WORKING day, to convert approved paid-leave days into
-- holiday-pay hours. NULL (default) ⇒ no holiday pay is added for this employee.
alter table public.payroll_tax_profiles
  add column if not exists standard_hours_per_day numeric(5, 2);
alter table public.payroll_tax_profiles
  drop constraint if exists payroll_tax_profiles_standard_hours_per_day_check;
alter table public.payroll_tax_profiles
  add constraint payroll_tax_profiles_standard_hours_per_day_check
  check (standard_hours_per_day is null
         or (standard_hours_per_day >= 0 and standard_hours_per_day <= 24));

comment on column public.payroll_tax_profiles.ni_category is
  'Employer-NI category letter: A/B/C/J (standard secondary rate) or H/M/V/Z (0% '
  'employer NI up to the Upper Secondary Threshold). Default A = the standard-rate '
  'path applied before this column existed. Feeds annualEmployerNiForCategory; the '
  'letter is authoritative (never inferred from age).';
comment on column public.payroll_tax_profiles.date_of_birth is
  'Date of birth — feeds the NON-BLOCKING NI category consistency warning only '
  '(niCategoryAgeWarning). Never changes any computed figure.';
comment on column public.payroll_tax_profiles.standard_hours_per_day is
  'Contracted hours per working day, used to convert approved paid-leave days into '
  'holiday-pay hours added to gross. NULL ⇒ no holiday pay (default-safe / opt-in).';

-- ---------------------------------------------------------------------------
-- 2 + 3. payroll_lines — overtime + holiday components of gross
-- ---------------------------------------------------------------------------

alter table public.payroll_lines
  add column if not exists overtime_hours numeric(6, 2) not null default 0;
alter table public.payroll_lines
  add column if not exists overtime_multiplier numeric(5, 3) not null default 1.5;
alter table public.payroll_lines
  add column if not exists overtime_pay numeric(10, 2) not null default 0;
alter table public.payroll_lines
  add column if not exists leave_hours numeric(6, 2) not null default 0;
alter table public.payroll_lines
  add column if not exists leave_pay numeric(10, 2) not null default 0;

alter table public.payroll_lines
  drop constraint if exists payroll_lines_overtime_holiday_nonneg_check;
alter table public.payroll_lines
  add constraint payroll_lines_overtime_holiday_nonneg_check
  check (overtime_hours >= 0 and overtime_multiplier >= 0 and overtime_pay >= 0
         and leave_hours >= 0 and leave_pay >= 0);

comment on column public.payroll_lines.overtime_hours is
  'Overtime hours for the period (default 0). Paid at overtime_multiplier × rate on '
  'TOP of worked hours; included in gross_pay/paye/ni/net.';
comment on column public.payroll_lines.overtime_multiplier is
  'Per-line overtime premium (e.g. 1.5 = time-and-a-half, 2 = double time). Only '
  'meaningful when overtime_hours > 0.';
comment on column public.payroll_lines.overtime_pay is
  'Stored £ overtime component of gross (overtime_hours × rate × multiplier) — kept '
  'for audit; always consistent with gross_pay.';
comment on column public.payroll_lines.leave_hours is
  'Approved paid-leave (holiday) hours paid in this line (default 0). Paid ONCE — '
  'worked hours are clocked shifts and a holiday day has no shift, so disjoint.';
comment on column public.payroll_lines.leave_pay is
  'Stored £ holiday component of gross (leave_hours × rate).';

-- Composite key so payroll_line_adjustments can reference (id, org_id) and never bind
-- an adjustment to another tenant's line. Additive; the existing PK on id is retained.
alter table public.payroll_lines
  drop constraint if exists payroll_lines_id_org_key;
alter table public.payroll_lines
  add constraint payroll_lines_id_org_key unique (id, org_id);

-- ---------------------------------------------------------------------------
-- 4. payroll_line_adjustments — append-only audit of manual line edits (overtime)
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_line_adjustments (
  id                     uuid        primary key default gen_random_uuid(),
  org_id                 uuid        not null references public.organizations (id) on delete cascade,
  payroll_line_id        uuid        not null,
  actor_id               uuid        references public.users (id) on delete set null,
  -- What was changed. Currently only 'overtime'; kept as text for forward growth.
  field                  text        not null default 'overtime'
    check (field in ('overtime')),
  old_overtime_hours     numeric(6, 2) not null default 0,
  new_overtime_hours     numeric(6, 2) not null default 0,
  old_overtime_multiplier numeric(5, 3) not null default 0,
  new_overtime_multiplier numeric(5, 3) not null default 0,
  old_gross_pay          numeric(10, 2) not null default 0,
  new_gross_pay          numeric(10, 2) not null default 0,
  created_at             timestamptz not null default now(),
  -- COMPOSITE FK: the referenced line must belong to the SAME org — an adjustment can
  -- never reference another tenant's payroll line.
  constraint payroll_line_adjustments_line_fk
    foreign key (payroll_line_id, org_id)
    references public.payroll_lines (id, org_id) on delete cascade
);

comment on table public.payroll_line_adjustments is
  'Append-only audit of manual payroll_line edits (currently overtime). One row per '
  'change, with before/after values and the actor. Admin read/insert; no update/delete '
  '(immutable audit trail).';

create index if not exists payroll_line_adjustments_line_idx
  on public.payroll_line_adjustments (payroll_line_id, created_at desc);
create index if not exists payroll_line_adjustments_org_idx
  on public.payroll_line_adjustments (org_id, created_at desc);

alter table public.payroll_line_adjustments enable row level security;

-- Admins of the org READ the audit trail.
drop policy if exists "payroll_line_adjustments: admin select"
  on public.payroll_line_adjustments;
create policy "payroll_line_adjustments: admin select"
  on public.payroll_line_adjustments
  for select to authenticated
  using (public.is_org_admin(org_id));

-- Admins of the org INSERT audit rows (written by the server action on edit).
drop policy if exists "payroll_line_adjustments: admin insert"
  on public.payroll_line_adjustments;
create policy "payroll_line_adjustments: admin insert"
  on public.payroll_line_adjustments
  for insert to authenticated
  with check (public.is_org_admin(org_id));

-- No UPDATE / DELETE policy: the audit trail is append-only by construction.
