-- Per-job checklists — a lightweight "did we do these steps" list with
-- completion tracking, distinct from snags (defects to fix) and the ITP quality
-- plan (controlled inspection & test hold points).
--
-- THE GAP THIS CLOSES. A job today has snags and a quality plan but no plain
-- checklist: "isolate supply / lay dust sheets / photograph meter reading /
-- clear waste". These are not defects and not controlled inspections — they are
-- the crew's own run-list. Templates (20261132000001) clone a starter checklist
-- onto a new job; this table is where those items live and get ticked.
--
-- ── COMPLETION IS TRUTHFUL BY TRIGGER, NOT BY THE CLIENT ─────────────────────
-- is_done is the only field a member flips. A BEFORE trigger stamps done_at /
-- done_by from the transition itself (auth.uid(), now()) and CLEARS them on
-- un-tick, so "who ticked this and when" cannot be spoofed by a crafted payload
-- and cannot drift from is_done. Re-ticking an already-done item does not
-- re-stamp the time (the tick that mattered is the first one).
--
-- ── MEMBER-WRITABLE ON PURPOSE ───────────────────────────────────────────────
-- Unlike the programme baseline (admin-only planning config), a checklist is
-- the working crew's list: any org member may add, tick, and remove items. RLS
-- is the outer tenant boundary; the app pins the ACTIVE org on every write.
-- There is NO cross-job move — an item is bound to its job by composite FK.
--
-- ── TENANCY IS STRUCTURAL ────────────────────────────────────────────────────
-- (job_id, org_id) → jobs(id, org_id) [jobs_id_org_key, 20261072], so a forged
-- job id cannot cross tenants. Also unique (id, org_id) so future children can
-- bind by composite FK. ON DELETE CASCADE, teardown-safe.
--
-- Additive and reversible. To roll back:
--   drop table public.job_checklists;
--   drop function public.tg_job_checklist_completion();
-- Depends on: jobs_id_org_key (20261072).

create table if not exists public.job_checklists (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  job_id         uuid not null,
  label          text not null check (length(trim(label)) >= 1 and char_length(label) <= 300),
  -- A hint from a template that this step wants a photo. Purely advisory here —
  -- the app surfaces it; enforcement (if ever) is a later product decision.
  requires_photo boolean not null default false,
  is_done        boolean not null default false,
  -- Stamped/cleared by the trigger below, never trusted from the client.
  done_by        uuid references public.users(id) on delete set null,
  done_at        timestamptz,
  sort           int not null check (sort >= 1),
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint job_checklists_job_fk
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,
  constraint job_checklists_id_org_key unique (id, org_id)
);

create index if not exists job_checklists_org_job_idx
  on public.job_checklists (org_id, job_id, sort);

-- Completion provenance is derived from the is_done transition, for every role.
create or replace function public.tg_job_checklist_completion()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.is_done then
      new.done_at := coalesce(new.done_at, now());
      new.done_by := coalesce(new.done_by, auth.uid());
    else
      new.done_at := null;
      new.done_by := null;
    end if;
    return new;
  end if;
  -- UPDATE: react only to a real is_done change; leave a stable done stamp alone.
  if new.is_done and not old.is_done then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.is_done and old.is_done then
    new.done_at := null;
    new.done_by := null;
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
  end if;
  return new;
end $$;

drop trigger if exists job_checklists_completion on public.job_checklists;
create trigger job_checklists_completion
  before insert or update on public.job_checklists
  for each row execute function public.tg_job_checklist_completion();

-- ── RLS — members read + write within their org ──────────────────────────────
alter table public.job_checklists enable row level security;

drop policy if exists "job_checklists: members can select" on public.job_checklists;
create policy "job_checklists: members can select" on public.job_checklists
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_checklists: members can insert" on public.job_checklists;
create policy "job_checklists: members can insert" on public.job_checklists
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "job_checklists: members can update" on public.job_checklists;
create policy "job_checklists: members can update" on public.job_checklists
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "job_checklists: members can delete" on public.job_checklists;
create policy "job_checklists: members can delete" on public.job_checklists
  for delete to authenticated using (org_id in (select public.current_org_ids()));
