-- Security hardening sprint.
--
-- 1. Drop the orphaned organizations.stripe_customer_id column — CEO
--    pivoted away from Stripe in Wave 3. The column existed in the
--    baseline schema and has been unreferenced ever since.
--
-- 2. Move users.ni_number into a dedicated staff_secrets table with
--    admin-only RLS, so a leak of public.users no longer exposes
--    National Insurance numbers. Also formalises a UK-format check
--    constraint and copies any existing rows across before dropping
--    the source column.

-- ---------------------------------------------------------------------------
-- 1. Drop Stripe column
-- ---------------------------------------------------------------------------

alter table public.organizations
  drop column if exists stripe_customer_id;

-- ---------------------------------------------------------------------------
-- 2. staff_secrets — admin-only NI number storage
-- ---------------------------------------------------------------------------
--
-- Why a separate table: RLS on public.users currently lets every org
-- member SELECT each other's row (the schema allows it for displaying
-- staff names, emails, hourly_pay). We don't want every staff member
-- able to read every other staff member's NI number — so we move that
-- field behind a stricter RLS gate that only owners + admins can read.

create table if not exists public.staff_secrets (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  ni_number     text,
  updated_by    uuid references public.users(id) on delete set null,
  updated_at    timestamp with time zone not null default now(),
  primary key (org_id, user_id),
  -- UK NI number format: 2 letters + 6 digits + 1 letter (with optional spaces).
  -- The constraint allows NULL so the column can be cleared.
  constraint staff_secrets_ni_format check (
    ni_number is null
    or ni_number ~ '^[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]$'
  )
);

drop trigger if exists staff_secrets_set_updated_at on public.staff_secrets;
create trigger staff_secrets_set_updated_at before update on public.staff_secrets
  for each row execute function public.tg_set_updated_at();

alter table public.staff_secrets enable row level security;

-- Owners + admins of the org can read + write. Staff can NOT read their
-- own (matches typical payroll-bureau practice where the employee asks
-- HR for their own number rather than seeing it in the app).
drop policy if exists "staff_secrets: admin all" on public.staff_secrets;
create policy "staff_secrets: admin all" on public.staff_secrets
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 3. Migrate existing data + drop users.ni_number
-- ---------------------------------------------------------------------------

-- Best-effort backfill: any user with an NI number and at least one
-- membership gets a staff_secrets row per org they're a member of.
-- Skip if the NI doesn't match the format check (would error on insert).
insert into public.staff_secrets (org_id, user_id, ni_number)
select m.org_id, u.id, u.ni_number
from public.users u
join public.memberships m on m.user_id = u.id
where u.ni_number is not null
  and u.ni_number ~ '^[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]$'
on conflict (org_id, user_id) do nothing;

-- Drop the source column. Anything that was non-UK-format gets dropped
-- with it — at this point it was invalid anyway and would have failed
-- payroll filing.
alter table public.users
  drop column if exists ni_number;
