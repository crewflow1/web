-- Retention Release Scheduling (Programme C extension).
--
-- Adds the contract TERMS that let CrewFlow forecast WHEN held retention is due
-- back to the builder: the Practical Completion date, the Defects Liability
-- Period (months, UK convention), and the % released at PC. All three sit on
-- `jobs` (1:1 with the job, same admin-only UPDATE RLS as `retention_percent`) —
-- not a satellite table, so the dashboard rollup rides the existing jobs
-- bulk-select.
--
-- The SCHEDULE itself is DERIVED (`lib/retentions/schedule.ts`), never stored:
-- accrued retention keeps moving as work is invoiced, and the `retention_releases`
-- ledger is the immutable source of truth. So this is a light-DB milestone —
-- only range CHECKs. The money-moving invariant (no over-release) already lives
-- in `tg_retention_release_guard` (20261005); nothing here touches the cash path.
--
-- Additive columns with constant defaults = metadata-only on PG15 (no table
-- rewrite). `lock_timeout` bounds the brief ACCESS EXCLUSIVE lock so a busy
-- `jobs` table is never stalled behind this DDL.
set local lock_timeout = '5s';

alter table public.jobs
  add column if not exists practical_completion_date date,
  add column if not exists defects_liability_months integer not null default 12
    check (defects_liability_months >= 0 and defects_liability_months <= 120),
  add column if not exists retention_first_release_pct numeric(5, 2) not null default 50
    check (retention_first_release_pct >= 0 and retention_first_release_pct <= 100);

comment on column public.jobs.practical_completion_date is
  'Practical Completion date — starts the defects-liability clock; the retention release forecast anchors here. Nullable until PC is reached.';
comment on column public.jobs.defects_liability_months is
  'Defects Liability / rectification period in months (UK convention, e.g. 6/12/24). The second retention moiety is due FROM practical_completion_date + this.';
comment on column public.jobs.retention_first_release_pct is
  'Percentage of accrued retention released at Practical Completion (JCT default 50; 100 = a single release at PC).';
