-- Staff foundation: profile fields, rota, leave requests.
--
-- Roles model (existing):
--   memberships.role: 'owner' | 'admin' | 'staff'  (text, default 'owner')
--   is_org_admin(target_org) — owners + admins only
--
-- New helper: is_org_member(target_org) — anyone in the org. Used by
-- the rota/leave tables so staff can see their OWN rows even without
-- admin privileges.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and org_id = target_org
  );
$$;

-- ---------------------------------------------------------------------------
-- users — extend with employment profile fields
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists hourly_pay numeric(8, 2),
  add column if not exists employment_type text
    check (employment_type in ('employee', 'self_employed', 'contractor', 'apprentice') or employment_type is null),
  add column if not exists start_date date,
  add column if not exists emergency_contact jsonb;

-- ---------------------------------------------------------------------------
-- memberships — constrain role to the 3 the product supports
-- ---------------------------------------------------------------------------

-- Idempotent: drop any prior constraint then add. We don't enforce check
-- on existing rows because old data uses 'member' / unset values; the
-- subsequent UPDATE normalises them.
alter table public.memberships drop constraint if exists memberships_role_check;
update public.memberships set role = 'staff' where role not in ('owner', 'admin', 'staff');
alter table public.memberships
  add constraint memberships_role_check check (role in ('owner', 'admin', 'staff'));

-- ---------------------------------------------------------------------------
-- rota_entries — assigned shifts (optionally tied to a job)
-- ---------------------------------------------------------------------------

create table if not exists public.rota_entries (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete set null,
  starts_at   timestamp with time zone not null,
  ends_at     timestamp with time zone not null,
  notes       text,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now(),
  check (ends_at > starts_at)
);

create index if not exists rota_entries_org_starts_idx on public.rota_entries (org_id, starts_at);
create index if not exists rota_entries_user_starts_idx on public.rota_entries (user_id, starts_at);
create index if not exists rota_entries_job_idx on public.rota_entries (job_id);

drop trigger if exists rota_entries_set_updated_at on public.rota_entries;
create trigger rota_entries_set_updated_at before update on public.rota_entries
  for each row execute function public.tg_set_updated_at();

alter table public.rota_entries enable row level security;

-- RLS: members can SEE all rota in their org (staff need to see who's
-- working what), admins manage. Staff can also see their OWN entries
-- (covered by the org-wide select). INSERT/UPDATE/DELETE = admins only.
drop policy if exists "rota: members select" on public.rota_entries;
create policy "rota: members select" on public.rota_entries
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "rota: admins insert" on public.rota_entries;
create policy "rota: admins insert" on public.rota_entries
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "rota: admins update" on public.rota_entries;
create policy "rota: admins update" on public.rota_entries
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "rota: admins delete" on public.rota_entries;
create policy "rota: admins delete" on public.rota_entries
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- leave_requests — holiday / sick / emergency / unpaid
-- ---------------------------------------------------------------------------

create table if not exists public.leave_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  type         text not null check (type in ('holiday', 'sick', 'emergency', 'unpaid')),
  starts_at    date not null,
  ends_at      date not null,
  reason       text,
  status       text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by  uuid references public.users(id) on delete set null,
  reviewed_at  timestamp with time zone,
  review_note  text,
  created_at   timestamp with time zone not null default now(),
  updated_at   timestamp with time zone not null default now(),
  check (ends_at >= starts_at)
);

create index if not exists leave_requests_org_status_idx on public.leave_requests (org_id, status);
create index if not exists leave_requests_user_idx on public.leave_requests (user_id, starts_at desc);

drop trigger if exists leave_requests_set_updated_at on public.leave_requests;
create trigger leave_requests_set_updated_at before update on public.leave_requests
  for each row execute function public.tg_set_updated_at();

alter table public.leave_requests enable row level security;

-- RLS:
--   - Staff can SEE their OWN requests + all team leave for awareness
--     (we keep the org-wide visibility so staff can see who's off)
--   - Staff can INSERT their OWN requests
--   - Staff can UPDATE their OWN PENDING requests (cancel/edit before review)
--   - Only admins can APPROVE/REJECT (i.e. UPDATE status to approved/rejected)
--     We allow staff UPDATE on own pending rows but the status enum
--     check would let them set "approved" themselves. We enforce this
--     server-side in the action; the DB policy gates by ownership only.
--   - Admins can do anything

drop policy if exists "leave: org members select" on public.leave_requests;
create policy "leave: org members select" on public.leave_requests
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "leave: members insert own" on public.leave_requests;
create policy "leave: members insert own" on public.leave_requests
  for insert to authenticated
  with check (
    public.is_org_member(org_id) and user_id = auth.uid()
  );

drop policy if exists "leave: members update own pending or admins any" on public.leave_requests;
create policy "leave: members update own pending or admins any" on public.leave_requests
  for update to authenticated
  using (
    public.is_org_admin(org_id) or (user_id = auth.uid() and status = 'pending')
  )
  with check (
    public.is_org_admin(org_id) or (user_id = auth.uid() and status = 'pending')
  );

drop policy if exists "leave: admins delete" on public.leave_requests;
create policy "leave: admins delete" on public.leave_requests
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- Activity log: emit staff.* events for hiring + role changes; rota.*
-- and leave.* events via dedicated triggers.
-- ---------------------------------------------------------------------------

create or replace function public._tg_rota_entries_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'rota.assigned', 'rota_entries', NEW.id,
      jsonb_build_object(
        'user_id', NEW.user_id,
        'starts_at', NEW.starts_at,
        'ends_at', NEW.ends_at,
        'job_id', NEW.job_id
      )
    );
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id, 'rota.removed', 'rota_entries', OLD.id,
      jsonb_build_object('user_id', OLD.user_id, 'starts_at', OLD.starts_at)
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists rota_entries_activity_trigger on public.rota_entries;
create trigger rota_entries_activity_trigger
  after insert or delete on public.rota_entries
  for each row execute function _tg_rota_entries_activity();

create or replace function public._tg_leave_requests_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'leave.requested', 'leave_requests', NEW.id,
      jsonb_build_object(
        'user_id', NEW.user_id, 'type', NEW.type,
        'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status and NEW.status in ('approved', 'rejected', 'cancelled') then
      perform _record_activity(
        NEW.org_id, 'leave.' || NEW.status, 'leave_requests', NEW.id,
        jsonb_build_object(
          'user_id', NEW.user_id, 'type', NEW.type,
          'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at,
          'reviewed_by', NEW.reviewed_by
        )
      );
    end if;
    return NEW;
  end if;
  return null;
end;
$$;

drop trigger if exists leave_requests_activity_trigger on public.leave_requests;
create trigger leave_requests_activity_trigger
  after insert or update on public.leave_requests
  for each row execute function _tg_leave_requests_activity();
