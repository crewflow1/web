-- Protect staff compensation + emergency contact from co-worker reads.
--
-- FINDING (confirmed at the RLS layer): the "users: members can read profiles
-- of co-workers" policy (20260515170000) grants ROW-level SELECT on public.users
-- to any authenticated org member — so a co-worker who may legitimately read the
-- row (names/emails for assignment dropdowns) also reads EVERY column on it,
-- including `hourly_pay` and `emergency_contact`. 20260529 already moved
-- `ni_number` to an admin-only `staff_secrets` table for exactly this reason but
-- left pay + emergency contact behind.
--
-- FIX: move `hourly_pay` + `emergency_contact` to a sibling table with RLS that
-- admits only (a) the user themselves and (b) owners/admins of an org the user
-- belongs to. Same pattern as staff_secrets, adjusted to allow SELF read — pay
-- drives the /me earnings surface (NI did not need self-read). Semantics stay
-- GLOBAL per-user (one pay value per user, as the dropped users.hourly_pay was),
-- so job-costing / payroll / profitability figures are byte-equivalent for the
-- admin/owner contexts that compute them.
--
-- Enforcement is DB-level: RLS is row-level and owners/admins share the
-- `authenticated` role with staff, so column separation is the only way to admit
-- admins + self while excluding co-workers.

-- ---------------------------------------------------------------------------
-- 1. Authorization helpers (SECURITY DEFINER — bypass RLS on memberships to
--    avoid recursion, exactly as is_org_admin / current_org_ids do).
-- ---------------------------------------------------------------------------

-- Read: the user themselves, OR an owner/admin of ANY org the target belongs to.
create or replace function public.can_read_compensation(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_user = auth.uid()
    or exists (
      select 1
      from public.memberships mt
      join public.memberships me on me.org_id = mt.org_id
      where mt.user_id = target_user
        and me.user_id = auth.uid()
        and me.role in ('owner', 'admin')
    );
$$;

-- Write: ONLY an owner/admin of an org the target belongs to (a member can never
-- set their own pay — that would be a payroll self-service escalation). The
-- invite-acceptance self-seed path uses the service-role client instead.
create or replace function public.can_write_compensation(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mt
    join public.memberships me on me.org_id = mt.org_id
    where mt.user_id = target_user
      and me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. staff_compensation — self + admin only
-- ---------------------------------------------------------------------------

create table if not exists public.staff_compensation (
  user_id           uuid primary key references public.users(id) on delete cascade,
  hourly_pay        numeric(8, 2),
  emergency_contact jsonb,
  updated_by        uuid references public.users(id) on delete set null,
  updated_at        timestamp with time zone not null default now()
);

drop trigger if exists staff_compensation_set_updated_at on public.staff_compensation;
create trigger staff_compensation_set_updated_at before update on public.staff_compensation
  for each row execute function public.tg_set_updated_at();

alter table public.staff_compensation enable row level security;

drop policy if exists "staff_compensation: self or admin can read" on public.staff_compensation;
create policy "staff_compensation: self or admin can read" on public.staff_compensation
  for select to authenticated
  using (public.can_read_compensation(user_id));

drop policy if exists "staff_compensation: admin can write" on public.staff_compensation;
create policy "staff_compensation: admin can write" on public.staff_compensation
  for all to authenticated
  using (public.can_write_compensation(user_id))
  with check (public.can_write_compensation(user_id));

-- ---------------------------------------------------------------------------
-- 3. Backfill from the source columns, then drop them from public.users
-- ---------------------------------------------------------------------------

insert into public.staff_compensation (user_id, hourly_pay, emergency_contact)
select id, hourly_pay, emergency_contact
from public.users
where hourly_pay is not null or emergency_contact is not null
on conflict (user_id) do nothing;

alter table public.users
  drop column if exists hourly_pay,
  drop column if exists emergency_contact;
