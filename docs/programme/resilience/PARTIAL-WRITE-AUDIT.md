# Partial-write audit — multi-step writes without a transaction

Workstream: failure & recovery engineering · branch `ops/independent-backup-and-failure-drills` · base `8cec66a7`.
Status: **living document** — updated as each sequence is examined. Last update: 2026-11-14.

## Why this class exists

`supabase-js` issues **one statement per call**; there is no client-side transaction.
A server action that does `A → B → C` therefore commits `A` even when `B` fails, and
PostgREST **returns** errors rather than throwing them — a write whose result is not
read fails silently. The only ways to make a sequence safe are:

1. **Atomic** — one Postgres function (RPC) = one transaction; or
2. **Idempotently repairable** — every step is safe to repeat, the sequence is
   fail-stop, the user is told the truth, and a retry completes exactly what is missing
   (ideally with a unique index as the concurrency backstop).

Retries alone are not a fix: without (1) or (2) they duplicate.

## Evidence labels

Exactly one per row: **VERIFIED** (I ran it and saw it — test/command cited) ·
**SIMULATED-ONLY** (mocked client fault injection) · **IMPLEMENTED-UNTESTED** (a control
exists in code; I read it, did not execute it) · **NOT-IMPLEMENTED** (the control is
absent; file:line cited, behaviour not executed) · **BLOCKED** · **NEEDS-FOUNDER**.

Outcome classes: SAFE · DEGRADED-HONEST · SILENT-LOSS · CORRUPTION · DUPLICATE · STUCK.

## Method

- Enumerated every statement-level `await <client>…insert/update/delete/upsert/rpc`
  whose result is discarded (108 sites across `app/`, `server/`, `lib/`), and every
  action in the business-critical set that issues ≥2 dependent writes.
- For each critical sequence: read it, then injected the failure — real Postgres for
  transactional/concurrency behaviour (`__tests__/integration/resilience/`), mocked
  client faults for "statement N fails" (`__tests__/**/*-fault-injection.test.ts`,
  `*-repair.test.ts`, `*-atomic.test.ts`).
- "Before" behaviour was captured by running the new regression test against the
  unfixed code first (results quoted below).

---

## A. Sequences that were defective — FIXED in this branch

### PW-01/02/03 · Quote acceptance → job → invoice  — **P1** — fixed `fac90ff1`

`app/(app)/quotes/actions.ts` — `acceptQuoteByToken` (public) and `acceptQuoteAsOwner`.

| | |
|---|---|
| Sequence (before) | `UPDATE quote=accepted` → `INSERT job` → `UPDATE quote.job_id` (result discarded) → `SELECT invoice` → `rpc next_invoice_number` → `INSERT invoice` → email → lead=won → automation |
| Fault → outcome | **DUPLICATE**: concurrent accepts each read `job_id IS NULL` and each inserted a job. **SILENT-LOSS**: `next_invoice_number` is `max()+1` with no lock, so two different quotes of one org accepted together get the same number; the loser's insert hits `invoices_org_number_key`, is only logged, and the customer sees "accepted" — no invoice, nobody told. **CORRUPTION (half-written)**: invoice step fails after the job + backlink committed. **STUCK**: owner path redirected `saved=accepted` on a re-accept without creating anything (the public path was healed last week by #1082; the owner sibling was not), and on an invoice failure it redirected away *before* advancing the lead and dispatching `quote.accepted`. |
| Evidence (before) | **VERIFIED** — `quote-accept-atomic.test.ts` against unfixed code: `no duplicate job from a concurrent re-accept: expected 3 to be 1`; `quote … must not be left accepted-but-invoice-less: expected [] to have a length of 1`; `no dangling job backlink: expected '<uuid>' to be null`. |
| Fix | Migration `20261324000000` — `ensure_accepted_quote_artifacts(p_org_id, p_quote_id, …)`: SECURITY INVOKER, org-pinned, `42501` fence; `SELECT … FOR UPDATE` on the quote; job+backlink only if missing; reuse-or-create invoice under a per-org `pg_advisory_xact_lock`; bounded re-allocation on a number collision with an unlocked writer. Whole step rolls back on any failure. Both paths call it; both **heal** on re-accept; owner path fails loud on its pre-read, always completes lead/automation, and the `warn=invoice_skipped` banner now carries a retry button. |
| Evidence (after) | **VERIFIED** — `__tests__/integration/resilience/quote-accept-atomic.test.ts` 5/5 (real PG, incl. in-DB fault injection via an org-scoped allocator overflow, 3-way and 5-way concurrency, RLS/tenant fence) ×4 runs; `__tests__/integration/rls/quote-accept-concurrency.test.ts` 1/1. **SIMULATED-ONLY** — `__tests__/quotes/accept-quote-by-token.test.ts` 13/13 (RPC error on both paths, pre-read failure). |
| Residual | Acceptance (status + signature) and the artifact step are still two transactions **by design**: a customer's acceptance is never thrown away because invoicing failed. The intermediate state is now clean (accepted, no job, no invoice), loud (Sentry + log), and self-healing on any re-accept. Detection query in the runbook addendum. |

