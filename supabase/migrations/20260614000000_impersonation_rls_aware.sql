-- CrewFlow HQ-10.1 — RLS-aware impersonation.
--
-- Problem in HQ-10:
--   The cookie + session row + banner were in place, but customer
--   tenant data was still RLS-scoped to the super-admin's identity
--   (they have no membership in the target org → current_org_ids()
--   returned nothing → tenant SELECTs returned empty).
--
-- Fix:
--   Update the SQL function current_org_ids() — used by EVERY
--   tenant RLS policy in the system — to UNION in the target_org_id
--   of any active impersonation_sessions row for the current user.
--
-- Security analysis:
--   * Only super-admin server actions can INSERT
--     impersonation_sessions rows (gated by requireAdmin() →
--     isSuperAdminEmail). Customers cannot start impersonation.
--   * SECURITY DEFINER means the function can read
--     impersonation_sessions even though it has RLS+no-policies.
--   * 24h hard cap enforced inline: started_at > now() - 24h.
--     Stale sessions stop granting access automatically.
--   * ended_at IS NULL gate means Exit (or Force end) IMMEDIATELY
--     revokes the cross-tenant read — no cache, no propagation
--     delay.
--   * Multiple sessions per user are allowed in the SQL, but the
--     start action ends any prior active session first, so in
--     practice an admin only ever has one active target.
--   * The original membership branch is unchanged — normal customer
--     access is untouched.
--
-- is_org_admin() gets the same treatment so the operator can also
-- update tenant data during impersonation (otherwise impersonation
-- would be read-only, which contradicts "sees EXACT customer state").
--
-- Every existing RLS policy that uses these helpers automatically
-- picks up the new behaviour — no per-table migration needed.

-- ---------------------------------------------------------------------
-- current_org_ids — augmented with active impersonation targets
-- ---------------------------------------------------------------------

create or replace function public.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- 1. Normal: orgs the user is a member of.
  select org_id from public.memberships where user_id = auth.uid()
  union
  -- 2. Impersonation: target org of any active session for this
  --    user. The 24h cap matches the cookie's maxAge so the SQL
  --    side can't outlive the cookie side.
  select target_org_id
    from public.impersonation_sessions
   where admin_user_id = auth.uid()
     and ended_at is null
     and started_at > now() - interval '24 hours';
$$;

-- ---------------------------------------------------------------------
-- is_org_admin — also honour active impersonation
-- ---------------------------------------------------------------------

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Real membership at owner/admin role.
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and org_id = target_org
        and role in ('owner', 'admin')
    )
    or
    -- Active impersonation against this org.
    exists (
      select 1 from public.impersonation_sessions
      where admin_user_id = auth.uid()
        and target_org_id = target_org
        and ended_at is null
        and started_at > now() - interval '24 hours'
    );
$$;

-- ---------------------------------------------------------------------
-- Performance: index the lookup current_org_ids() now performs on
-- every RLS check. The existing impersonation_sessions_active_idx
-- covers (id, started_at) — we want (admin_user_id) where active.
-- ---------------------------------------------------------------------

create index if not exists impersonation_sessions_admin_active_idx
  on public.impersonation_sessions (admin_user_id, started_at desc)
  where ended_at is null;
