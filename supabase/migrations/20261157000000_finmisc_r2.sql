-- MP Wave R2 — finance-depth misc. TWO additive, constant-default column
-- groups; no table rewrite on PG15, no data movement, no cash-path trigger
-- touched. Both are metadata-only DDL behind a bounded lock.
--
-- Suggested single-concern name was `vat_stagger`; the wave was allotted ONE
-- migration prefix (20261157000000) and it carries two independent finance
-- schema concerns, so the file is named for the wave. Each concern is sectioned
-- and commented in full below.
--
-- ── 1. VAT STAGGER (org VAT return period group) ────────────────────────────
-- The deterministic VAT authority (lib/tax/compute.ts computeVatQuarter) is
-- period-agnostic — it sums over a [start, end) window a CALLER supplies. Until
-- now every caller derived that window as a CALENDAR quarter
-- (startOfQuarterIso / endOfQuarterExclusiveIso). HMRC assigns each VAT-
-- registered business one of three quarterly "staggers", or monthly returns:
--   group_1  periods END Mar/Jun/Sep/Dec  (== calendar quarter — the default)
--   group_2  periods END Apr/Jul/Oct/Jan
--   group_3  periods END Feb/May/Aug/Nov
--   monthly  one calendar month per return
-- This column records which stagger an org files on. The period-SELECTION math
-- is generalised in lib/tax/compute.ts (staggerVatPeriod*); computeVatQuarter
-- itself is UNCHANGED — there is still exactly one VAT calculator. Default
-- 'group_1' reproduces the current calendar-quarter behaviour EXACTLY, so no
-- existing org's figures move.
--
-- Home: org_settings (20261146000000) — admin-write / member-read, one row per
-- org, absence = defaults. A member cannot change the org's VAT stagger even by
-- calling the API directly (DB-enforced). Non-PII business configuration; the
-- table is already registered in lib/gdpr/org-tables.json (known, not excluded),
-- so the DSAR census stays green with no reverse-direction drift.
set local lock_timeout = '5s';

alter table public.org_settings
  add column if not exists vat_stagger text not null default 'group_1'
    check (vat_stagger in ('group_1', 'group_2', 'group_3', 'monthly'));

comment on column public.org_settings.vat_stagger is
  'HMRC VAT return period cadence: group_1 (Mar/Jun/Sep/Dec — calendar quarter, DEFAULT), group_2 (Apr/Jul/Oct/Jan), group_3 (Feb/May/Aug/Nov), or monthly. Drives VAT-period SELECTION only (lib/tax/compute.ts staggerVatPeriod*); the VAT calculator computeVatQuarter is unchanged. Default reproduces existing calendar-quarter behaviour.';

-- ── 2. RETENTION RELEASE REMINDER MARKERS ───────────────────────────────────
-- The retention release schedule (lib/retentions/schedule.ts) forecasts WHEN a
-- job's two held-retention moieties are due back to the builder (first at
-- Practical Completion, second at PC + Defects Liability Period). That forecast
-- was a PASSIVE dashboard number — nobody was ever told a release had come due.
-- A daily cron (app/api/cron/retention-reminders) now emits a notification when
-- a moiety with unreleased retention reaches its due date.
--
-- IDEMPOTENCY is a per-moiety once-ever guard, the SAME shape compliance-expiry
-- uses (reminded_*_at self-excluding markers on the row): the cron CAS-claims a
-- marker (`update … where marker is null returning id`) before it emits, so a
-- retried, concurrent or re-scanned run fires each moiety EXACTLY once. The
-- markers live on `jobs` (1:1 with the job, same admin-only UPDATE RLS as the
-- other retention columns 20261013000000) — no satellite table, so the cron
-- rides the existing jobs bulk-select and no new GDPR table registration is
-- required (jobs is already exported). The SCHEDULE stays derived; these two
-- columns record only dispatch state, never money.
--
-- Additive, nullable, no default value written = metadata-only on PG15.
alter table public.jobs
  add column if not exists retention_first_reminded_at timestamptz,
  add column if not exists retention_second_reminded_at timestamptz;

comment on column public.jobs.retention_first_reminded_at is
  'Dispatch marker: when the first retention moiety (release at Practical Completion) release-due reminder was emitted. NULL = not yet reminded. CAS-claimed by the retention-reminders cron so each moiety fires exactly once. Not money.';
comment on column public.jobs.retention_second_reminded_at is
  'Dispatch marker: when the second retention moiety (release at end of Defects Liability Period) release-due reminder was emitted. NULL = not yet reminded. CAS-claimed by the retention-reminders cron so each moiety fires exactly once. Not money.';
