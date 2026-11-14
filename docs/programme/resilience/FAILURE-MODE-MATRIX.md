# Failure-mode matrix — how CrewFlow behaves when its dependencies fail

Workstream: failure & recovery engineering · branch `ops/independent-backup-and-failure-drills` · base `8cec66a7`.
Status: **living document**. Last update: 2026-11-14. Companion: `PARTIAL-WRITE-AUDIT.md` (the multi-step-write inventory), `OPERATIONS-RUNBOOK-ADDENDUM.md` (human procedures).

**Governing principle.** An infrastructure failure may degrade the product; it must never
leave business data half-written, duplicated, or silently missing, and the user must be
told the truth.

**Outcome classes.** SAFE · DEGRADED-HONEST · SILENT-LOSS · CORRUPTION · DUPLICATE · STUCK.
**Evidence labels (exactly one per row).** VERIFIED (ran it, saw it) · SIMULATED-ONLY (mocked
fault) · IMPLEMENTED-UNTESTED (control exists, read not executed by me) · NOT-IMPLEMENTED
(control absent, file:line, not executed) · BLOCKED · NEEDS-FOUNDER.
**Severity.** P0 critical data-loss/security · P1 fix before paying customers · P2 launch with
documented limitation · P3 post-launch.

Rows marked `PENDING` have not been assessed yet in this pass — they are listed so the
gaps are visible rather than implied clean.

---

## Summary of findings (worst data-integrity first)

| ID | Finding | Class | Sev | Status | Evidence |
|---|---|---|---|---|---|
| PW-05 | One bank statement line could be recorded as a customer payment more than once (retry after a partial failure, stale tab, double submit) | DUPLICATE (money) | P1 | **FIXED** `1cbee076` + mig `20261326000000` | VERIFIED |
| PW-02 | Two quotes of one org accepted at the same moment collide on the invoice number; the loser is left accepted with NO invoice and only a log line | SILENT-LOSS | P1 | **FIXED** `fac90ff1` + mig `20261324000000` | VERIFIED |
| PW-04 | Editing a quote could destroy its saved line items (delete committed, re-insert failed), incl. on a quote the customer had just accepted | CORRUPTION | P1 | **FIXED** `5306d32e` + mig `20261325000000` | VERIFIED |
| PW-01 | Concurrent accepts of one quote each created a job (3 accepts → 3 jobs) | DUPLICATE | P1 | **FIXED** `fac90ff1` | VERIFIED |
| PW-03 | Accepted quote left with a job but no invoice; owner re-accept reported success while creating nothing; invoice failure skipped lead/automation | CORRUPTION / STUCK | P1 | **FIXED** `fac90ff1` | VERIFIED |
| PW-06 | Payroll finalise ignored every write result: a failed timesheet lock was skipped and the run finalised anyway; a failed flip was announced as finalised | SILENT-LOSS / false success | P1 | **FIXED** `fbf790c5` | SIMULATED-ONLY |
| PW-07 | Invoice-payment duplicate-submit probe failed OPEN → re-POST during a blip recorded the payment twice | DUPLICATE (money) | P2 | **FIXED** `b92d90a4` | SIMULATED-ONLY |
| ST-01..04 | Stripe webhook handler: unchecked writes, lookup failure read as "no org", in-flight ack, out-of-order events | see §3 | — | assessment in progress | — |
| EM-01 | Notification-email drain has no atomic claim; overlapping drains send every row twice | DUPLICATE (email) | — | assessment in progress | — |
| PW-14 | Invoice-number allocator: unlocked `max()+1`, `int` overflow on ≥10-digit suffix, numbers re-issued after delete | STUCK / compliance | P2 | OPEN (accept path made immune) | VERIFIED (a,b) |
| PW-09 | Bank CSV re-upload duplicates statement lines (no file fingerprint) | DUPLICATE | P2 | OPEN | NOT-IMPLEMENTED |
| PW-10 | Overlapping payroll runs can pay the same hours twice (no overlap guard) | DUPLICATE (money) | P2 | OPEN | NOT-IMPLEMENTED |
| CC-05 | Concurrent payment inserts on ONE invoice deadlock (40P01): one wins, the rest get "try again" | SAFE, degraded | P3 | OPEN | VERIFIED |
| PW-08/11/12/13 | See `PARTIAL-WRITE-AUDIT.md` §C | DEGRADED / minor | P3 | OPEN | NOT-IMPLEMENTED |

Production exposure check (catalogue aggregates only, 2026-11-13): accepted quotes without
an invoice = 0; accepted quotes without line items = 0; payments carrying a `bank_line_id` = 0
(duplicate groups = 0); unprocessed `billing_events` = 0. **No production row is currently in
any of the bad states above.**

---

