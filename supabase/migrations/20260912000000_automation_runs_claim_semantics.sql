-- Automation dispatch — claim-before-action concurrency safety.
--
-- The defect
-- ----------
-- `dispatchAutomation` decided whether to run a rule with a READ:
--
--     select id from automation_runs where rule_id = ? and correlation_id = ?
--     -> if found: skip
--     -> else: RUN THE ACTIONS, then insert the row
--
-- The window between that select and the insert is the entire action
-- execution — the widest it could possibly be. Two concurrent callers both
-- read "not found", both execute the actions, and only the second insert
-- collides on `unique (rule_id, correlation_id)`:
--
--     A: select -> miss     B: select -> miss
--     A: create_alert + create_notification
--     B: create_alert + create_notification   <- DUPLICATE side effects
--     A: insert -> ok       B: insert -> 23505 (silently discarded)
--
-- The unique constraint guarded the ROW, never the ACTIONS. Neither action
-- self-dedupes: create_alert writes an activity row, create_notification calls
-- emitNotifications. So the duplicate reached the audit log and the user's
-- notification list, while the collision left no trace at all.
--
-- Every existing caller is a domain server action (acceptQuoteAsOwner and
-- friends) — human-triggered, one row at a time — which is why this stayed
-- latent. A scheduler scanning many rows would have been the first caller able
-- to overlap, so this is fixed BEFORE that exists rather than after.
--
-- The fix: let Postgres pick the winner
-- -------------------------------------
-- The claim becomes an INSERT ... ON CONFLICT DO NOTHING RETURNING id, which is
-- atomic. Exactly one concurrent caller receives a row; the loser receives
-- nothing and runs no actions. No read decides anything.
--
--   completed_at  — the ONLY proof of completion. The old code treated row
--                   EXISTENCE as proof, which is precisely the Stripe webhook
--                   defect (20260607000000 / the #350 correction): a row
--                   written before the work finished makes a failure look
--                   permanently done and blocks its own retry forever.
--   claimed_at    — the lease clock. Separate from created_at because a reclaim
--                   must reset the lease WITHOUT lying about when the row was
--                   created.
--   status
--     'running'   — an active claim: someone holds this and is working.
--     'ok'        — terminal success (completed_at stamped).
--     'failed'    — a live dispatcher caught an error and RELEASED the claim.
--                   completed_at stays NULL, so a retry may reclaim it
--                   immediately: nothing is in flight, so no lease is needed.
--     'skipped'   — pre-existing terminal state (e.g. rule disabled).
--
-- The 15-minute lease
-- -------------------
-- A process that dies mid-action leaves a 'running' row nobody will ever
-- finish. Recovering it requires distinguishing "in flight" from "dead", which
-- only a timeout can do. 15 minutes is derived from the runtime, not taste: the
-- longest route ceiling in this codebase is maxDuration = 300s
-- (app/api/cron/invoice-reminders), everything else is 30-60s. Nothing
-- legitimate can still be running after 5 minutes, so 15 gives a 3x margin — a
-- claim older than that is provably orphaned.
--
-- Crash recovery is therefore AT-LEAST-ONCE, and this is not papered over: a
-- process can complete an external side effect (an email, a notification) and
-- die before stamping completed_at. The reclaim will re-run it. This design does
-- NOT provide exactly-once external effects and does not claim to.
--
-- Backfill
-- --------
-- Existing rows are all terminal — the old dispatcher only ever inserted AFTER
-- the work finished. Their completed_at is set to created_at so they read as
-- done and can never be reclaimed. 'skipped' is included: it too was terminal.
-- (Measured before writing this: 0 rows exist in the linked project.)

-- 1. The new durable state.
alter table public.automation_runs
  add column if not exists completed_at timestamp with time zone,
  add column if not exists claimed_at   timestamp with time zone;

comment on column public.automation_runs.completed_at is
  'The ONLY proof a run finished. NULL = claimed but incomplete, and therefore '
  'retryable. Row existence is NOT proof — treating it as such is what makes a '
  'failed run permanently idempotent.';
comment on column public.automation_runs.claimed_at is
  'Lease clock. A ''running'' row whose claimed_at is older than 15 minutes is '
  'orphaned (no route can run longer than 300s) and may be atomically reclaimed.';

-- 2. Existing rows are terminal: the old dispatcher inserted only after the
--    work was done. Stamp them complete so they are never reclaimed.
update public.automation_runs
   set completed_at = coalesce(completed_at, created_at),
       claimed_at   = coalesce(claimed_at, created_at)
 where completed_at is null;

-- 3. Admit the claim state. Widened, never narrowed — every existing value
--    remains legal, so no historical row can violate this.
do $$ begin
  if exists (
    select 1 from pg_constraint
     where conname = 'automation_runs_status_check'
       and conrelid = 'public.automation_runs'::regclass
  ) then
    alter table public.automation_runs
      drop constraint automation_runs_status_check;
  end if;
end $$;

alter table public.automation_runs
  add constraint automation_runs_status_check
  check (status in ('ok', 'failed', 'skipped', 'running'));

-- 4. Reclaim lookups hit (rule_id, correlation_id) — already served by the
--    unique constraint's index. This partial index instead serves operators
--    hunting stuck work, and costs nothing on the hot path since terminal rows
--    (the overwhelming majority) are excluded.
create index if not exists automation_runs_incomplete_idx
  on public.automation_runs (claimed_at)
  where completed_at is null;
