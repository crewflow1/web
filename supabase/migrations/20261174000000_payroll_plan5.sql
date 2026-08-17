-- Payroll — widen the student-loan-plan CHECK to admit Plan 5.
--
-- WHY
-- ---
-- Student Loan Plan 5 is the post-2023 undergraduate plan for English/Welsh students
-- who started their course on or after 1 August 2023. Repayments began on 6 April
-- 2026 (the 2026-27 tax year, i.e. the current year) at 9% of earnings above a
-- £25,000 annual threshold. `payroll_tax_profiles.student_loan_plan` previously only
-- admitted none|plan_1|plan_2|plan_4|postgraduate, so an admin could not record a
-- Plan 5 borrower and their student-loan estimate was silently wrong (£0).
--
-- WHAT
-- ----
-- Widen the column's CHECK constraint to include 'plan_5'. Purely additive: every
-- existing value stays valid, the default ('none') is unchanged, and no row is
-- rewritten. The original constraint was declared inline in
-- 20261155000000_payroll_employee_tax_inputs.sql, so Postgres auto-named it
-- `payroll_tax_profiles_student_loan_plan_check`. Drop-if-exists then re-add makes
-- this idempotent and re-runnable.
--
-- REVERSE DDL (documented, not executed — narrowing would reject any Plan 5 rows):
--   alter table public.payroll_tax_profiles
--     drop constraint if exists payroll_tax_profiles_student_loan_plan_check;
--   alter table public.payroll_tax_profiles
--     add constraint payroll_tax_profiles_student_loan_plan_check
--     check (student_loan_plan in ('none','plan_1','plan_2','plan_4','postgraduate'));

alter table public.payroll_tax_profiles
  drop constraint if exists payroll_tax_profiles_student_loan_plan_check;

alter table public.payroll_tax_profiles
  add constraint payroll_tax_profiles_student_loan_plan_check
  check (student_loan_plan in ('none', 'plan_1', 'plan_2', 'plan_4', 'plan_5', 'postgraduate'));

comment on column public.payroll_tax_profiles.student_loan_plan is
  'Student-loan plan: none|plan_1|plan_2|plan_4|plan_5|postgraduate. Plan 5 is the '
  'post-2023 undergraduate plan (repayments live from 6 Apr 2026, 9% above £25,000). '
  'Feeds the payroll take-home ESTIMATE (computeEmployeeDeductionsForStoredLine).';
