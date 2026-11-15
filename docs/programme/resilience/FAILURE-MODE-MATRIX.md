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

Rows that say "Not assessed in this pass" are labelled **BLOCKED** with the reason — they
are listed so the gaps are visible rather than implied clean. A scenario absent from this
document has not been looked at.

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
| ST-01 | Stripe handler writes were never checked: a failed activate/revoke write was stamped "processed" and never retried (paying tenant locked out / churned tenant keeps access) | SILENT-LOSS | P1 | **FIXED** `fe8c5d2f` | SIMULATED-ONLY + VERIFIED (re-run case) |
| ST-02 | Stripe org lookup failure read as "no org for this customer" → event skipped and stamped processed | SILENT-LOSS | P1 | **FIXED** `fe8c5d2f` | SIMULATED-ONLY |
| ST-03 | A Stripe retry meeting a live claim was acked 200; if the in-flight handler was then killed the event stayed claimed-and-unprocessed forever | STUCK | P1 | **FIXED** `fe8c5d2f` | VERIFIED |
| EM-01 | Notification-email drain had no claim: overlapping drains sent every queued email twice (5 overlapping → 5 sends) | DUPLICATE (email) | P1 | **FIXED** `09260fce` | VERIFIED |
| ST-04 | Stripe events applied in arrival order: a late `subscription.updated(active)` after `subscription.deleted` re-activates a cancelled org | CORRUPTION (stale overwrite) | P2 | OPEN | NOT-IMPLEMENTED |
| PW-14 | Invoice-number allocator: unlocked `max()+1`, `int` overflow on ≥10-digit suffix, numbers re-issued after delete | STUCK / compliance | P2 | OPEN (accept path made immune) | VERIFIED (a,b) |
| PW-09 | Bank CSV re-upload duplicates statement lines (no file fingerprint) | DUPLICATE | P2 | OPEN | NOT-IMPLEMENTED |
| PW-10 | Overlapping payroll runs can pay the same hours twice (no overlap guard) | DUPLICATE (money) | P2 | OPEN | NOT-IMPLEMENTED |
| CC-05 | Concurrent payment inserts on ONE invoice deadlock (40P01): one wins, the rest get "try again" | SAFE, degraded | P3 | OPEN | VERIFIED |
| CC-06 | No optimistic concurrency on quote / invoice / job / schedule edits: two editors → last write wins, the first editor's change vanishes without warning | SILENT-LOSS (lost update) | P3 | OPEN | NOT-IMPLEMENTED |
| CR-01 | Cron health is global, not per-route; a killed run writes no `cron_runs` row | DEGRADED (visibility) | P2 | OPEN | NOT-IMPLEMENTED |
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
| Critical screens render "empty" when the read errored (loud-reads doctrine) | `lib/supabase/read-failure.ts`; frozen ledger `__tests__/security/loud-read-failures.test.ts` | The ledger guard is green at the lowered baseline (`app/(app)`: 50 discard / 31 soft-data / 4 count-only — each remaining site is a reviewed best-effort read listed in `docs/loud-read-failures.md`). NOT done in this pass: a screen-by-screen fault-injection of the money/compliance pages; the ledger proves the *shape* is bounded, not that each page renders an error state. | SAFE by guard; per-screen behaviour unproven here | IMPLEMENTED-UNTESTED | — |
| Connection exhaustion / slow DB under load | `docs/connection-pooling-and-scale.md` | Not exercised. Statement-level timeouts/pool exhaustion were injected as returned errors (`57014`, `53300`, `08006`) in the fault-injection tests; no real load or killed connections were applied. | — | BLOCKED (no hosted staging; the local stack is shared by all workstreams; production load is out of bounds) | — |

## 2. Partial multi-step writes

See `PARTIAL-WRITE-AUDIT.md` — that document is the inventory and verdicts. Headlines are in the summary table above.

## 3. Stripe

Code: `app/api/webhooks/stripe/route.ts`, `server/services/stripe-webhook-handler.ts`. Claim = `billing_events.event_id` UNIQUE insert + one conditional reclaim UPDATE (failed, or lease > 15 min).

