-- ─────────────────────────────────────────────────────────────────────────────
-- Wave A.5 hardening (A5.1) — CIS statement-email idempotency, at the DATABASE.
--
-- WHAT THIS FIXES
-- server/services/cis-statement-emails.ts queues a subcontractor's CIS payment &
-- deduction statement onto the shared outbound email queue exactly once. Until
-- now that "exactly once" was enforced only by a check-then-insert in
-- application code: read the subjects already queued for the org, then insert the
-- ones not seen. Two truly-simultaneous admin clicks (or a retried server action)
-- can BOTH read before EITHER inserts, both miss the other, and both insert — so
-- one subcontractor is emailed the SAME statement twice. The service's own header
-- flagged this residual race and named the honest fix as "a follow-up migration
-- adding a unique index on a per-statement queue key". This is that migration.
--
-- THE KEY
-- The natural idempotency key is (org_id, statement_number): a CIS statement
-- number is unique per org, immutable, and CHANGES ON REISSUE — so a corrected
-- statement is a new number and is correctly emailed again, while re-running the
-- action over an unchanged month queues nothing new. We record it in a dedicated
-- nullable column `cis_statement_key` rather than overloading `subject` (which is
-- display copy and is legitimately shared across other email types — two
-- notification emails to two users can carry the same subject in the same org).
--
-- WHY A PLAIN (NOT PARTIAL) UNIQUE INDEX
-- `cis_statement_key` is NULL for every NON-CIS row in this shared queue, and
-- Postgres treats NULLs as DISTINCT in a unique index (the default, NULLS
-- DISTINCT) — so those rows never collide with each other and are effectively
-- exempt from the constraint. Only rows that actually carry a CIS key are
-- constrained. A partial index (`WHERE cis_statement_key IS NOT NULL`) would be
-- leaner but PostgREST's upsert cannot infer a partial index as its ON CONFLICT
-- arbiter (it emits no predicate), so the service's `.upsert(..., { onConflict,
-- ignoreDuplicates })` idiom needs a non-partial arbiter. The index carries one
-- entry per queue row, comparable to the existing org/notification indexes.
--
-- ADDITIVE & IDEMPOTENT. Adds a nullable column (no default, no backfill) and a
-- unique index; changes no RLS (this queue is service-role-only, by design) and
-- no existing behaviour for any other email type. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.notification_email_queue
  add column if not exists cis_statement_key text;

comment on column public.notification_email_queue.cis_statement_key is
  'H2-CIS M5 idempotency key. For a queued CIS payment & deduction statement '
  'email this is the statement NUMBER (unique per org, immutable, changes on '
  'reissue); NULL for every other kind of queued email. With the unique index '
  'notification_email_queue_cis_statement_uniq this makes "one email per '
  'statement per org" a database invariant that survives concurrent admin '
  'clicks and retried server actions, not just an application-level check.';

-- One queued CIS statement email per (org, statement number). NULL keys (every
-- non-CIS email) are distinct and unconstrained, so this touches no other flow.
create unique index if not exists notification_email_queue_cis_statement_uniq
  on public.notification_email_queue (org_id, cis_statement_key);