## 1. Supabase / Postgres unavailable, slow, exhausted; failed reads

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Write fails mid-sequence (timeout, dropped connection, pool exhausted) on a business-critical action | see `PARTIAL-WRITE-AUDIT.md` | Per-sequence — six defective sequences fixed, five open | — | VERIFIED / SIMULATED-ONLY per row | §A of the audit |
| A read that gates a WRITE fails | `quotes/actions.ts` accept + update pre-reads; `payments/actions.ts` existing-payment probe; `invoices/[id]/payment-actions.ts` duplicate probe | Before: three of these discarded the error (read as "not accepted yet" / "no duplicate"). Now: all fail closed or throw. | was DUPLICATE / CORRUPTION → SAFE | SIMULATED-ONLY (`accept-quote-by-token`, `update-quote-atomic`, `bank-match-repair`, `record-payment-fault-injection`) | Loud-read ledger `app/(app)` discard count 56 → 50 |
| Critical screens render "empty" when the read errored (loud-reads doctrine) | `lib/supabase/read-failure.ts`, ledger `__tests__/security/loud-read-failures.test.ts` | PENDING — the frozen ledger was run and is green at the lowered baseline (50 discard / 31 soft-data / 4 count-only in `app/(app)`); a targeted re-check of the money/compliance screens has not been done in this pass | — | IMPLEMENTED-UNTESTED | — |
| Connection exhaustion / slow DB under load | `docs/connection-pooling-and-scale.md` | PENDING (no load was applied; production load is out of bounds) | — | BLOCKED (no hosted staging; local stack is shared) | — |

## 2. Partial multi-step writes

See `PARTIAL-WRITE-AUDIT.md` — that document is the inventory and verdicts. Headlines are in the summary table above.

## 3. Stripe

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Duplicate delivery of a processed event | `server/services/stripe-webhook-handler.ts` claim (`billing_events.event_id` UNIQUE + conditional reclaim) | Second delivery reclaims nothing → `duplicate`, 200, no handler runs | SAFE | IMPLEMENTED-UNTESTED (existing `__tests__/integration/stripe/webhook-claim-concurrency.test.ts`; re-run pending) | — |
| Handler throws midway | `markFailed` | `error_message` set, `processed_at` NULL → immediately reclaimable; route 500 → Stripe retries | SAFE (at-least-once) | IMPLEMENTED-UNTESTED | — |
| **ST-01** A write inside a handler fails without throwing (PostgREST returns `{error}`) | every `adminTable(...).update/insert` in the handlers — results discarded (`:385, :393, :407, :434, :486, :538, :641, :648, :693, :728`) | The handler carries on and the event is stamped `processed` — e.g. a paid checkout whose `organizations.status='active'` update failed is never retried; a `subscription.deleted` whose revoke failed leaves a churned tenant with access | SILENT-LOSS | NOT-IMPLEMENTED (assessment in progress) | to be fixed |
| **ST-02** Org lookup read fails | `orgIdByCustomer` (`:764-771`) discards `res.error` | Transient read failure → `skipped:no_org_for_customer` → event stamped processed → permanently dropped | SILENT-LOSS | NOT-IMPLEMENTED (assessment in progress) | to be fixed |
| **ST-03** Retry arrives while a previous attempt holds a live claim, and that attempt then dies without `markFailed` (function killed) | reclaim returns 0 rows → `duplicate` → **200** | Stripe is told the event was delivered and stops retrying; the row stays `processed_at NULL` forever with nobody to re-drive it | STUCK | NOT-IMPLEMENTED (assessment in progress) | to be fixed |
| **ST-04** Events out of order (`subscription.updated(active)` processed after `subscription.deleted`) | `handleSubscriptionUpsert` writes status from the event snapshot with no ordering check | A late/retried older event re-activates a cancelled org | CORRUPTION (stale overwrite) | NOT-IMPLEMENTED (assessment in progress) | — |
| Stripe API timeout on checkout/portal creation | `app/admin/customers/[id]/_stripe-actions.ts`, `lib/stripe/demo-checkout.ts` | PENDING | — | — | — |

## 4. AI provider outage / timeout / malformed output / rate limit

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Provider timeout | `lib/ai/text/{anthropic,openai}.ts` — `AbortSignal.timeout(TEXT_TIMEOUT_MS)`; providers throw, the worker owns skip/retry | Bounded per call | SAFE | IMPLEMENTED-UNTESTED |
| Budget double-charge on retry | `lib/ai/governor.ts` reserve → settle → release; `ai_settle_reservation` idempotent; failed call settled as a failure then rethrown | Designed exactly-once | SAFE | IMPLEMENTED-UNTESTED (existing `__tests__/ai/ai-cost-ledger-single-count.test.ts`, `__tests__/integration/ai/budget-reservation.test.ts`; re-run pending) |
| Malformed output saved as final / partial drafts | quote-writer pipeline | PENDING | — | — |

