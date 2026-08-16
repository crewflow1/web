-- Automation OS — dead-letter alerting (MP R4b).
--
-- The dispatcher (server/services/automation-dispatcher.ts) already records one
-- `automation_runs` row per (rule_id, correlation_id) and RELEASES a failed run
-- (status='failed', completed_at NULL) so a re-fired event can reclaim + retry it.
-- What was missing: when the SAME occurrence keeps failing, nobody is told. The
-- failure count was invisible — a rule could fail forever and only a manual query
-- of automation_runs would reveal it.
--
-- This migration adds the two columns the dispatcher needs to (a) count attempts
-- per occurrence and (b) raise a ONE-SHOT dead-letter alert once a threshold is
-- crossed, plus the atomic increment function that makes both race-safe.
--
-- ADDITIVE ONLY. No existing column, index, constraint, trigger, or the live
-- `invoice.overdue` path is touched. `add column if not exists` with a constant
-- default is a metadata-only change on modern Postgres (no table rewrite).

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------

alter table public.automation_runs
  -- Cumulative failed-dispatch count for this (rule_id, correlation_id). Survives
  -- reclaims (the reclaim UPDATE never resets it), so it is the true "how many
  -- times has this occurrence failed" clock. A run that eventually succeeds keeps
  -- whatever count it reached; success is proven by completed_at, not by this.
  add column if not exists attempts integer not null default 0,
  -- Stamped exactly once, when the run first crosses the dead-letter threshold
  -- while still failing. NULL means "not dead-lettered". Its NULL→timestamp flip
  -- under a WHERE guard is what makes the alert fire at most once.
  add column if not exists dead_lettered_at timestamptz;

comment on column public.automation_runs.attempts is
  'Cumulative count of failed dispatches for this (rule_id, correlation_id); '
  'survives reclaims. Incremented by automation_register_failure().';
comment on column public.automation_runs.dead_lettered_at is
  'Set once when the run crosses the dead-letter threshold while failing; the '
  'NULL→now() flip (guarded) fires the HQ dead-letter alert at most once.';

-- Partial index for the HQ health surface: "which runs are currently dead-lettered".
create index if not exists automation_runs_dead_letter_idx
  on public.automation_runs (org_id, dead_lettered_at desc)
  where dead_lettered_at is not null;

-- ---------------------------------------------------------------------
-- 2. Atomic failure registration + dead-letter decision
-- ---------------------------------------------------------------------
--
-- Called by the dispatcher (service-role) AFTER it records a run 'failed'. Two
-- atomic steps on the SAME row, so concurrent re-fires can neither lose an
-- increment nor double-fire the alert:
--
--   1. attempts := attempts + 1  (single UPDATE ... RETURNING; row-locked).
--   2. If attempts >= threshold AND not yet dead-lettered, flip dead_lettered_at
--      under a `dead_lettered_at is null` guard. `FOUND` is true for EXACTLY ONE
--      concurrent caller, so should_alert is true at most once per occurrence.
--
-- Returns the post-increment attempts, the one-shot alert flag, and the org +
-- event so the caller can raise an org-pinned HQ notification without a re-read.
-- SECURITY INVOKER (default): the caller is the service-role dispatcher, which
-- bypasses RLS; EXECUTE is nonetheless revoked from every non-service role below
-- (least privilege — no tenant JWT path should ever reach this).

create or replace function public.automation_register_failure(
  p_rule_id        text,
  p_correlation_id text,
  p_threshold      integer
)
returns table (
  attempts     integer,
  should_alert boolean,
  org_id       uuid,
  event_type   text
)
language plpgsql
as $$
declare
  v_attempts integer;
  v_dead     timestamptz;
  v_org      uuid;
  v_event    text;
begin
  update public.automation_runs r
     set attempts = coalesce(r.attempts, 0) + 1
   where r.rule_id = p_rule_id
     and r.correlation_id = p_correlation_id
  returning r.attempts, r.dead_lettered_at, r.org_id, r.event_type
       into v_attempts, v_dead, v_org, v_event;

  -- No matching run (should not happen: the dispatcher writes the row first).
  if v_attempts is null then
    return;
  end if;

  should_alert := false;

  if v_attempts >= greatest(p_threshold, 1) and v_dead is null then
    update public.automation_runs r
       set dead_lettered_at = now()
     where r.rule_id = p_rule_id
       and r.correlation_id = p_correlation_id
       and r.dead_lettered_at is null;
    -- Exactly one concurrent caller wins the guarded flip.
    if found then
      should_alert := true;
    end if;
  end if;

  attempts   := v_attempts;
  org_id     := v_org;
  event_type := v_event;
  return next;
end;
$$;

revoke all on function
  public.automation_register_failure(text, text, integer)
  from public, anon, authenticated;