| Scenario | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|
| Duplicate delivery of a completed event | Reclaim matches nothing; `processed_at` set → `duplicate`, 200; no handler runs | SAFE | VERIFIED — `__tests__/integration/stripe/webhook-claim-concurrency.test.ts` (19/19) | — |
| Two/five simultaneous first deliveries | Exactly one runs the handler; one billing row | SAFE | VERIFIED — same file | — |
| Handler throws midway | `markFailed`: `error_message` set, `processed_at` NULL → reclaimable immediately; route 500 → Stripe retries | SAFE (at-least-once) | VERIFIED — same file ("a FAILED event is reclaimable immediately") | — |
| **ST-01** A handler write fails the way Supabase really fails (returned `{error}`, no throw) | BEFORE: result discarded at 10 sites; the event was stamped processed. The existing retry test injected a *rejected promise*, which the client never produces, so it could not see this. NOW: every write goes through `mustWrite` → throw → `markFailed` → 500 → retry. | was SILENT-LOSS → SAFE | SIMULATED-ONLY — `__tests__/stripe/webhook-retry.test.ts` › "a RETURNED write error … is NOT stamped processed" | `fe8c5d2f` |
| **ST-02** Org lookup by `stripe_customer_id` fails | BEFORE: error discarded → `skipped:no_org_for_customer` → processed → dropped. NOW: throws; a lookup that *succeeds* and finds none is still a deliberate skip. | was SILENT-LOSS → SAFE | SIMULATED-ONLY — same file, two cases | `fe8c5d2f` |
| **ST-03** Can a crashed handler leave an event permanently claimed and unprocessed? | BEFORE: **yes.** A retry inside the 15-min lease was acked `duplicate`/200, ending Stripe's retries; if the first attempt had been killed before `markFailed`, the row stayed `processed_at NULL` with no sweeper to re-drive it. NOW: a live claim answers `in_flight` → HTTP 409, so Stripe keeps retrying until the event completes or its lease lapses and a retry reclaims it. Business logic still never runs twice. | was STUCK → SAFE | VERIFIED — `webhook-claim-concurrency.test.ts` › "a handler KILLED mid-flight is not stranded…" (real PG, end to end) | `fe8c5d2f` |
| Handler re-run after a partial failure (now more common, by design) | Org updates are idempotent; invoice rows are fenced by the `stripe_invoice_id` unique index; the setup-fee billing row (no unique key) is fenced by a payment-intent existence check added in this change. Notifications/audit rows can repeat (at-least-once). | SAFE for money state; DEGRADED (possible repeat notification) | VERIFIED — "re-running a setup-fee checkout … records the fee ONCE" | `fe8c5d2f` |
| `markProcessed` itself fails after the work succeeded | Logged only; Stripe gets 200; row stays `processed_at NULL` though the work is done. Harmless to state; shows up in the runbook's unprocessed check and is safe to resend. | DEGRADED (visibility) | NOT-IMPLEMENTED (read `:markProcessed`) | Runbook §5 |
| Delayed delivery | Processed whenever it arrives; no time-based expiry | SAFE (subject to ST-04) | IMPLEMENTED-UNTESTED | — |
| **ST-04** Out-of-order events | `handleSubscriptionUpsert` writes org status from the event snapshot with no ordering check; `handleSubscriptionDeleted` cancels the org without checking the deleted subscription is the org's current one. A late/retried older event can re-activate a cancelled org, or a stale delete can cancel a re-subscribed one. Exposure today is small (self-serve OFF; founder provisions). | CORRUPTION (stale overwrite) | NOT-IMPLEMENTED | Proposed: ignore a subscription event when a newer one for the same subscription id is already processed (`billing_events.payload->created`), treat `deleted` as terminal for its subscription id, and only cancel when the deleted id is the org's current subscription. Runbook §5 until then. |
| Stripe API timeout during checkout / portal creation | Not assessed in this pass. | — | BLOCKED (budget; no paid API calls permitted, would need a mocked-SDK harness) | — |

## 4. AI provider outage / timeout / malformed output / rate limit

