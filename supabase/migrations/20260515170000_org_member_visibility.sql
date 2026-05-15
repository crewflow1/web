-- Allow members to see other members of the same org.
--
-- Without this, the existing policies on memberships + users only return the
-- caller's own row, which breaks any UI that lists co-workers (assignment
-- dropdowns, team pages, mentions).
--
-- Touches:
--   - public.memberships:  add SELECT policy for fellow org members
--   - public.users:        add SELECT policy for users who share an org
--
-- The earlier "their own row" policies stay in place (they're permissive +
-- additive). RLS evaluates them with OR semantics, so a caller now matches
-- on either "this is my row" or "we share an org".
--
-- No recursion risk: current_org_ids() is SECURITY DEFINER and bypasses
-- RLS on memberships when it reads.

drop policy if exists "memberships: members can read org memberships" on public.memberships;
create policy "memberships: members can read org memberships"
on public.memberships for select to authenticated
using (org_id in (select public.current_org_ids()));

drop policy if exists "users: members can read profiles of co-workers" on public.users;
create policy "users: members can read profiles of co-workers"
on public.users for select to authenticated
using (
  id in (
    select user_id from public.memberships
    where org_id in (select public.current_org_ids())
  )
);
