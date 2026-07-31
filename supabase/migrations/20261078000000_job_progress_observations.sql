-- Job progress tracking — the TIME SERIES behind "how far along are we?".
--
-- THE GAP (STATUS.md Phase 4, "Progress tracking — PARTIAL"): `progress_percent`
-- already ships inside `site_reports.content` (validated 0–100, surfaced to the
-- customer portal). So a client can be told "we're 60% done" — but nobody, not
-- the contractor and not the client, can see whether that 60% arrived on plan or
-- three weeks late, or whether it has moved at all since May. On a real job the
-- TREND is the information; the instantaneous number is nearly worthless.
--
-- This migration adds the missing dimension: dated observations of percent
-- complete, per job, with author, note and provenance.
--
-- =========================================================================
-- DESIGN DECISION 1 — site_reports.progress_percent IS READ AS A SOURCE.
--                     IT IS NOT COPIED HERE. ENFORCED BY SHAPE.
-- =========================================================================
-- The obvious implementation is a `source` column ('manual' | 'site_report')
-- and a trigger that materialises each report's progress figure into this
-- table. That is REJECTED, deliberately, and the rejection is enforced
-- structurally: this table has NO source column and NO report_id, so a report's
-- figure is not REPRESENTABLE here. There is exactly one place a given number
-- lives.
--
-- Why it matters, concretely. `site_reports.content` is an editable draft until
-- issue (tg_site_reports_immutable, 20260922, freezes it only at
-- issued/superseded/archived). A copy made at report-creation time would go
-- stale the moment an author corrected a typo'd 6% to 60%, and NOTHING would
-- reconcile the two. The series would then disagree with the report the client
-- was actually sent — the single worst failure mode a progress chart can have.
--
-- So the SERIES IS A UNION COMPUTED AT READ TIME:
--     manual observations (this table)  ∪  site-report figures (site_reports)
-- merged by lib/job-progress/series.ts. Provenance is a property of the merged
-- POINT (`source: 'observation' | 'site_report'`), not of a stored row — because
-- every row stored HERE is, by construction, a manual observation.
--
-- Which reports contribute is decided in the pure lib, not here (this migration
-- adds no view and no trigger over site_reports — that table is another lane's
-- and is left byte-for-byte untouched).
--
-- =========================================================================
-- DESIGN DECISION 2 — JOB-LEVEL, NOT PER-WORK-SECTION. CHECKED, NOT ASSUMED.
-- =========================================================================
-- A per-section series ("groundworks 80%, first fix 20%") is the richer model
-- and is what a real programme wants. It requires a WORK BREAKDOWN — a set of
-- sections to hang percentages on.
--
-- CrewFlow HAS NO WORK-BREAKDOWN CONCEPT. Established by search across all 232
-- migrations and the whole TS/TSX tree: no work_section, work_breakdown, wbs,
-- work_package, programme_task, programme_activity or gantt table, type or
-- column exists anywhere. The nearest neighbours are all something else —
-- `job_billing_stages` is a PAYMENT schedule (see decision 4), and
-- `site_reports.content.current_phase` is free text, not an entity.
--
-- Inventing a work breakdown inside a progress migration would be inventing the
-- wrong thing in the wrong place: a WBS is a scheduling primitive that snags,
-- diary entries, material requests and billing all eventually want to hang off.
-- So M1 is JOB-LEVEL, and the unique key below is (job_id, observed_on).
-- Adding sections later is an additive column + a widened unique key; no stored
-- value has to be remapped, because a job-level observation is exactly the
-- section-less case.
--
-- =========================================================================
-- DESIGN DECISION 3 — THERE IS NO HONEST PLANNED BASELINE. NONE IS FAKED.
-- =========================================================================
-- An S-curve is meaningful because ACTUAL is drawn against PLANNED. So: can a
-- planned line be derived from data the platform already holds? The candidates
-- were enumerated and every one fails:
--
--   * `jobs.scheduled_date` — ONE date, and it is the date the job is booked
--     into the calendar/rota, not a start-of-works. There is no matching end
--     date anywhere on `jobs`. A single point cannot define a curve.
--   * `jobs.practical_completion_date` — its own column comment (20261013) says
--     "Nullable until PC is reached". It is the ACTUAL completion date recorded
--     retrospectively, not a target. Using an actual as a plan makes every
--     variance identically zero — a number that is always right and never
--     useful.
--   * `job_billing_stages.due_date` — a PAYMENT due date. Treating money dates
--     as progress dates is precisely the conflation decision 4 forbids.
--   * Grep for planned_*/baseline_*/programme_* across all migrations: ZERO
--     hits. The platform holds no programme.
--
-- The tempting move is to draw a straight line from 0% on some start date to
-- 100% on some end date and label it "planned". THAT IS REFUSED. Construction
-- progress is never linear (it is S-shaped precisely because mobilisation and
-- commissioning are slow and the middle is fast), so a straight line is not an
-- approximation of a plan — it is a fabrication. And every variance measured
-- against a fabricated baseline is a lie with a number attached, which is worse
-- than no number at all because it looks like evidence.
--
-- SO: this migration ships ACTUAL PROGRESS OVER TIME. The UI states plainly
-- that the planned curve needs a programme/baseline the platform does not yet
-- hold. When a programme lands, the baseline is an additive sibling table
-- (job_progress_baselines) and the same curve renders two lines. Nothing here
-- has to change.
--
-- =========================================================================
-- DESIGN DECISION 4 — NO FINANCES, NO PAYMENT LINK. STRUCTURALLY.
-- =========================================================================
-- Percent-complete IS NOT A VALUATION. This table therefore has NO amount, NO
-- currency, NO FK to finances / invoices / payments / job_billing_plans /
-- job_billing_stages, and NO trigger that writes to any of them. There is no
-- column a valuation could be stored in and no edge a billing trigger could
-- travel along.
--
-- This is a product boundary, not squeamishness. Staged billing ALREADY EXISTS
-- (job_billing_plans + job_billing_stages + generate_stage_invoice, 20261039)
-- and it is deliberately DATE/MILESTONE driven with an explicit human act per
-- stage. If "60% complete" could raise an invoice, CrewFlow would have grown a
-- SECOND, rival billing authority with weaker controls — one that any org
-- member can trigger by typing a number into a phone. Application-for-payment
-- valuation is real UK construction work, but it is the commercial lane's, it
-- is adversarial (assessed, certified, disputed), and it must never be a
-- side-effect of a site update. Asserted by
-- __tests__/security/job-progress-no-billing-link.test.ts.
--
-- =========================================================================
-- DESIGN DECISION 5 — PROGRESS CAN GO DOWN. NO MONOTONIC CONSTRAINT.
-- =========================================================================
-- Rework, a failed/rejected inspection, a re-measure, or an over-optimistic
-- earlier claim all legitimately move the number DOWN. There is deliberately no
-- constraint or trigger requiring percent >= the previous observation. A model
-- that cannot represent a regression would force site staff to either lie or
-- stop recording — and a progress log people work around is worse than none.
-- Covered by an explicit regression case in both the unit and integration
-- suites.
--
-- =========================================================================
-- ORG-TEARDOWN SAFETY (the 20261052 lesson)
-- =========================================================================
-- `delete from organizations` must keep working. Every path off this table is
-- CASCADE; there is NO `on delete restrict` anywhere, on this table or added to
-- any other. Both routes a cascade can take are safe:
--     organizations -> job_progress_observations           (cascade, direct)
--     organizations -> jobs -> job_progress_observations   (cascade, composite FK)
-- and `recorded_by` is ON DELETE SET NULL so removing a user never blocks.
--
-- This table also gets NO activity trigger. 20261052's failure was an
-- AFTER-DELETE activity trigger on a cascade child inserting into activity_log,
-- whose own org FK the cascade had already removed. Not adding one keeps this
-- table structurally outside that failure class rather than relying on the
-- guard that fixed it.
--
-- Additive and reversible. To roll back:
--   drop table public.job_progress_observations;
--   drop function public.tg_job_progress_observation_guard();
--   -- jobs_id_org_key is left: it is a harmless superset-of-PK candidate key
--   -- that other lanes' composite FKs may by then also target.