## 5. Email (Resend) failure

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Send awaited inside a transaction-critical path | quote accept → `sendInvoiceEmail` | Awaited but AFTER the atomic artifact step and best-effort; a failure never undoes or blocks the accept; only a freshly created invoice is emailed, so a heal never re-sends | DEGRADED-HONEST (logged; manual re-send from the invoice) | SIMULATED-ONLY (`accept-quote-by-token.test.ts`) | — |
| **EM-01** Two drains overlap (Vercel at-least-once cron delivery; `notifications-drain` cron and `hq-cadence-tick` both call the drain) | `lib/notifications/email.ts` `drainNotificationEmailQueue` selects `status='queued'` rows and sends each — **no claim** | Both drains send the same rows → every email in the batch goes out twice (incl. CIS statement emails) | DUPLICATE (email) | NOT-IMPLEMENTED (assessment in progress) | to be fixed |
| **EM-02** Resend accepted, then the `status='sent'` write fails | `sendNotificationEmail` discards the update result (`:183`) | Row stays `queued` → re-sent on the next drain | DUPLICATE (email) | NOT-IMPLEMENTED (assessment in progress) | to be fixed |
| Resend 4xx/5xx | same | `failed` + backoff 1m/5m/15m/1h/4h/24h, max 6, then parked for HQ requeue | SAFE | IMPLEMENTED-UNTESTED (existing `email-requeue.test.ts`) | — |
| Push / SMS drain double-send (fixed in mig `20261274000000`) | `push_claim_deliveries`, `sms_claim_deliveries` | PENDING re-run of `__tests__/integration/notifications/delivery-claim-concurrency.test.ts` | — | — | — |

## 6. Storage upload interruption / orphans

PENDING.

## 7. Mobile network loss / offline write queue

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Replay / duplicate submission on reconnect | `lib/offline/write-queue.ts`, `server/services/offline-writes.ts`; `client_write_key` partial unique index per enabled entity | Designed: replay → `23505` → reported `duplicate`, treated as done | SAFE | IMPLEMENTED-UNTESTED (existing `__tests__/integration/rls/offline-write-idempotency.test.ts`; re-run pending) |
| Ordering, session expiry while offline, conflicts | `docs/offline-write-queue.md` | Designed: `seq` order, stop on first transient failure; expired session = transient (never destroys queued work); only append-only single-author entities enabled, so no conflict policy needed | SAFE | IMPLEMENTED-UNTESTED |

## 8. Concurrent edits / double submit

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Edit a quote while the customer accepts it | `updateQuote` vs accept | Before: could leave an accepted quote with no lines. Now: row lock; one of them wins whole | SAFE | VERIFIED (`quote-content-replace-atomic.test.ts` race ×4) | PW-04 |
| Double accept (public double-tap; owner + customer) | accept paths | One job, one invoice | SAFE | VERIFIED | PW-01 |
| Two admins finalise the same payroll run | `finalisePayrollRun` | Compare-and-set; the loser reads back `finalised` and reports success | SAFE | SIMULATED-ONLY | PW-06 |
| **CC-05** Two payments recorded on the SAME invoice at the same instant | `tg_invoice_payments_refuse_void` takes `FOR SHARE` on the invoice, then `_tg_invoice_payments_sync_status` UPDATEs it → lock-upgrade cycle | Postgres aborts all but one with `40P01` after ~1 s; the action returns "Couldn't record payment. Try again."; no duplicate, no lost row | SAFE, degraded | VERIFIED (5 concurrent inserts via service client: 1 ok, 4 × `40P01`, 4.0 s) | Proposed: take `FOR NO KEY UPDATE` in the BEFORE trigger so writers queue instead of deadlocking (alters an existing function → not done here) |
| Lost update on quotes/invoices/jobs/schedules (no version column / `updated_at` precondition) | edit actions | PENDING | — | — | — |
| Concurrent clock-in | `time_entries` | PENDING (prior real-PG coverage: `f9687445` clock lifecycle + double-clock guard) | — | — | — |

## 9. Session expiry / rate limits / stale cache

PENDING.

## 10. Background jobs / crons

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| A cron run is killed (timeout/OOM) before it finishes | `lib/ops/cron-telemetry.ts` writes its single `cron_runs` row only AFTER the handler returns | A killed run leaves **no row at all** — indistinguishable from "did not fire" unless something checks staleness | DEGRADED (visibility) | NOT-IMPLEMENTED (assessment in progress) |
| Overlapping runs, poison items, fairness, what alerts a human | drains | PENDING (email drain: see EM-01) | — | — |

---

## Appendix — environment notes

- `__tests__/integration/rls/active-org-finance-scoping.test.ts` › 4 `notifications:` cases fail locally with `permission denied for table notifications`: the shared local database has no `UPDATE` grant for `authenticated` on `public.notifications`, a state no migration in this tree produces. Not caused by this branch (it touches neither the table nor its grants); recorded per AGENT-RULES §3 and left alone.
