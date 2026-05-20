-- Wave 4 — Field Operations OS
--
-- 1. time_entries     — clock in/out with breaks, optional GPS + job link
-- 2. payroll_runs     — weekly/monthly batches an admin generates
-- 3. payroll_lines    — one row per staff member in a payroll run
-- 4. users.ni_number  — optional National Insurance number for payroll
--
-- Roles model unchanged:
--   members can view team data; owners/admins manage payroll.
--   Staff can SELECT + UPDATE their own time entry (until it's locked into
--   a finalised payroll). Admins can edit anyone's.

-- ---------------------------------------------------------------------------
-- users — payroll-relevant profile fields
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists ni_number text;

-- ---------------------------------------------------------------------------
-- time_entries
-- ---------------------------------------------------------------------------
-- One row per clock-in/clock-out session. While clocked-in, `ended_at` is
-- null. `breaks` is a jsonb array of {started_at, ended_at} pairs — kept
-- inline because (a) breaks belong 1:1 to a session and (b) we only ever
-- read the whole session together.

create table if not exists public.time_entries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  job_id          uuid references public.jobs(id) on delete set null,
  started_at      timestamp with time zone not null default now(),
  ended_at        timestamp with time zone,
  breaks          jsonb not null default '[]'::jsonb,
  gps_lat         numeric(9, 6),
  gps_lng         numeric(9, 6),
  note            text,
  payroll_line_id uuid, -- forward-declared; FK added after payroll_lines is created
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),
  check (ended_at is null or ended_at > started_at)
);

create index if not exists time_entries_org_started_idx on public.time_entries (org_id, started_at desc);
create index if not exists time_entries_user_started_idx on public.time_entries (user_id, started_at desc);
create index if not exists time_entries_job_idx on public.time_entries (job_id);
-- Enforce at most one open entry per user.
create unique index if not exists time_entries_one_open_per_user
  on public.time_entries (user_id) where ended_at is null;

drop trigger if exists time_entries_set_updated_at on public.time_entries;
create trigger time_entries_set_updated_at before update on public.time_entries
  for each row execute function public.tg_set_updated_at();

alter table public.time_entries enable row level security;

-- Members SELECT (owners see all; staff see all in their org — operational
-- visibility, who's on what). UPDATE/DELETE: own rows or admin.
drop policy if exists "time_entries: members select" on public.time_entries;
create policy "time_entries: members select" on public.time_entries
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists "time_entries: own or admin insert" on public.time_entries;
create policy "time_entries: own or admin insert" on public.time_entries
  for insert to authenticated
  with check (
    public.is_org_member(org_id)
    and (user_id = auth.uid() or public.is_org_admin(org_id))
  );

drop policy if exists "time_entries: own or admin update" on public.time_entries;
create policy "time_entries: own or admin update" on public.time_entries
  for update to authenticated
  using (
    public.is_org_member(org_id)
    and (user_id = auth.uid() or public.is_org_admin(org_id))
    and payroll_line_id is null
  )
  with check (
    public.is_org_member(org_id)
    and (user_id = auth.uid() or public.is_org_admin(org_id))
  );

drop policy if exists "time_entries: admin delete" on public.time_entries;
create policy "time_entries: admin delete" on public.time_entries
  for delete to authenticated using (public.is_org_admin(org_id) and payroll_line_id is null);

-- ---------------------------------------------------------------------------
-- payroll_runs
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  cycle         text not null check (cycle in ('weekly', 'monthly')),
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'draft' check (status in ('draft', 'finalised')),
  created_by    uuid references public.users(id) on delete set null,
  finalised_at  timestamp with time zone,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),
  check (period_end >= period_start)
);

create index if not exists payroll_runs_org_period_idx on public.payroll_runs (org_id, period_start desc);
-- A given org can't have two runs covering the exact same window + cycle.
create unique index if not exists payroll_runs_unique_period
  on public.payroll_runs (org_id, cycle, period_start, period_end);

drop trigger if exists payroll_runs_set_updated_at on public.payroll_runs;
create trigger payroll_runs_set_updated_at before update on public.payroll_runs
  for each row execute function public.tg_set_updated_at();

alter table public.payroll_runs enable row level security;

-- Admins fully manage; staff don't see the run-level row (they see their
-- own line through payroll_lines).
drop policy if exists "payroll_runs: admin all" on public.payroll_runs;
create policy "payroll_runs: admin all" on public.payroll_runs
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- payroll_lines
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  payroll_run_id  uuid not null references public.payroll_runs(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  hours           numeric(6, 2) not null default 0,
  hourly_pay      numeric(8, 2) not null default 0,
  gross_pay       numeric(10, 2) not null default 0,
  paye_estimate   numeric(10, 2) not null default 0,
  ni_estimate     numeric(10, 2) not null default 0,
  net_pay         numeric(10, 2) not null default 0,
  note            text,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),
  unique (payroll_run_id, user_id)
);

create index if not exists payroll_lines_user_idx on public.payroll_lines (user_id);

drop trigger if exists payroll_lines_set_updated_at on public.payroll_lines;
create trigger payroll_lines_set_updated_at before update on public.payroll_lines
  for each row execute function public.tg_set_updated_at();

alter table public.payroll_lines enable row level security;

-- Admins manage. Staff see ONLY their own line.
drop policy if exists "payroll_lines: admin manage" on public.payroll_lines;
create policy "payroll_lines: admin manage" on public.payroll_lines
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "payroll_lines: own select" on public.payroll_lines;
create policy "payroll_lines: own select" on public.payroll_lines
  for select to authenticated using (user_id = auth.uid());

-- Now wire the forward-declared FK from time_entries → payroll_lines.
alter table public.time_entries
  drop constraint if exists time_entries_payroll_line_id_fkey;
alter table public.time_entries
  add constraint time_entries_payroll_line_id_fkey
  foreign key (payroll_line_id) references public.payroll_lines(id) on delete set null;
create index if not exists time_entries_payroll_line_idx
  on public.time_entries (payroll_line_id);

-- ---------------------------------------------------------------------------
-- activity triggers — log clock events, payroll runs
-- ---------------------------------------------------------------------------

create or replace function public._tg_time_entries_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public._record_activity(
      new.org_id, 'time_entry.clock_in', 'time_entries', new.id,
      jsonb_build_object('started_at', new.started_at, 'job_id', new.job_id)
    );
  elsif tg_op = 'UPDATE' then
    if old.ended_at is null and new.ended_at is not null then
      perform public._record_activity(
        new.org_id, 'time_entry.clock_out', 'time_entries', new.id,
        jsonb_build_object('started_at', new.started_at, 'ended_at', new.ended_at)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists time_entries_activity on public.time_entries;
create trigger time_entries_activity
  after insert or update on public.time_entries
  for each row execute function public._tg_time_entries_activity();

create or replace function public._tg_payroll_runs_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public._record_activity(
      new.org_id, 'payroll.created', 'payroll_runs', new.id,
      jsonb_build_object('cycle', new.cycle, 'period_start', new.period_start, 'period_end', new.period_end)
    );
  elsif tg_op = 'UPDATE' then
    if old.status = 'draft' and new.status = 'finalised' then
      perform public._record_activity(
        new.org_id, 'payroll.finalised', 'payroll_runs', new.id,
        jsonb_build_object('cycle', new.cycle, 'period_start', new.period_start, 'period_end', new.period_end)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_runs_activity on public.payroll_runs;
create trigger payroll_runs_activity
  after insert or update on public.payroll_runs
  for each row execute function public._tg_payroll_runs_activity();
