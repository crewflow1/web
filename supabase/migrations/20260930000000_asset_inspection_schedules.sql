-- Asset Management — Milestone 4b (part 2): inspection schedules + idempotent
-- due-work generation.
--
-- Standing rules that generate due inspections: "pre-use check daily", "PAT
-- every 3 months", "7-day scaffold inspection", "thorough-exam reminder
-- annually". The generated due record IS a draft asset_inspection created from
-- the schedule's CURRENT PUBLISHED template version (full frozen snapshot at
-- generation) — no parallel "due" store, the existing inspections UI runs it.
--
-- THE IDEMPOTENCY INVARIANT (house claim doctrine, automation_runs 20260912):
-- one generated inspection per schedule cycle. cycle_key = the due date
-- ('YYYY-MM-DD'); a TOTAL unique index on (schedule_id, cycle_key) makes the
-- generator's INSERT ... ON CONFLICT DO NOTHING the atomic claim — repeated,
-- concurrent and retried runs converge on exactly one row. (Total, not partial:
-- PostgREST's upsert arbiter cannot use a partial index. Manual inspections
-- carry (null, null) and never collide — nulls are distinct.)
--
-- Schedule advancement is a count-gated CAS on next_due (see the generator
-- service) — exactly-once even under concurrent runs. Deliberately NO pair
-- CHECK tying schedule_id to cycle_key on asset_inspections: schedule deletion
-- is `on delete set null` on schedule_id only, which a pair CHECK would turn
-- into an un-deletable schedule.
--
-- `required_for_assignment` is captured now (the pre-use rule of the
-- programme); its ENFORCEMENT lands in the M4d custody-guard replacement so the
-- guard changes exactly once. Additive + dark.

create table if not exists public.asset_inspection_schedules (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations(id) on delete cascade,
  asset_id                uuid not null references public.assets(id) on delete cascade,
  -- The template family is addressed through any of its versions; generation
  -- resolves the family's CURRENT PUBLISHED version each cycle (an archived /
  -- never-published family generates nothing until re-published).
  template_id             uuid not null references public.asset_inspection_templates(id) on delete cascade,
  title                   text,

  -- Cadence: exactly one of days/months for recurring; BOTH NULL = one-off
  -- (generates once, then the generator deactivates the schedule).
  interval_days           integer
    check (interval_days is null or interval_days between 1 and 3660),
  interval_months         integer
    check (interval_months is null or interval_months between 1 and 120),
  constraint asset_inspection_schedules_interval_check
    check (interval_days is null or interval_months is null),

  next_due                date not null,
  last_completed_at       timestamp with time zone,
  -- How many days before next_due the due inspection is generated (0 = on the
  -- day — right for daily pre-use checks; longer for exam reminders).
  lead_time_days          integer not null default 0
    check (lead_time_days between 0 and 365),
  active                  boolean not null default true,

  -- The pre-use seam: "this asset needs a current passing check of this kind
  -- before it can be issued". Captured + surfaced now; ENFORCED at the custody
  -- guard in M4d (single guard replacement).
  required_for_assignment boolean not null default false,

  created_by              uuid references public.users(id) on delete set null,
  created_at              timestamp with time zone not null default now(),
  updated_at              timestamp with time zone not null default now()
);

-- The generator's scan (active schedules by due date) + per-asset listing.
create index if not exists asset_inspection_schedules_due_idx
  on public.asset_inspection_schedules (next_due) where active;
create index if not exists asset_inspection_schedules_asset_idx
  on public.asset_inspection_schedules (asset_id);
create index if not exists asset_inspection_schedules_org_idx
  on public.asset_inspection_schedules (org_id, active);

-- ── Same-org guard ────────────────────────────────────────────────────────────
create or replace function public.tg_asset_inspection_schedules_guard()
returns trigger language plpgsql as $$
declare
  a_org uuid;
begin
  select org_id into a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.asset_inspection_templates t
                 where t.id = new.template_id and t.org_id = new.org_id) then
    raise exception 'template % is not in org %', new.template_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_inspection_schedules_guard on public.asset_inspection_schedules;
create trigger asset_inspection_schedules_guard
  before insert or update on public.asset_inspection_schedules
  for each row execute function public.tg_asset_inspection_schedules_guard();

drop trigger if exists asset_inspection_schedules_set_updated_at on public.asset_inspection_schedules;
create trigger asset_inspection_schedules_set_updated_at
  before update on public.asset_inspection_schedules
  for each row execute function public.tg_set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Schedules are STANDING RULES that generate work automatically — admin-only
-- writes (ai_receptionist_setups precedent); every member can see what's due.
alter table public.asset_inspection_schedules enable row level security;

create policy asset_inspection_schedules_select on public.asset_inspection_schedules
  for select using (org_id in (select public.current_org_ids()));
create policy asset_inspection_schedules_insert on public.asset_inspection_schedules
  for insert with check (public.is_org_admin(org_id));
create policy asset_inspection_schedules_update on public.asset_inspection_schedules
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
create policy asset_inspection_schedules_delete on public.asset_inspection_schedules
  for delete using (public.is_org_admin(org_id));

-- ── Generated-inspection provenance on asset_inspections ─────────────────────
alter table public.asset_inspections
  add column if not exists schedule_id uuid
    references public.asset_inspection_schedules(id) on delete set null,
  add column if not exists cycle_key text;

-- THE claim arbiter (see header). Nulls are distinct ⇒ manual rows never collide.
create unique index if not exists asset_inspections_schedule_cycle_idx
  on public.asset_inspections (schedule_id, cycle_key);

-- Due/overdue views: open (draft) scheduled work by due date.
create index if not exists asset_inspections_due_open_idx
  on public.asset_inspections (org_id, due_at)
  where status = 'draft' and due_at is not null;

-- ── Extend the template guard (CREATE OR REPLACE; prior checks VERBATIM) ─────
-- Adds one arm: a generated inspection's schedule must be same-org. The M4a
-- immutability function remains untouched.
create or replace function public.tg_asset_inspections_template_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if old.template_snapshot is not null
       and new.template_snapshot is distinct from old.template_snapshot then
      raise exception 'asset_inspections.template_snapshot is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
    if old.template_id is not null and new.template_id is distinct from old.template_id then
      raise exception 'asset_inspections.template_id is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
    if old.template_version is not null
       and new.template_version is distinct from old.template_version then
      raise exception 'asset_inspections.template_version is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.template_id is not null
     and not exists (select 1 from public.asset_inspection_templates t
                     where t.id = new.template_id and t.org_id = new.org_id) then
    raise exception 'template % is not in org %', new.template_id, new.org_id
      using errcode = 'check_violation';
  end if;

  if new.schedule_id is not null
     and not exists (select 1 from public.asset_inspection_schedules s
                     where s.id = new.schedule_id and s.org_id = new.org_id) then
    raise exception 'schedule % is not in org %', new.schedule_id, new.org_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists asset_inspections_template_guard on public.asset_inspections;
create trigger asset_inspections_template_guard
  before insert or update on public.asset_inspections
  for each row execute function public.tg_asset_inspections_template_guard();