Providers are disarmed in this environment (no keys — intended), so nothing here called a provider.

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Provider timeout | `lib/ai/text/{anthropic,openai}.ts` — `AbortSignal.timeout(TEXT_TIMEOUT_MS)`; `generate()` throws and the caller owns skip/retry | Bounded per call | SAFE | IMPLEMENTED-UNTESTED |
| No budget double-charge on retry; a crashed call cannot hold budget hostage | `lib/ai/governor.ts` reserve → settle → release; `ai_settle_reservation` idempotent; a failed call is settled as a failure then rethrown; expired claims are reclaimed by exactly one caller | Exactly-once ledger | SAFE | VERIFIED — `__tests__/integration/ai/budget-reservation.test.ts` 39/39 (real PG), `__tests__/ai/ai-cost-ledger-single-count.test.ts` |
| Ledger/reservation state unreadable | `checkBudget` / `reserveBudget` fail CLOSED (deny the call) | DEGRADED-HONEST | IMPLEMENTED-UNTESTED (existing `governor-checkbudget-failclosed.test.ts` not re-run) |
| Malformed output / partial drafts saved as final; rate-limit UX | quote-writer pipeline (`lib/ai/quote-draft-*`) | Not assessed in this pass. | — | BLOCKED (budget) |

## 5. Email (Resend) failure

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Send awaited inside a transaction-critical path | quote accept → `sendInvoiceEmail` | Awaited, but AFTER the atomic job+invoice step and best-effort: a failure never undoes or blocks the accept; only a freshly created invoice is emailed, so a heal/re-accept never re-sends | DEGRADED-HONEST (logged; manual re-send from the invoice) | SIMULATED-ONLY — `accept-quote-by-token.test.ts` | — |
| **EM-01** Two drains overlap | `lib/notifications/email.ts` | BEFORE: no claim; the per-row sender did not check status. 5 overlapping sends of one row → **5 provider calls**; an already-sent row was sent again; a not-yet-due row (quiet hours / backoff) was sent early. NOW: one conditional `UPDATE … RETURNING` claim (queued AND due → `scheduled_for` pushed a 10-min lease ahead). | was DUPLICATE → SAFE | VERIFIED — `__tests__/integration/resilience/email-drain-claim.test.ts` 5/5 ×3 (real PG, provider mocked) | `09260fce` |
| Drain crashes after claiming a row | same | Row is `queued` with `scheduled_for` ≤ 10 min ahead → next drain sends it. Not lost, not stuck. | SAFE | VERIFIED — same file › "CRASH after claiming" | `09260fce` |
| **EM-02** Resend accepted, then the `status='sent'` write fails | same | BEFORE: result discarded → silently re-sent next drain. NOW: checked, retried once; if it still fails the row is re-sent after the lease and the event is logged with the provider message id. | DUPLICATE (narrow, now loud) | NOT-IMPLEMENTED for full closure (needs a provider idempotency key) — code read, branch not executed | Runbook §6 |
| Resend 4xx/5xx | same | `failed` → re-queued with backoff 1m/5m/15m/1h/4h/24h, max 6, then parked for the HQ requeue action. Under overlap: ONE attempt, `retry_count` +1 (not +N). | SAFE | VERIFIED — `email-drain-claim.test.ts` › "provider failure under overlap"; `__tests__/integration/notifications/email-requeue.test.ts` 3/3 | — |
| No provider key | same | Row marked `skipped` | SAFE | IMPLEMENTED-UNTESTED | — |
| Push / SMS drain double-send (the defect fixed in `20261274000000`) | `push_claim_deliveries`, `sms_claim_deliveries` (`FOR UPDATE SKIP LOCKED` claim RPCs) | Fix holds under concurrency | SAFE | VERIFIED — `__tests__/integration/notifications/delivery-claim-concurrency.test.ts` 14/14 | — |
| Other transactional sends (quote email, statements, leave, report published) deduplicated on retry? | `lib/email/send-*.ts` | Not assessed in this pass. | — | BLOCKED (budget) | — |

## 6. Storage upload interruption / orphans

Two paths read (`server/services/job-documents.ts:246-285`, `server/services/tenant-attachments.ts:126-155`); the other 13 upload sites were not read.

