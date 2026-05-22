-- Admin approval panel — schema additions.
--
-- Adds the data the CEO approval panel needs:
--
--   1. Extends demo_requests.status with the lifecycle the panel
--      drives (pending_demo / demo_booked / approved / rejected /
--      cancelled). Old values stay valid for backwards-compat — the
--      backfill flips legacy `new` → `pending_demo` so the existing
--      submissions show up in the right column.
--
--   2. Adds an `approved_at` audit column to demo_requests so the
--      auto-trial wiring (org created within 60 days of approval gets
--      auto-promoted to trial) has a timestamp to read.
--
--   3. Adds `cancelled` to the organizations.status CHECK + a
--      `cancelled_at` audit column so the panel can suspend, cancel,
--      and tell the two apart.
--
-- All changes are additive + idempotent.

-- ------------------------------------------------------------------
-- demo_requests
-- ------------------------------------------------------------------

alter table public.demo_requests
  add column if not exists approved_at timestamp with time zone,
  add column if not exists reviewed_by uuid references public.users(id) on delete set null,
  add column if not exists rejection_reason text;

-- ORDER MATTERS: drop the CHECK first so the backfill UPDATE doesn't
-- trip on the old (more restrictive) enum, then UPDATE legacy rows,
-- then add the superset CHECK.

alter table public.demo_requests
  drop constraint if exists demo_requests_status_check;

-- Backfill the legacy `new` rows so they show as `pending_demo` in the
-- new UI. Idempotent — once flipped, they stay flipped.
update public.demo_requests
   set status = 'pending_demo'
 where status = 'new';

-- Now add the superset CHECK so both legacy + new lifecycle values
-- validate.
alter table public.demo_requests
  add constraint demo_requests_status_check
  check (status in (
    'pending_demo',  -- new submission, not yet contacted
    'demo_booked',   -- demo scheduled
    'approved',      -- CEO approved; awaiting prospect signup
    'rejected',
    'cancelled',
    -- Legacy values kept for backwards compat; safe to drop later.
    'new', 'contacted', 'qualified', 'closed_won', 'closed_lost'
  ));

alter table public.demo_requests
  alter column status set default 'pending_demo';

create index if not exists demo_requests_email_status_idx
  on public.demo_requests (email, status);

-- ------------------------------------------------------------------
-- organizations
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists cancelled_at timestamp with time zone;

alter table public.organizations
  drop constraint if exists organizations_status_check;
alter table public.organizations
  add constraint organizations_status_check
  check (status in ('pending', 'active', 'trial', 'suspended', 'rejected', 'cancelled'));
