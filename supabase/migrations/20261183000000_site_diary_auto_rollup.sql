-- Site Diary — automatic end-of-day roll-up: provenance + idempotency.
--
-- The daily `site-diary-rollup` cron composes ONE diary entry per active job
-- from that day's real site activity (photos, snags, deliveries/GRNs, time on
-- site). Two things must be structurally true for that to be safe:
--
--   1. An auto entry must be DISTINGUISHABLE from a person's own account. A
--      `source` column marks every row `manual` (the default, and what every
--      existing row backfills to) or `auto_rollup`. The roll-up writes only the
--      latter; a human's entry is never relabelled.
--
--   2. The roll-up must be IDEMPOTENT and must never collide with a manual
--      entry. A PARTIAL unique index on (org_id, job_id, entry_date) scoped to
--      `source='auto_rollup'` guarantees AT MOST ONE auto entry per job/day — so
--      a re-run refreshes in place and a concurrent double-run raises 23505
--      instead of duplicating. Because the index is partial (auto rows only), a
--      MANUAL entry for the same job/day is completely unaffected: the two never
--      contend for the same key, and the cron additionally skips a job/day that
--      already has a manual entry.
--
-- Additive, dark-safe and reversible: one column with a default (no rewrite of
-- meaning for existing rows) plus one partial index. Nothing reads `source`
-- until this ships. Reverse: drop the index, drop the constraint, drop the column.

alter table public.site_diary_entries
  add column if not exists source text not null default 'manual';

-- Constrain the vocabulary. Guarded so a re-apply is a no-op (the constraint is
-- not `add ... if not exists`-able directly).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'site_diary_entries_source_check'
  ) then
    alter table public.site_diary_entries
      add constraint site_diary_entries_source_check
      check (source in ('manual', 'auto_rollup'));
  end if;
end $$;

-- THE idempotency guard: one auto roll-up per (org, job, day). Partial on
-- auto rows AND on a present job (an auto entry is always job-scoped), so manual
-- entries — and the historic NULL-job diary rows — are entirely outside it.
create unique index if not exists site_diary_entries_auto_rollup_uidx
  on public.site_diary_entries (org_id, job_id, entry_date)
  where source = 'auto_rollup' and job_id is not null;

comment on column public.site_diary_entries.source is
  'Provenance: ''manual'' (a person authored it — the default and every legacy row) '
  'or ''auto_rollup'' (composed by the site-diary-rollup cron from the day''s recorded '
  'activity). The partial unique index site_diary_entries_auto_rollup_uidx makes the '
  'auto roll-up idempotent per (org_id, job_id, entry_date) without ever touching a manual entry.';
