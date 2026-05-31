-- CrewFlow HQ-10.3 — impersonation must see the TARGET org ONLY.
--
-- BUG-05 follow-up (read/write bleed)
-- ----------------------------------
--   HQ-10.1 (20260614000000_impersonation_rls_aware.sql) made the two
--   RLS helper functions impersonation-aware by UNION-ing the operator's
--   own memberships with the active impersonation target:
--
--     current_org_ids()  = {own memberships} ∪ {active target}
--     is_org_admin(o)     = {real owner/admin in o} OR {impersonating o}
--
--   HQ-10.2 (20260630000000) then fixed the organizations SELECT policy
--   so the tenant context finally switches during impersonation. That
--   surfaced a latent bleed the old fall-back had been hiding:
--
--     * RLS-only reads (no explicit .eq("org_id", ctx.org.id) filter —
--       e.g. GET /api/invoices, dashboard metric widgets) returned rows
--       from BOTH the operator's own org AND the impersonated target,
--       because current_org_ids() returned both.
--     * Admin-gated writes/deletes (policies using is_org_admin(org_id) —
--       invoice delete, payments, staff rota, support tickets, storage
--       admin ops, …) stayed allowed on the operator's OWN org during
--       impersonation, because is_org_admin() still saw real membership.
--
--   Net effect: while "inside" Customer A, an operator who also belongs
--   to their own org B saw/could act on a blend of A + B. This only ever
--   mixed the operator's own org with the target (never a third
--   customer), so it is an operator-side isolation defect, not a
--   cross-customer breach — but it contradicts "impersonation shows the
--   EXACT customer state".
--
-- Fix
-- ---
--   During an ACTIVE impersonation session the helpers must collapse to
--   the impersonated target ONLY — the operator's own memberships are
--   excluded for the duration of the session. Outside impersonation the
--   behaviour is unchanged.
--
--   current_org_ids():
--     active session  -> {active target(s)}        (own memberships excluded)
--     no session      -> {own memberships}         (unchanged)
--
--   is_org_admin(o):
--     active session  -> true iff o is an active impersonation target
--     no session      -> true iff real owner/admin membership (unchanged)
--
-- Why this is safe
-- ----------------
--   * Customers cannot create impersonation_sessions (server actions are
--     gated by isSuperAdminEmail; the table is RLS-with-no-policies), so
--     for every normal customer NEITHER helper ever sees an active
--     session → results are byte-identical to today. Customer-to-customer
--     isolation is untouched.
--   * The only behavioural delta is for a super-admin WITH an active
--     session: they now see/act on the target org only, never their own.
--     That is the correct, intended semantics of impersonation.
--   * Both helpers remain SECURITY DEFINER + STABLE and keep the inline
--     24h cap + ended_at IS NULL gate, so Exit / Force-end revokes the
--     scoped access immediately (the next statement re-evaluates and the
--     operator's own memberships return).
--   * The mutual-exclusion is structural (NOT EXISTS guard / CASE), so a
--     session can never simultaneously expose own + target.

-- ---------------------------------------------------------------------
-- current_org_ids — target-only during an active impersonation session
-- ---------------------------------------------------------------------

create or replace function public.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- 1. Active impersonation: the operator sees ONLY the target org(s).
  --    The 24h cap matches the cookie maxAge so the SQL side cannot
  --    outlive the cookie side.
  select target_org_id
    from public.impersonation_sessions
   where admin_user_id = auth.uid()
     and ended_at is null
     and started_at > now() - interval '24 hours'

  union all

  -- 2. No active session: the caller sees the orgs they belong to. The
  --    NOT EXISTS guard makes the two branches mutually exclusive, so a
  --    normal customer's visible set is byte-identical to before — and
  --    an impersonating operator's own memberships are fully excluded.
  select org_id
    from public.memberships
   where user_id = auth.uid()
     and not exists (
       select 1
         from public.impersonation_sessions
        where admin_user_id = auth.uid()
          and ended_at is null
          and started_at > now() - interval '24 hours'
     );
$$;

-- ---------------------------------------------------------------------
-- is_org_admin — admin rights scoped to the impersonated org only
-- ---------------------------------------------------------------------

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1
        from public.impersonation_sessions
       where admin_user_id = auth.uid()
         and ended_at is null
         and started_at > now() - interval '24 hours'
    )
    then
      -- During impersonation: admin ONLY in the impersonated org(s).
      -- Real owner/admin membership in the operator's own org is
      -- deliberately ignored for the duration of the session.
      exists (
        select 1
          from public.impersonation_sessions
         where admin_user_id = auth.uid()
           and target_org_id = target_org
           and ended_at is null
           and started_at > now() - interval '24 hours'
      )
    else
      -- Normal: real owner/admin membership (unchanged behaviour).
      exists (
        select 1
          from public.memberships
         where user_id = auth.uid()
           and org_id = target_org
           and role in ('owner', 'admin')
      )
  end;
$$;