-- ── 1. The candidate key the composite FK needs ─────────────────────────────
-- `id` is already the PRIMARY KEY of public.jobs, so a unique constraint on the
-- SUPERSET (id, org_id) can never reject a row: it is a no-op for all existing
-- data and simply gives composite FKs something to point at. Exactly the idiom
-- 20261056 (assets), 20261059 (purchase_orders) and 20261064 (sites) used.
-- Introspection-guarded so it is idempotent and cannot collide with a
-- concurrent lane adding the same key.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_id_org_key') then
    alter table public.jobs add constraint jobs_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. job_progress_observations ────────────────────────────────────────────
create table if not exists public.job_progress_observations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- NOT NULL, unlike the nullable job_id every sibling site record uses
  -- (snags 20260919, site_diary 20260920, material_requests 20261066). Those
  -- keep their row when the job goes because a defect or a purchase has
  -- standalone value. A progress observation does not: "60% complete" with no
  -- job it describes is not a degraded record, it is a meaningless one.
  --
  -- Because the correct behaviour on job-delete is CASCADE (not SET NULL), the
  -- composite FK that 20261066 note 3 could not use is available here — and it
  -- is strictly stronger: it makes an observation against ANOTHER TENANT'S job
  -- unrepresentable for EVERY role, including service_role, with no trigger to
  -- audit or bypass.
  job_id       uuid not null,

  -- The DAY THE ASSESSMENT DESCRIBES — not when it was typed in. Back-dating
  -- ("Friday's walk-round, logged Monday") is legitimate and supported;
  -- future-dating is not, and is refused by the guard trigger below.
  observed_on  date not null default ((now() at time zone 'Europe/London')::date),

  -- Percent complete, 0–100 inclusive. Integer, matching the existing
  -- validation on site_reports.content.progress_percent
  -- (lib/site-reports/schema.ts: z.coerce.number().int().min(0).max(100)) so a
  -- figure means the same thing on both sides of the union. Deliberately NOT
  -- constrained relative to any other row — see decision 5.
  percent      integer not null check (percent >= 0 and percent <= 100),

  -- INTERNAL commentary ("held up waiting on the steel"). NEVER crosses the
  -- customer boundary: lib/job-progress/portal.ts cannot represent it, so no
  -- future edit to the portal can leak it (the portal-schedule.ts pattern).
  note         text check (note is null or length(note) <= 2000),

  -- PROVENANCE. `recorded_by` is who assessed it; `created_at` is when the
  -- record was made, which is distinct from `observed_on` (what day it is
  -- about) — together they are what lets a disputed figure be traced.
  -- SET NULL so a leaver never blocks teardown and never deletes site history.
  recorded_by  uuid references public.users(id) on delete set null,

  created_at   timestamp with time zone not null default now(),
  updated_at   timestamp with time zone not null default now(),

  -- Cross-tenant impossibility + cascade-on-job-delete, in one constraint.
  constraint job_progress_observations_job_fkey
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,

  -- ONE OBSERVATION PER JOB PER DAY. A time series needs exactly one y per x;
  -- allowing several and picking a winner at read time would put the tie-break
  -- rule in the renderer, where it can drift. A same-day reassessment is an
  -- UPDATE of that day's row, which is also what makes a correction auditable
  -- (updated_at moves) rather than additive noise.
  constraint job_progress_observations_job_day_key unique (job_id, observed_on),

  -- Candidate key for any future child relation's composite, org-binding FK.
  constraint job_progress_observations_id_org_key unique (id, org_id)
);

