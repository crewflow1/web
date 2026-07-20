-- Programme C — construction retention (contract holdback).
--
-- UK construction contracts withhold a retention percentage (typically 3–5%)
-- from certified/invoiced value as security, released in stages at practical
-- completion and end of the defects-liability period. CrewFlow had NO model
-- for this — retention was invisible in the commercial picture.
--
-- This is a COMMERCIAL holdback, not a CIS/HMRC tax deduction: it changes when
-- money is received, never what tax is due. No CIS logic is introduced here.
--
-- Model (additive, extends jobs + a new append-only ledger):
--   - jobs.retention_percent    → the contract retention rate.
--   - retention_releases        → immutable record of retention released back
--                                 (i.e. paid by the customer) over time.
--   - held retention is DERIVED: rate% × non-draft invoiced NET value − released
--     (never stored/mutated — the same derive-don't-duplicate rule as the job
--     commercial position). Retention accrues on the ex-VAT works value, the
--     UK convention; VAT is not retained.
--
-- Invariants (DB-enforced, hold for every writer):
--   - retention_percent ∈ [0,100].
--   - a release amount is positive.
--   - a release's org_id matches its job's org (tenant integrity).
--   - total released can never exceed accrued retention (no over-release).
--   - a recorded release is immutable (UPDATE blocked for ALL roles; append-only
--     financial fact). DELETE stays open so a job/org ON DELETE CASCADE works
--     and an admin can cancel an erroneous release (RLS restricts it to admins).

-- ── 1. Contract retention rate on the job ────────────────────────────────────
alter table public.jobs
  add column if not exists retention_percent numeric(5, 2) not null default 0
    check (retention_percent >= 0 and retention_percent <= 100);

-- ── 2. Retention release ledger (append-only) ────────────────────────────────
create table if not exists public.retention_releases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  amount      numeric(12, 2) not null check (amount > 0),
  released_on date not null default current_date,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists retention_releases_job_idx on public.retention_releases (job_id);
create index if not exists retention_releases_org_idx on public.retention_releases (org_id);

-- ── 3. RLS — members read/record within their org; admins can cancel ─────────
alter table public.retention_releases enable row level security;

drop policy if exists "retention_releases: members can select" on public.retention_releases;
create policy "retention_releases: members can select" on public.retention_releases
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

drop policy if exists "retention_releases: members can insert" on public.retention_releases;
create policy "retention_releases: members can insert" on public.retention_releases
  for insert to authenticated
  with check (org_id in (select public.current_org_ids()));

-- No UPDATE policy → updates are denied by RLS (and blocked outright below).
drop policy if exists "retention_releases: admins can delete" on public.retention_releases;
create policy "retention_releases: admins can delete" on public.retention_releases
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- ── 4. Immutability — a recorded release never changes ───────────────────────
create or replace function public.tg_retention_releases_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'retention release % is immutable — cancel and re-record instead', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists retention_releases_no_update on public.retention_releases;
create trigger retention_releases_no_update before update on public.retention_releases
  for each row execute function public.tg_retention_releases_immutable();

-- ── 5. Guard — org consistency + no over-release ─────────────────────────────
-- SECURITY DEFINER so accrued is computed from the FULL invoice/job truth
-- regardless of the caller's row visibility; search_path pinned.
create or replace function public.tg_retention_release_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate     numeric;
  v_org      uuid;
  v_base     numeric;
  v_accrued  numeric;
  v_released numeric;
begin
  select retention_percent, org_id into v_rate, v_org
  from public.jobs where id = new.job_id;

  if v_org is null then
    raise exception 'retention release: job % not found', new.job_id
      using errcode = 'check_violation';
  end if;
  if new.org_id <> v_org then
    raise exception 'retention release: org mismatch for job %', new.job_id
      using errcode = 'check_violation';
  end if;

  -- Accrued = rate% of non-draft invoiced NET (ex-VAT) value on the job.
  select coalesce(sum(amount), 0) into v_base
  from public.invoices
  where job_id = new.job_id and status <> 'draft';
  v_accrued := round(v_rate / 100.0 * v_base, 2);

  select coalesce(sum(amount), 0) into v_released
  from public.retention_releases
  where job_id = new.job_id;

  -- +0.005 tolerance absorbs 2dp rounding at the boundary.
  if v_released + new.amount > v_accrued + 0.005 then
    raise exception
      'retention release exceeds held retention (accrued %, already released %, requested %)',
      v_accrued, v_released, new.amount
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists retention_releases_guard on public.retention_releases;
create trigger retention_releases_guard before insert on public.retention_releases
  for each row execute function public.tg_retention_release_guard();
