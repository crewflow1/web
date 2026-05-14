-- Enable Row-Level Security on auth-adjacent tables and grant authenticated
-- users SELECT access to their own rows.
--
-- Background:
--   Writes to public.users / public.organizations / public.memberships go
--   through the service-role client in lib/supabase/admin.ts (bypasses RLS).
--   Reads in (app) and onboarding layouts go through the user-context client
--   in lib/supabase/server.ts — those are governed by these policies.
--
-- Without these policies, the user-context client sees zero rows and the
-- dashboard layout silently redirects newly-onboarded users back to
-- /onboarding/company.
--
-- Idempotent: safe to re-run. enable row level security is a no-op when
-- already enabled; each policy is dropped before re-create.

alter table public.organizations enable row level security;
alter table public.memberships    enable row level security;
alter table public.users          enable row level security;

drop policy if exists "Users can read their memberships" on public.memberships;
create policy "Users can read their memberships"
on public.memberships
for select
to authenticated
using (
  user_id = auth.uid()
);

drop policy if exists "Users can read organizations they belong to" on public.organizations;
create policy "Users can read organizations they belong to"
on public.organizations
for select
to authenticated
using (
  id in (
    select org_id
    from public.memberships
    where user_id = auth.uid()
  )
);

drop policy if exists "Users can read their user profile" on public.users;
create policy "Users can read their user profile"
on public.users
for select
to authenticated
using (
  id = auth.uid()
);