-- The one hot path: "this job's series, oldest first" — the curve's own order.
create index if not exists job_progress_observations_job_idx
  on public.job_progress_observations (job_id, observed_on);
-- Org-pinned listing ("what has moved lately across the business").
create index if not exists job_progress_observations_org_idx
  on public.job_progress_observations (org_id, observed_on desc);

alter table public.job_progress_observations enable row level security;

-- Members record and correct progress; recording it is site work, not an
-- administrative act, so INSERT/UPDATE are member-level (the snags 20260919 /
-- site_diary 20260920 idiom). Hard DELETE is admin-only: the series is the
-- evidence of how a job actually ran, so a member corrects a figure rather than
-- erasing the day it was observed.
create policy job_progress_observations_select on public.job_progress_observations
  for select using (org_id in (select public.current_org_ids()));
create policy job_progress_observations_insert on public.job_progress_observations
  for insert with check (org_id in (select public.current_org_ids()));
create policy job_progress_observations_update on public.job_progress_observations
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy job_progress_observations_delete on public.job_progress_observations
  for delete using (public.is_org_admin(org_id));

drop trigger if exists job_progress_observations_set_updated_at
  on public.job_progress_observations;
create trigger job_progress_observations_set_updated_at
  before update on public.job_progress_observations
  for each row execute function public.tg_set_updated_at();