### PW-04 · Quote edit (header + line items) — **P1** — fixed `5306d32e`

`updateQuote`.

| | |
|---|---|
| Sequence (before) | `UPDATE quotes` (new totals) → `DELETE quote_line_items` → `INSERT quote_line_items` |
| Fault → outcome | **CORRUPTION / data loss**: insert fails after the delete committed → quote keeps the NEW totals with ZERO line items; the previously saved priced scope is destroyed (the only copy of the replacement is one browser tab's form echo). Second hazard: `tg_quote_line_items_freeze_accepted` guards INSERT/UPDATE but **not DELETE**, so an edit racing a customer acceptance could strip the lines of a just-accepted quote. |
| Evidence (before) | **VERIFIED** — `quote-content-replace-atomic.test.ts` › "HAZARD ON RECORD" reproduces the three statements against the real schema: totals 1500, 0 lines. |
| Fix | Migration `20261325000000` — `replace_quote_content(p_org_id, p_quote_id, p_header, p_lines)`: SECURITY INVOKER, row lock, refuses an accepted quote **before** touching anything, header + delete + insert in one transaction; revert-to-`pending_approval` decided on the locked row. `updateQuote` makes that single call, refuses on a failed pre-read, says "nothing was changed" on failure. |
| Evidence (after) | **VERIFIED** — `quote-content-replace-atomic.test.ts` 7/7 (mid-insert NOT NULL fault → old header + lines intact; edit-vs-accept race ×4 always consistent; tenant fence). **SIMULATED-ONLY** — `__tests__/quotes/update-quote-atomic.test.ts` 5/5. |

### PW-05 · Bank reconciliation: confirm match — **P1** — fixed `1cbee076`

`app/(app)/payments/actions.ts` — `confirmBankMatch`.

| | |
|---|---|
| Sequence | `INSERT invoice_payments (bank_line_id=L)` → `UPDATE bank_statement_lines SET confirmed` → recount |
| Fault → outcome | **DUPLICATE (money)**: if the line update failed the operator saw "match partially failed", the line still looked unmatched, and confirming again inserted a SECOND payment for the same bank transfer. The action also never checked the line's current `match_status` (stale tab / double submit → second payment). No unique index on `bank_line_id`. |
| Evidence (before) | **VERIFIED** — `bank-match-idempotency.test.ts` against the unfixed schema: `the same bank transfer must not be recorded twice: expected undefined to be '23505'` (second payment accepted; a *different* invoice could also be settled by the same line). |
| Fix | Migration `20261326000000` — partial unique index `invoice_payments_bank_line_uniq`. Action: no-op on an already-confirmed line; **reuse** an existing payment for the line (fail-closed probe) so a retry only completes the missing half; adopt the winner on a concurrent `23505`; org-pin the line update; record where the money actually went; refuse to silently re-home a match. |
| Evidence (after) | **VERIFIED** — `bank-match-idempotency.test.ts` 4/4 ×4 runs (5-way concurrency → exactly one payment). **SIMULATED-ONLY** — `__tests__/payments/bank-match-repair.test.ts` 6/6. Prod pre-flight (aggregate only, 2026-11-13): 0 payments carry a `bank_line_id`, 0 duplicate groups — index builds clean. |

### PW-06 · Payroll: finalise run — **P1** — fixed `fbf790c5`

`app/(app)/payroll/actions.ts` — `finalisePayrollRun`, `deletePayrollRun`.

| | |
|---|---|
| Sequence | per payroll line: `UPDATE time_entries SET payroll_line_id` (N statements) → `UPDATE payroll_runs SET finalised` |
| Fault → outcome | Every result was discarded. **SILENT-LOSS**: a failed lock was skipped and the run finalised anyway (that worker's shifts stayed editable under a "locked" payroll, with no record). **False success**: a failed status flip left a draft the page announced as finalised. `deletePayrollRun` announced "deleted" regardless. Finalising is irreversible. |
| Fix | Fail-stop: finalised only after every lock succeeded; explicit error otherwise, run stays draft; the flip is a compare-and-set (`.eq("status","draft")`) that reads the truth back when it changes zero rows; a retry completes exactly what is missing (`payroll_line_id IS NULL` predicate). No migration. |
| Evidence | **SIMULATED-ONLY** — `__tests__/payroll/finalise-fault-injection.test.ts` 8/8 (mid-loop lock failure, repair by retry, flip failure, zero-row refusal, concurrent finalise, delete failure). |
| Residual | Not atomic: after a mid-loop failure some entries are locked to a *draft* run's lines until the retry or until the draft is deleted (`time_entries.payroll_line_id` is `ON DELETE SET NULL`, so deleting the draft unlocks them). Honest and repairable; an RPC would make it atomic (proposed, P3). |

### PW-07 · Record invoice payment: duplicate-submit probe — **P2** — fixed `b92d90a4`

`app/(app)/invoices/[id]/payment-actions.ts` — `addInvoicePayment`.

| | |
|---|---|
| Fault → outcome | **DUPLICATE (money)**: the "identical payment in the last 10 s?" probe discarded its error; a rejected probe read as "no duplicate" and a browser re-POST during a blip recorded the payment twice. (The sibling probe in `recordAllocatedPayment` was already fail-closed.) |
| Fix | Bind the error; fail closed with "nothing was saved". |
| Evidence | **SIMULATED-ONLY** — `__tests__/payments/record-payment-fault-injection.test.ts` 6/6 (first executed test of this action; the existing one is a source contract). |
| Residual | See PW-11 — the guard is a time-window probe, not a key. |

---

## B. Sequences examined — already SAFE by construction (atomic RPC)

Read at the call site; the transactional property is the database's. Not re-proved here
(prior suites cover them) unless stated.

| Flow | Mechanism | Label |
|---|---|---|
| Payment allocation across invoices | `allocate_payment` RPC (SECURITY INVOKER; payment + all allocations one txn; FOR UPDATE over-allocation guard) — `payments/allocate-actions.ts:140` | IMPLEMENTED-UNTESTED (by me) |
| Stock receipt / issue / transfer / adjustment / correction | `record_stock_*` RPCs | IMPLEMENTED-UNTESTED |
| Goods-received note post / void | `post_goods_received_note`, `void_goods_received_note` | IMPLEMENTED-UNTESTED |
| Stocktake open / count / post / cancel | `*_stocktake_*` RPCs | IMPLEMENTED-UNTESTED |
| CIS supplier payment + deduction, statements, monthly return | `record_cis_supplier_payment`, `issue_cis_statement`, `prepare_cis_monthly_return`, … | IMPLEMENTED-UNTESTED |
| Supplier payment | `record_supplier_payment` | IMPLEMENTED-UNTESTED |
| Valuation → invoice, stage → invoice | `generate_valuation_invoice`, `generate_stage_invoice`, `certify_valuation` | IMPLEMENTED-UNTESTED |
| Job template save/clone, programme, budgets, milestones | `save_job_template`, `set_job_programme`, `set_job_budget`, … | IMPLEMENTED-UNTESTED |
| Blueprint pin + snag | `create_blueprint_pin_with_snag` | IMPLEMENTED-UNTESTED |
| Payroll run create | header insert → lines insert, with **compensating rollback** of the header and an honest error (`payroll/actions.ts:350-388`) | IMPLEMENTED-UNTESTED |
| Offline queued writes (diary, snag, material-request draft) | `client_write_key` partial unique index per entity | VERIFIED — see matrix §7 |

## C. Sequences examined — OPEN (not fixed here)

| ID | Flow | Sequence / gap | Outcome on fault | Sev | Label | Proposed fix |
|---|---|---|---|---|---|---|
| PW-08 | Create quote / duplicate quote | `INSERT quotes` (with totals) → `INSERT quote_line_items`; on line failure returns "saved but line items didn't — re-add" (`quotes/actions.ts:297-305`, `:486-494`) | DEGRADED-HONEST. The header keeps totals with no lines until re-saved; a quote number is consumed. Re-saving through the (now atomic) edit repairs it. | P3 | NOT-IMPLEMENTED | Route create through one RPC (`create_quote_with_lines`), or delete the header on line failure as payroll does. |
| PW-09 | Bank statement upload | `INSERT bank_statements (line_count=N)` → read invoices (throws on failure) → `INSERT bank_statement_lines`; failure leaves an empty statement header; **no file fingerprint**, so re-uploading the same CSV creates a second statement and a second copy of every line (`payments/actions.ts:79-204`) | DEGRADED-HONEST (`?error=lines_failed`) + DUPLICATE lines on re-upload. After PW-05 each *line* pays once, but the same real transfer present in two uploads can still be matched twice. | P2 | NOT-IMPLEMENTED | Store a content hash on `bank_statements` with a unique `(org_id, hash)`; dedupe lines on `(org_id, posted_at, amount, reference, description)`; roll back the header on line failure. |
| PW-10 | Payroll run create — overlapping periods | No uniqueness/overlap guard on `(org_id, period)`; hours are summed for the window regardless of `payroll_line_id` (`payroll/actions.ts:209-222`) | DUPLICATE: a double-submitted create makes two draft runs; two finalised runs over the same period pay the same hours twice. Only app-layer immutability (no DB trigger on finalised runs/lines). | P2 | NOT-IMPLEMENTED | Exclude entries already linked to a finalised run's line; warn/refuse an overlapping period; DB trigger freezing finalised runs. NEEDS-FOUNDER on policy (are overlapping correction runs ever legitimate?). |
| PW-11 | Manual payment recording (both paths) | Idempotency is a 10-second "same user + amount + date + reference" probe, not a key. Two genuinely concurrent requests both pass it. | DUPLICATE under true concurrency (two tabs / two users). A single tab is serialised by Next's server-action queue, so the practical exposure is small. | P3 | NOT-IMPLEMENTED | Client-minted idempotency key column + partial unique index on `invoice_payments` / `payments` (the offline queue's `client_write_key` pattern), threaded through `allocate_payment`. |
| PW-12 | Staff invite (existing user) | `INSERT membership` → best-effort profile/compensation pre-fill, results discarded (`staff/actions.ts:267,285`) | SILENT-LOSS (minor): an hourly rate typed on the invite form can be dropped without notice → that worker's next payroll line prices at £0 until someone notices. Membership itself is safe. | P3 | NOT-IMPLEMENTED | Check the upsert; surface "added, but pay details didn't save". |
| PW-13 | Job billing: generate stage invoice | Atomic RPC, but the action discards its result and returns `void` (`jobs/[id]/billing/actions.ts:129`) | DEGRADED, silent UI: a refused/failed generation shows nothing. No data damage. | P3 | NOT-IMPLEMENTED | Return a FormState; show the refusal. |
| PW-14 | Invoice numbering allocator | `next_invoice_number` = `max(cast(substring(number from 'INV-(\d+)') as int))+1`: (a) no lock → concurrent callers get the same number (loser fails on `invoices_org_number_key` — loud on `/api/invoices`, was silent on accept before PW-02); (b) the `int` cast **overflows** for any stored `INV-<≥10 digits>` (e.g. a date-style legacy number brought in by the importer, which takes the file's number verbatim — `lib/imports/commit.ts:113-117`), after which *every* allocation for that org raises; (c) numbers are re-issued after the highest invoice is deleted. | (a) SAFE-but-degraded; (b) STUCK for that org's invoicing — loud on manual create, and after PW-02 loud + self-healing on accept; (c) compliance risk (UK VAT numbering should be unique and gap-explainable). | P2 | VERIFIED for (a),(b) — `quote-accept-atomic.test.ts` uses (b) as its fault and proves (a) is closed for accept; NOT-IMPLEMENTED for (c) | Per-org counter row (`SELECT … FOR UPDATE`) allocated in the same transaction as the insert; `bigint` cast. Changes an existing function + numbering policy → proposed, NEEDS-FOUNDER on (c). |

## D. Not yet examined in depth

Imports commit/rollback (`app/(app)/imports/actions.ts` — 20 discarded-result writes, mostly
status stamps), onboarding/provisioning (`app/onboarding/**`, `server/services/bootstrap-account.ts`),
purchase orders, materials requests (header+lines has a documented key-first replay
protocol), admin customer provisioning, demo lifecycle. The discarded-result inventory is
in the matrix appendix; entries will be promoted to §B or §C as they are read.
