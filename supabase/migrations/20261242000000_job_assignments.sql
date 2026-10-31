-- ============================================================================
-- R5 Phase 1 — job_assignments model (ADDITIVE, DARK, service-role-only).
-- ============================================================================
-- Creates the multi-worker job-assignment join table and backfills one row per
-- job from jobs.assigned_to. This phase changes NO access: jobs and all its
-- child tables keep their current `org_id in (select current_org_ids())`
-- policies, and this table is service-role-only, so applying it is a no-op for
-- every existing user (owner, admin, staff, member).
--
-- WHY A SEPARATE PHASE: R5's staff-access tightening (staff see only ASSIGNED
-- jobs + children) is a high-risk RLS rewrite with lockout potential. Per the
-- R5 migration discipline it is split into small, independently verifiable
-- phases. This Phase 1 lands only the data model + backfill — fully reversible,
-- nothing enforces on it yet. Phase 2+ adds the SECURITY DEFINER is_job_assignee()
-- helper, a client SELECT policy + grant, the assignee-is-org-member write guard,
-- and the per-table SELECT policy rewrites (owner/admin keep full org access;
-- staff restricted to assigned jobs; commercial data stays staff-barred).
--
-- SAME-ORG INTEGRITY: the composite FK (job_id, org_id) -> jobs(id, org_id)
-- (house pattern, relies on jobs_id_org_key, live since 20261072) means an
-- assignment can never point at a job in another tenant; a job delete cascades
-- its assignments. user_id/assigned_by reference the GLOBAL users table (not
-- tenant-scoped), the same shape as jobs.assigned_to.
--
-- LOCKOUT ANALYSIS: none. No existing policy references this table; owners and
-- all members are entirely unaffected. The owner can never be denied by this
-- change because nothing reads it.
-- BACKFILL: idempotent via unique(job_id, user_id); the source jobs.assigned_to
-- already passed the assignee-is-org-member guard, so every backfilled user_id
-- is a valid member of org_id.
-- PERFORMANCE: indexed on (org_id), (job_id), (user_id) and (user_id, org_id) —
-- the last is the Phase-2 "jobs this staff member is assigned to" lookup.
-- ROLLBACK (safe, zero product impact — nothing enforces on it):
--   drop table if exists public.job_assignments;
-- ============================================================================

create table if not exists public.job_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  -- on delete cascade: when a worker is removed, their assignments go with them
  -- (mirrors how jobs.assigned_to SET NULLs; here the row IS the assignment).
  user_id uuid not null references public.users(id) on delete cascade,
  assigned_by uuid references public.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  -- one assignment per (job, worker); re-assigning is a no-op, not a duplicate.
  unique (job_id, user_id),
  constraint job_assignments_job_org_fkey
    foreign key (job_id, org_id)
    references public.jobs (id, org_id) on delete cascade
);

create index if not exists job_assignments_org_idx on public.job_assignments (org_id);
create index if not exists job_assignments_job_idx on public.job_assignments (job_id);
create index if not exists job_assignments_user_idx on public.job_assignments (user_id);
create index if not exists job_assignments_user_org_idx
  on public.job_assignments (user_id, org_id);

alter table public.job_assignments enable row level security;
-- Service-role-only for Phase 1: no client (anon/authenticated) policy is
-- created, and client grants are explicitly revoked. Nothing reads this on the
-- Data API yet — the Phase-2 wiring adds an authenticated SELECT policy + grant
-- when the app starts reading assignments.
--   data-api: intentionally service-role-only (no client policy ⇒ nothing to
--   grant); this is a deliberate posture, not a grant omission.
revoke all on public.job_assignments from public, anon, authenticated;

-- Backfill: one assignment per job that currently has an assignee. Idempotent.
insert into public.job_assignments (org_id, job_id, user_id, assigned_by, assigned_at)
select j.org_id, j.id, j.assigned_to, null, now()
from public.jobs j
where j.assigned_to is not null
on conflict (job_id, user_id) do nothing;
