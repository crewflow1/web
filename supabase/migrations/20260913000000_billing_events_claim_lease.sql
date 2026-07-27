-- Stripe webhook — in-flight concurrency claim for billing_events.
--
-- The defect (present after the #350 retry correction)
-- -----------------------------------------------------
-- processStripeEvent inserts a billing_events row (event_id is UNIQUE), and on
-- a duplicate delivery the LOSER reads `processed_at` and — if NULL — dispatches
-- anyway. #350 made that correct for a SEQUENTIAL retry (a crashed attempt left
-- the row unprocessed, and the retry must re-run it). But under CONCURRENT
-- delivery the winner is still mid-dispatch, so its row is legitimately
-- `processed_at IS NULL`, and the loser reads that same NULL and dispatches a
-- SECOND time:
--
--     A: insert(evt) -> ok        B: insert(evt) -> 23505
--     A: handleCheckoutCompleted  (activate org, write billing_invoice, notify)
--     B: read processed_at -> NULL
--     B: handleCheckoutCompleted  <- DUPLICATE activation / billing row / notif
--
-- This is the same read-then-act race fixed for automation_runs in
-- 20260912000000. Stripe genuinely delivers the same event concurrently on
-- retry-timing overlap, so this is reachable, and it is CrewFlow's own
-- subscription-activation path.
--
-- Why one column is enough
-- ------------------------
-- Concurrency-safe claiming needs three states distinguished: completed,
-- in-flight, and orphaned/failed. billing_events ALREADY has:
--   - processed_at   — the only proof of completion (never row existence);
--   - error_message  — set by markFailed, cleared by markProcessed, so it marks
--                      a released-failure that is retryable immediately.
-- It lacks only the LEASE CLOCK that separates "a concurrent winner is still
-- working" from "a claim was orphaned by a crash". So — unlike automation_runs,
-- which needed both completed_at and a status — this adds exactly ONE column.
-- No status column: error_message already carries the released-failure signal.
--
-- claimed_at must be MUTABLE and set on reclaim: using the immutable created_at
-- as the lease clock would let two post-lease reclaimers both see it stale and
-- both dispatch. The reclaim UPDATE stamps claimed_at = now() so a second
-- reclaimer sees a fresh lease and backs off.
--
-- Lease: 15 minutes (matches 20260912000000). The webhook route sets no
-- maxDuration and Stripe closes the connection at ~20s then retries, so nothing
-- legitimate runs anywhere near 15 minutes — an older claim is provably
-- orphaned. Crash recovery is therefore AT-LEAST-ONCE: a winner can complete an
-- external side effect (activation, notification) and die before stamping
-- processed_at, and the reclaim will re-run it. Stripe delivery is itself
-- at-least-once; no exactly-once external-effect guarantee is made.
--
-- Existing rows: measured 0 in the linked project (jzntbskdqdopzwdqwvkp) before
-- writing this. Other environments were NOT measured. The backfill is safe
-- regardless: a completed row (processed_at set) is never reclaimed whatever its
-- claimed_at; an unprocessed row becomes correctly retryable. No row is altered
-- beyond gaining a claimed_at, and none is deleted or invalidated.

alter table public.billing_events
  add column if not exists claimed_at timestamp with time zone;

comment on column public.billing_events.claimed_at is
  'In-flight lease clock. Set on the initial insert (the atomic claim) and on '
  'each reclaim. A row with processed_at IS NULL whose claimed_at is older than '
  '15 minutes is orphaned and may be reclaimed. processed_at — never row '
  'existence — remains the sole proof of completion.';

-- Backfill: every existing row gets a lease stamp. Completed rows keep being
-- terminal via processed_at; unprocessed rows become reclaimable, which is the
-- correct post-migration behaviour for a pre-migration incomplete event.
update public.billing_events
   set claimed_at = coalesce(claimed_at, created_at)
 where claimed_at is null;

-- Reclaim lookups are by event_id (already UNIQUE, already indexed). This
-- partial index instead serves operational queries for stuck/in-flight events,
-- and costs nothing on the hot path since completed rows are excluded.
create index if not exists billing_events_inflight_idx
  on public.billing_events (claimed_at)
  where processed_at is null;
