-- P3W2 Payroll — per-employee HOLIDAY ENTITLEMENT configuration.
--
-- WHY THIS EXISTS
-- ---------------
-- Today `leave_requests` (20260521000000_staff_rota_leave.sql) has a full
-- submit → approve → cancel lifecycle, but there is NO concept of an
-- entitlement, an allowance, accrual, or carry-over anywhere in the schema or
-- the app. A staff member cannot see how many holiday days they have left, and
-- an admin has nothing to book leave against. This migration adds the per-
-- employee CONFIG that the deterministic accrual/balance engine
-- (lib/staff/holiday.ts) reads to answer "days remaining".
--
-- It stores CONFIG ONLY — the allowance, how it accrues, the carry-over cap and
-- the leave-year boundary. The balance itself (accrued / taken / booked /
-- remaining) is DERIVED at read time from this config plus the employee's own
-- approved/pending `holiday` leave requests, exactly like employer payroll costs
-- are derived rather than stored. Deriving means the number is always correct
-- with no backfill and no second source of truth to drift.
--
-- ACCESS MODEL
-- ------------
-- Per-employee data, keyed (org_id, user_id). This is EMPLOYER-set config, so
-- the split is: staff READ their OWN row (to see days remaining) + admins READ
-- any member's row in the org; only ADMINS WRITE (a staff member must not be
-- able to grant themselves more holiday). This mirrors the read model of
-- notification_preferences but tightens writes to admins.
--
-- Additive + idempotent. RLS enabled.
--
-- REVERSE DDL (documented, not executed):
--   drop table if exists public.holiday_entitlements;

create table if not exists public.holiday_entitlements (
  id                     uuid        primary key default gen_random_uuid(),
  org_id                 uuid        not null references public.organizations (id) on delete cascade,
  user_id                uuid        not null references public.users (id) on delete cascade,
  -- Annual holiday allowance in DAYS. UK statutory minimum is 5.6 weeks =
  -- 28 days for a five-day week, the default. Bounded to a sane range.
  annual_allowance_days  numeric(5, 2) not null default 28
    check (annual_allowance_days >= 0 and annual_allowance_days <= 366),
  -- How the allowance becomes available across the leave year:
  --   'immediate' — the whole (pro-rated, for mid-year joiners) allowance is
  --                 available from the start of the leave year.
  --   'monthly'   — 1/12 of the allowance accrues per completed month worked.
  accrual_method         text        not null default 'immediate'
    check (accrual_method in ('immediate', 'monthly')),
  -- Maximum days that may be carried into the NEXT leave year (0 = none).
  carry_over_max_days    numeric(5, 2) not null default 0
    check (carry_over_max_days >= 0 and carry_over_max_days <= 366),
  -- The leave-year boundary (month 1-12, day 1-31). Default 1 January. Many
  -- employers run their leave year from 1 April or the employee's start date;
  -- storing the boundary keeps the accrual engine deterministic per employee.
  leave_year_start_month int         not null default 1
    check (leave_year_start_month between 1 and 12),
  leave_year_start_day   int         not null default 1
    check (leave_year_start_day between 1 and 31),
  created_at             timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- One entitlement row per employee per org — the config UI upserts on this key.
  constraint holiday_entitlements_user_org_uniq unique (org_id, user_id)
);

comment on table public.holiday_entitlements is
  'Per-employee holiday entitlement CONFIG (annual allowance days, accrual '
  'method, carry-over cap, leave-year boundary). The balance/remaining days are '
  'DERIVED at read time by lib/staff/holiday.ts from this config + the '
  'employee''s holiday leave_requests, never stored. Read own or admin; write '
  'admin only.';

create index if not exists holiday_entitlements_org_user_idx
  on public.holiday_entitlements (org_id, user_id);

drop trigger if exists holiday_entitlements_set_updated_at
  on public.holiday_entitlements;
create trigger holiday_entitlements_set_updated_at
  before update on public.holiday_entitlements
  for each row execute function public.tg_set_updated_at();

alter table public.holiday_entitlements enable row level security;

-- SELECT: a member reads their OWN row; org admins read any member's row.
-- current_org_ids() (not is_org_member) so HQ impersonation reads correctly.
drop policy if exists "holiday_entitlements: own or admin select"
  on public.holiday_entitlements;
create policy "holiday_entitlements: own or admin select"
  on public.holiday_entitlements
  for select to authenticated
  using (
    (user_id = auth.uid() and org_id in (select public.current_org_ids()))
    or public.is_org_admin(org_id)
  );

-- WRITE: admins only. A staff member must not set their own allowance. Every
-- write policy pins is_org_admin(org_id) so the active-org boundary is enforced
-- (is_org_admin admits only orgs the caller administers).
drop policy if exists "holiday_entitlements: admin insert"
  on public.holiday_entitlements;
create policy "holiday_entitlements: admin insert"
  on public.holiday_entitlements
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "holiday_entitlements: admin update"
  on public.holiday_entitlements;
create policy "holiday_entitlements: admin update"
  on public.holiday_entitlements
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "holiday_entitlements: admin delete"
  on public.holiday_entitlements;
create policy "holiday_entitlements: admin delete"
  on public.holiday_entitlements
  for delete to authenticated
  using (public.is_org_admin(org_id));