| Scenario | Observed behaviour | Class | Evidence |
|---|---|---|---|
| Upload fails | Returned as `upload_failed`; no row written | SAFE | IMPLEMENTED-UNTESTED |
| Row insert fails after the object uploaded | Object uploaded FIRST under a random-id path (`upsert:false`), row second; on row failure a best-effort `storage.remove` and an honest `record_failed`. So a **row without an object cannot be produced** by this order. | DEGRADED-HONEST | IMPLEMENTED-UNTESTED |
| Process dies between upload and row, or the compensating remove fails | **Object without a row**: invisible to users, costs storage, never referenced. No sweeper was found. | DEGRADED (leak) — P3 | NOT-IMPLEMENTED |
| Large uploads, resumable retries, the other upload sites | Not assessed in this pass. | — | BLOCKED (budget) |

## 7. Mobile network loss / offline write queue

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Replay / duplicate submission on reconnect | `lib/offline/write-queue.ts`, `server/services/offline-writes.ts`; per-entity `client_write_key` partial unique index | Replay → `23505` → reported `duplicate`, treated as done; mutated-payload replay never overwrites; key is org-scoped | SAFE | VERIFIED — `__tests__/integration/rls/offline-write-idempotency.test.ts` 11/11 (real PG, user-JWT client); `__tests__/offline/*` 166 unit tests in the run |
| Replay ordering | `seq` allocated in the enqueue transaction; flush in `seq` order, stops on the first transient failure | SAFE | IMPLEMENTED-UNTESTED (doc + unit suite; not driven in a browser here) |
| Session expires while offline | `requireOrgContext()` redirect surfaces as a thrown action → classified transient → item kept and retried; foreign-user items purged before any flush | SAFE | IMPLEMENTED-UNTESTED |
| Conflicts | None possible by scope: only append-only, single-author creates are enabled (diary, snag, material-request draft); updates/deletes stay online-only | SAFE by construction | IMPLEMENTED-UNTESTED |
| Real browser offline→online (`e2e/offline-diary-queue.spec.ts`) | Not run in this pass (Playwright needs the heavy lock + a dev server; prioritised money paths). | — | BLOCKED (budget) |
| "One bar of signal" (`navigator.onLine` lies) | Documented, deliberately not built: the online post fails and the form behaves as before | DEGRADED-HONEST | IMPLEMENTED-UNTESTED |

## 8. Concurrent edits / double submit

| Scenario | Code path | Observed behaviour | Class | Evidence | Fix / test |
|---|---|---|---|---|---|
| Edit a quote while the customer accepts it | `updateQuote` vs accept | Before: could leave an accepted quote with no lines. Now: row lock; one of them wins whole | SAFE | VERIFIED (`quote-content-replace-atomic.test.ts` race ×4) | PW-04 |
| Double accept (public double-tap; owner + customer) | accept paths | One job, one invoice | SAFE | VERIFIED | PW-01 |
| Two admins finalise the same payroll run | `finalisePayrollRun` | Compare-and-set; the loser reads back `finalised` and reports success | SAFE | SIMULATED-ONLY | PW-06 |
| **CC-05** Two payments recorded on the SAME invoice at the same instant | `tg_invoice_payments_refuse_void` takes `FOR SHARE` on the invoice, then `_tg_invoice_payments_sync_status` UPDATEs it → lock-upgrade cycle | Postgres aborts all but one with `40P01` after ~1 s; the action returns "Couldn't record payment. Try again."; no duplicate, no lost row | SAFE, degraded | VERIFIED (5 concurrent inserts via service client: 1 ok, 4 × `40P01`, 4.0 s) | Proposed: take `FOR NO KEY UPDATE` in the BEFORE trigger so writers queue instead of deadlocking (alters an existing function → not done here) |
| **CC-06** Lost update: two users edit the same quote / invoice / job / schedule | edit actions; the only `updated_at` precondition in the tree is `server/services/offline-writes.ts:660` | Last write wins; the first editor's change is overwritten with no warning. For quotes the result is at least internally consistent since PW-04 (the whole header+lines of one editor), but still silently discards the other's work. | SILENT-LOSS (lost update) — P3 | NOT-IMPLEMENTED | Proposed: pass the loaded `updated_at` and make the write conditional (`replace_quote_content` already holds the row lock — add a `p_expected_updated_at`). |
| Double-submit of money forms | `addInvoicePayment`, `recordAllocatedPayment` | 10-second identical-payment probe, now fail-closed on both paths; a single tab is serialised by the server-action queue. True concurrency across tabs/users is not covered (PW-11). | SAFE in practice / DUPLICATE under true concurrency | SIMULATED-ONLY | PW-07 fixed; PW-11 open |
| Concurrent clock-in | `time_entries` | Not re-run in this pass; prior real-PG coverage exists (`f9687445`, clock lifecycle + double-clock guard). | — | IMPLEMENTED-UNTESTED | — |