-- ── 3. Guard: honest dates, honest authorship ───────────────────────────────
-- The job's tenancy is already guaranteed by the composite FK, so — unlike
-- tg_material_request_org_integrity (20261066) — this trigger does NOT re-check
-- it. It covers only what a constraint cannot express:
--
--   a) NO FUTURE OBSERVATIONS. A point dated next month drags the curve into
--      territory nobody has walked and makes "days since last update" read 0 on
--      a job that has been silent for weeks. The comparison is against the
--      EUROPE/LONDON day, not the server's UTC day (the 20261070 idiom): at
--      00:30 BST a UK user is still on the previous UTC date, and a UTC
--      comparison would reject their entirely valid "today".
--
--   b) THE AUTHOR MUST BE A MEMBER OF THIS ORG. Mirrors the GRN received_by
--      guard (20261059) and the material-request requester guard (20261066).
--      Without it a forged recorded_by would put another tenant's staff name
--      against this org's progress figure — a name leak in a disputed record.
create or replace function public.tg_job_progress_observation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.observed_on > ((now() at time zone 'Europe/London')::date) then
    raise exception 'progress cannot be observed in the future (% is after today)',
      new.observed_on
      using errcode = 'check_violation';
  end if;

  if new.recorded_by is not null
     and not exists (select 1 from public.memberships
                      where user_id = new.recorded_by and org_id = new.org_id) then
    raise exception 'progress observation: % is not a member of this org', new.recorded_by
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists job_progress_observations_guard on public.job_progress_observations;
create trigger job_progress_observations_guard
  before insert or update on public.job_progress_observations
  for each row execute function public.tg_job_progress_observation_guard();

comment on table public.job_progress_observations is
  'Dated job-level percent-complete observations — the ACTUAL progress time series. '
  'Site-report progress figures are NOT copied here; they are read from site_reports '
  'and merged at read time by lib/job-progress/series.ts (one source of truth). '
  'Carries no money and no billing link by design: percent-complete is not a valuation.';
comment on column public.job_progress_observations.observed_on is
  'The Europe/London calendar day the assessment describes (not when it was entered). '
  'Back-dating is allowed; future-dating is refused by tg_job_progress_observation_guard.';
comment on column public.job_progress_observations.note is
  'INTERNAL commentary. Never surfaced to the customer portal — the portal DTO in '
  'lib/job-progress/portal.ts cannot represent it.';
