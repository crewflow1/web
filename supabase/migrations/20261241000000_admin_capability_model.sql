-- ============================================================================
-- Admin capability model — Role & Permissions policy R2 (ADDITIVE, DARK).
-- ============================================================================
-- Creates the per-admin capability grant store + an org-side permission audit
-- trail, and backfills every EXISTING admin to a full wildcard grant so NO
-- access changes on apply.
--
-- Enforcement is NOT swapped here: every management gate still uses
-- requireManagementRole (owner|admin) until R4 adopts can(). So this migration
-- changes no one's effective access. Production today holds 1 owner and 0
-- admins, so the backfill inserts 0 rows.
--
-- Both tables are SERVICE-ROLE-ONLY: RLS enabled, NO client (anon/authenticated)
-- policy, and client grants explicitly revoked. The capability helper
-- (server/auth/capabilities.ts) reads/writes them via the admin (service-role)
-- client; clients never reach them through the Data API.
--   data-api: no client policy is created on either table, so there is nothing
--   to grant — they are intentionally service-role-only (not a grant omission).
--
-- ROLLBACK (safe, zero product impact pre-R4 — nothing enforces on these yet):
--   drop table if exists public.permission_audit;
--   drop table if exists public.membership_permissions;
-- ============================================================================

-- 1. Per-admin capability grants -------------------------------------------
create table if not exists public.membership_permissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  module text not null,
  -- The seven founder-defined actions, plus '*' = the wildcard used by the
  -- backfill (and only grantable by the owner) meaning "every action".
  action text not null check (
    action in ('view', 'create', 'edit', 'approve', 'delete', 'export', 'manage', '*')
  ),
  granted_by uuid references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (membership_id, module, action)
);

create index if not exists membership_permissions_membership_idx
  on public.membership_permissions (membership_id);
create index if not exists membership_permissions_org_idx
  on public.membership_permissions (org_id);

alter table public.membership_permissions enable row level security;
-- Service-role-only: clients never read or write grants through PostgREST; the
-- capability helper uses the admin client. Revoke any auto-grant the local
-- stack may still apply (prod no longer auto-grants new tables since 30 Oct).
revoke all on public.membership_permissions from public, anon, authenticated;

-- 2. Org-side permission / ownership audit trail ----------------------------
-- Append-only history of grant, admin-management and ownership events. Distinct
-- from the HQ-side admin_activity_log. target_membership_id has NO FK so the
-- record survives the membership's deletion (history must not cascade away).
create table if not exists public.permission_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
  target_membership_id uuid,
  event text not null check (
    event in (
      'grant_added', 'grant_removed', 'grants_replaced',
      'admin_appointed', 'admin_removed', 'role_changed',
      'ownership_transfer_requested', 'ownership_transfer_completed',
      'ownership_transfer_cancelled'
    )
  ),
  module text,
  action text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists permission_audit_org_idx
  on public.permission_audit (org_id, created_at desc);

alter table public.permission_audit enable row level security;
revoke all on public.permission_audit from public, anon, authenticated;

-- 3. Backfill: existing admins keep full access via a single wildcard grant,
-- so the cutover is a no-op for current users. Future per-module grants (the
-- R3 owner UI) replace the wildcard. Idempotent via the unique constraint.
insert into public.membership_permissions (org_id, membership_id, module, action, granted_by)
select m.org_id, m.id, '*', '*', null
from public.memberships m
where m.role = 'admin'
on conflict (membership_id, module, action) do nothing;