## 9. Session expiry / rate limits / stale cache

Read only; nothing in this section was executed.

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Session expired/revoked mid-action | every action starts with `requireOrgContext()` | The action redirects to sign-in before any write, so no partial write results from an expired session; unsaved form input is lost (except queued offline writes, which survive). | DEGRADED-HONEST | IMPLEMENTED-UNTESTED |
| Rate-limited request | `lib/security/rate-limit.ts` (Postgres-backed `rate_limit_hit`; refuses with 429 + headers; fails CLOSED when the limiter cannot be consulted) | Server behaviour is explicit. Whether each UI surface explains a 429 to the user was not checked. | SAFE server-side; UX unproven | IMPLEMENTED-UNTESTED |
| Stale cache / delayed data after a write | `revalidatePath` after writes; deep routes use full-document navigation | Not assessed. | — | BLOCKED (budget) |

## 10. Background jobs / crons

| Scenario | Code path | Observed behaviour | Class | Evidence |
|---|---|---|---|---|
| Cron overlaps itself — email drain | `lib/notifications/email.ts` | Was a double-send; now claimed per row (EM-01) | SAFE | VERIFIED |
| Cron overlaps itself — push / SMS drains | claim RPCs (`20261274000000`) | Exactly-once under concurrency | SAFE | VERIFIED (14/14) |
| Cron overlaps itself — webhook dispatch, automation runs, AI reservations | lease/claim RPCs | Existing claim semantics; not re-run here (AI reservations: VERIFIED above) | SAFE | IMPLEMENTED-UNTESTED |
| A cron run throws | `lib/ops/cron-telemetry.ts` `withCronTelemetry` | Caught; `cron_runs` row with `ok=false`, message + stack head; route returns 500. A non-throwing `{ok:false}` is also recorded with its error. | DEGRADED-HONEST | IMPLEMENTED-UNTESTED |
| **CR-01** A cron run is KILLED (time limit / OOM) | same — the single `cron_runs` row is written only AFTER the handler returns | **No row at all**: indistinguishable from "did not fire". | DEGRADED (visibility) — P2 | NOT-IMPLEMENTED |
| **CR-01** What alerts a human when ONE cron stops | `lib/health/cron-freshness.ts` → `/api/health` → external outage monitor | The probe reports the age of the last successful run of **any** cron. It catches the scheduler stopping altogether; it cannot see one route failing every tick while the other 47 succeed (e.g. a broken notifications drain). Per-route state is only visible by querying `cron_runs` (runbook §7). | DEGRADED (visibility) — P2 | NOT-IMPLEMENTED |
| Poison item blocking a queue | email queue: bounded retries (6) then parked `failed`, ordered by `scheduled_for` so a backing-off row moves behind fresh ones | SAFE | VERIFIED for the retry bound (`email-drain-claim` + `email-requeue`); fairness guard `__tests__/security/cron-fairness-guard.test.ts` green |
| Other drains' poison/fairness behaviour | per-drain | Not assessed individually. | — | BLOCKED (budget) |

## Appendix — environment notes

- `__tests__/integration/rls/active-org-finance-scoping.test.ts` › 4 `notifications:` cases fail locally with `permission denied for table notifications`: the shared local database has no `UPDATE` grant for `authenticated` on `public.notifications`, a state no migration in this tree produces. Not caused by this branch (it touches neither the table nor its grants); recorded per AGENT-RULES §3 and left alone.
