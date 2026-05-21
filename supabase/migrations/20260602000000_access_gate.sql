-- Access gate for CrewFlow.
--
-- Until now anyone could sign up at crewflow.uk, create a free
-- organisation, and use the product. That's fine for an alpha but
-- catastrophic at launch: there is no controlled access, no approval,
-- no trial gate, no pricing gate.
--
-- This migration introduces an organisation `status` enum + audit
-- columns. The default for newly-inserted rows is 'pending', so a
-- brand-new signup lands behind the access gate. The application
-- layer reads `status` in requireOrgContext() and bounces non-active
-- orgs to /access-pending until a CrewFlow admin approves them.
--
--   pending   → waiting for CrewFlow team approval (default for new
--               signups)
--   active    → fully approved, normal access
--   trial    → time-limited access (uses existing `trial_ends_at`)
--   suspended → access revoked (billing failure, abuse, etc.)
--   rejected  → admin rejected the signup
--
-- Existing organisations are backfilled to 'active' so the migration
-- doesn't lock anyone out who already had legitimate access.
--
-- New columns are stamped by the SECURITY DEFINER admin endpoints in
-- /api/admin/organizations, never by user JWT. Reading is governed by
-- the existing organisations SELECT policy (org members can see their
-- own row).

alter table public.organizations
  add column if not exists status text not null default 'pending',
  add column if not exists approved_at timestamp with time zone,
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists suspended_at timestamp with time zone,
  add column if not exists rejection_reason text;

-- Backfill: every org that exists today predates the access gate, so
-- treat them as approved. Only flip rows still on the default to
-- 'active' so re-running this migration doesn't clobber values set by
-- the admin endpoints.
update public.organizations
   set status = 'active',
       approved_at = coalesce(approved_at, created_at)
 where status = 'pending';

-- After the backfill flip the default so NEW signups start pending.
alter table public.organizations
  alter column status set default 'pending';

-- Soft constraint via CHECK so app bugs can't write garbage values.
-- (Dropped + recreated idempotently so re-running upgrades the
--  constraint when the enum list grows.)
alter table public.organizations
  drop constraint if exists organizations_status_check;
alter table public.organizations
  add constraint organizations_status_check
  check (status in ('pending', 'active', 'trial', 'suspended', 'rejected'));

create index if not exists organizations_status_idx
  on public.organizations (status, created_at desc);
