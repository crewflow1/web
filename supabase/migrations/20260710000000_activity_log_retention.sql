-- F-8: activity_log retention MECHANISM (no data is deleted on apply).
--
-- public.activity_log is an append-only audit/feed table written by the
-- 13 SECURITY DEFINER `_tg_*_activity` triggers (jobs / quotes / invoices /
-- finances / leads / customers) plus admin + cron writes. Every business
-- mutation appends a row and nothing ever prunes them, so the table is the
-- fastest-growing relation in the schema: at 200 active orgs each doing dozens
-- of mutations/day it accrues millions of rows/year. Per-org reads stay fast
-- (they ride activity_log_org_created_idx), but unbounded growth steadily
-- inflates storage, backup/PITR size, autovacuum cost and index depth.
--
-- This migration adds the MECHANISM to trim the feed and NOTHING ELSE — it does
-- not delete a single row when applied. Deletion only ever happens when an
-- operator deliberately invokes purge_activity_log() (see the runbook +
-- docs/activity-log-retention.md and the OPTIONAL schedule block at the bottom,
-- which is documentation, not executable SQL).
--
-- SCOPE NOTE — this trims the activity FEED only. The financial RECORDS that
-- HMRC retention applies to (invoices, finances, quotes, payments) live in
-- their own tables and are NOT touched here. Choose a retention window that
-- satisfies your own audit policy before enabling (default below is generous).
--
-- Idempotent: CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and
-- REVOKE of an absent privilege is a no-op. Safe to (re)apply.

-- ---------------------------------------------------------------------------
-- 1) Supporting index for the global age predicate.
--    The existing indexes are all (org_id, created_at ...) — org_id-leading,
--    so a cross-org `where created_at < cutoff` can't use them. This plain
--    (created_at) btree lets the batched purge below do an index range scan.
--    Cheap on write: activity_log is append-mostly and created_at ≈ now(), so
--    inserts land at the right edge with minimal churn.
-- ---------------------------------------------------------------------------
create index if not exists activity_log_created_at_idx
  on public.activity_log (created_at);

-- ---------------------------------------------------------------------------
-- 2) purge_activity_log(retention, batch) — the mechanism.
--    Deletes activity_log rows older than (now() - p_retention), in chunks of
--    p_batch so a single statement never builds an unbounded delete set.
--    Returns the number of rows removed. SECURITY DEFINER so an operator/cron
--    on the service role can run maintenance regardless of RLS (there is no
--    DELETE policy on activity_log — triggers are the only writers).
-- ---------------------------------------------------------------------------
create or replace function public.purge_activity_log(
  p_retention interval default interval '24 months',
  p_batch     integer  default 5000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff  timestamptz := now() - p_retention;
  v_deleted integer := 0;
  v_chunk   integer;
begin
  if p_batch is null or p_batch <= 0 then
    raise exception 'purge_activity_log: p_batch must be a positive integer (got %)', p_batch
      using errcode = '22023';
  end if;
  if p_retention is null or p_retention < interval '0' then
    raise exception 'purge_activity_log: p_retention must be a non-negative interval (got %)', p_retention
      using errcode = '22023';
  end if;

  -- Batched delete: each pass removes the oldest <= p_batch rows past the
  -- cutoff and stops as soon as a pass deletes nothing.
  loop
    delete from public.activity_log
    where id in (
      select id
      from public.activity_log
      where created_at < v_cutoff
      order by created_at
      limit p_batch
    );
    get diagnostics v_chunk = row_count;
    v_deleted := v_deleted + v_chunk;
    exit when v_chunk = 0;
  end loop;

  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Lock the mechanism to the service role.
--    Supabase runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON
--    FUNCTIONS TO anon, authenticated, service_role`, so a new function is
--    callable by anon + authenticated unless revoked. A tenant must never be
--    able to erase audit history, so revoke PUBLIC/anon/authenticated; the
--    postgres owner (and pg_cron, which runs as a superuser/owner) keep EXECUTE,
--    as does service_role via the surviving default grant.
-- ---------------------------------------------------------------------------
revoke execute on function public.purge_activity_log(interval, integer)
  from public, anon, authenticated;

-- ===========================================================================
-- OPTIONAL — schedule the purge (operator opt-in; intentionally NOT enabled).
-- ===========================================================================
-- Everything above is just a function + an index; applying this migration
-- deletes nothing. To enable periodic trimming, an operator deliberately runs
-- ONE of the following (full guidance in docs/activity-log-retention.md):
--
--   -- (a) pg_cron, if the extension is enabled — 03:30 on the 1st each month:
--   -- select cron.schedule(
--   --   'purge-activity-log',
--   --   '30 3 1 * *',
--   --   $cron$ select public.purge_activity_log(interval '24 months') $cron$
--   -- );
--
--   -- (b) one-off manual run from the SQL editor (service role):
--   -- select public.purge_activity_log(interval '24 months');
--
-- None of the lines above execute on apply — they are commented documentation.
-- Purging activity_log is always an explicit, human-initiated action.
