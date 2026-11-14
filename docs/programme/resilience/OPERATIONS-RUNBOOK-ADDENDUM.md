# Operations runbook addendum — failure cases that need a human

Companion to `docs/backup-recovery-runbook.md`. Scope: the failure states found by the
resilience workstream that software cannot (or deliberately does not) resolve by itself.
Every query below is **read-only** and safe to run against production as written
(aggregate / id-level catalogue facts; no personal data). Run them from the linked CLI
(`supabase db query --linked`), never paste results containing customer data into a ticket.

Each entry: **signal** (how you find out) → **check** → **action** → **what not to do**.

---

## 1. Accepted quote with no invoice (and usually no job)

**How it happens.** Acceptance is recorded first; the job + invoice are then created as one
atomic step (`ensure_accepted_quote_artifacts`). If that step fails (database unavailable,
invoice numbering broken — see §4) it rolls back as a unit, so the quote is left *accepted,
no job, no invoice*. It is never half-created.

**Signal.** Sentry: `quote accept: job+invoice step failed for quote <id>`. Log line:
`[quotes] accepted quote left without job/invoice`. The owner sees an amber banner with a
**Retry creating the job and invoice** button if they accepted it themselves; a customer
accepting through the public link sees plain success (their decision was recorded).

**Check.**
```sql
select count(*) from public.quotes q
 where q.status = 'accepted'
   and not exists (select 1 from public.invoices i where i.quote_id = q.id)
   and not exists (select 1 from public.job_valuation_variations v where v.variation_quote_id = q.id);
```
(The second `not exists` excludes variations billed through an interim valuation, which
legitimately have no invoice of their own.) Baseline 2026-11-13: **0**.

**Action.** Open the quote in the app and press the retry button (or ask the owner to).
It is idempotent: it creates only what is missing and can never double-bill or create a
second job. If it keeps failing, the cause is almost always §4.

**Do not** create the invoice by hand from `/invoices/new` for a quote in this state — that
route does not create or link the job.

## 2. Bank match "partially failed"

**How it happens.** Confirming a bank match inserts the payment, then marks the bank line
confirmed. If the second write fails the operator is redirected with
`?error=match_partially_failed`: the payment **is** recorded; the line still shows as unmatched.

**Action.** Confirm the same line again. Since `1cbee076` this is safe: the action finds the
payment the line already produced and only finishes the link. The database refuses a second
payment for one bank line (`invoice_payments_bank_line_uniq`).

**Check (should always be 0).**
```sql
select count(*) from public.bank_statement_lines l
 where l.match_status <> 'confirmed'
   and exists (select 1 from public.invoice_payments p where p.bank_line_id = l.id);
```

**Still manual:** the same CSV uploaded twice creates two statements with two copies of each
line (finding PW-09, open). If a customer reports an invoice over-paid after a re-upload,
look for two bank lines with the same date/amount/reference in different statements and
remove the payment made from the duplicate.

## 3. Payroll run "couldn't finalise"

**How it happens.** Finalising locks each worker's timesheets, then stamps the run. Any
failure now stops with *"Couldn't finalise the run — … Nothing was finalised; the run is
still a draft."*

**Action.** Press **Finalise** again. Already-locked timesheets are skipped; the retry
completes the rest. Until it succeeds, some workers' entries for that period are locked to
the *draft* run's lines (they cannot edit those shifts). If the run is to be abandoned
instead, **delete the draft** — that releases every lock (`time_entries.payroll_line_id` is
`ON DELETE SET NULL`).

**Check — entries locked to a run that is still a draft.**
```sql
select r.id as run_id, count(*) as locked_entries
  from public.time_entries t
  join public.payroll_lines l on l.id = t.payroll_line_id
  join public.payroll_runs r on r.id = l.payroll_run_id
 where r.status = 'draft'
 group by r.id;
```

**Policy gap (open, PW-10).** Nothing prevents two runs over the same period; two finalised
runs would pay the same hours twice. Before finalising, check there is no other run for
that period.

## 4. Invoice numbering is broken for one organisation

**How it happens.** `next_invoice_number` computes `max(INV-<n>) + 1` and casts `<n>` to a
32-bit integer. One stored invoice whose number is `INV-` followed by **10 or more digits**
(typically a date-style legacy number brought in by the importer, which keeps the file's
numbers verbatim) makes every later allocation for that organisation raise
`integer out of range`.

**Signal.** Every manual "create invoice" for that org returns *Failed to allocate invoice
number*; every quote acceptance lands in §1.

**Check.**
```sql
select org_id, count(*) from public.invoices
 where number ~ '^INV-\d{10,}$' group by org_id;
```

**Action.** Renumber the offending imported invoices to a scheme the allocator ignores
(anything that does not match `^INV-\d+$`, e.g. prefix them `LEG-`), with the customer's
agreement since invoice numbers are a legal record — **NEEDS-FOUNDER**. Then retry §1 for any
quotes accepted meanwhile. The durable fix (per-org counter, `bigint`) is proposed, not built.

## 5. Stripe event not processed

**How it happens.** A webhook is claimed in `billing_events` before it is handled. Since
`fe8c5d2f` a failed write or lookup makes the handler throw (→ `error_message` set,
`processed_at` NULL, HTTP 500 → Stripe retries), and a retry that meets a live claim is
answered 409 so Stripe keeps retrying. Stripe retries for up to 3 days.

**Check — anything unprocessed and older than Stripe's retry horizon is stuck for real.**
```sql
select event_type,
       count(*) filter (where error_message is not null) as failed,
       count(*) filter (where error_message is null)     as claimed_never_finished,
       min(created_at) as oldest
  from public.billing_events
 where processed_at is null
 group by event_type;
```
Baseline 2026-11-13: **0 rows**.

**Action.**
- `failed` rows younger than 3 days: do nothing — Stripe is still retrying. Read
  `error_message` to see why (the message now names the write that failed).
- Anything older than 3 days: Stripe has given up. In the Stripe Dashboard → Developers →
  Events, open the event id and **Resend**. The handler reclaims the row and processes it
  (handlers are safe to re-run).
- `claimed_never_finished` with a recent `claimed_at` is normal for a few seconds. With an old
  `claimed_at` it is either a handler that was killed (resend as above) or one whose work
  completed but whose final "processed" stamp failed — check the organisation's
  `status` / `stripe_subscription_id` against Stripe before resending; resending is still safe.

**Access consequence.** A stuck `customer.subscription.deleted` means a churned tenant still
has access; a stuck `checkout.session.completed` means a paying tenant is locked out. Treat
any stuck row of those two types as urgent. **Do not** edit `billing_events` by hand to
"mark it processed".

**Known gap (open, ST-04).** Events are applied in arrival order. A delayed
`customer.subscription.updated(active)` processed *after* `customer.subscription.deleted`
would set the organisation back to `active`. If an organisation's status disagrees with
Stripe, Stripe is right: correct it from `/admin/customers` and note the event ids.

## 6. Notification emails: duplicates, or not going out

- **Duplicates.** Since `09260fce` each queued email is claimed before it is sent, so
  overlapping drains cannot double-send. One window remains: Resend accepts the email and
  the write recording it fails twice. That is logged as
  `[notification-email] SENT but could not be recorded` with the provider message id; the
  row is re-sent after ~10 minutes. If a recipient reports a duplicate, search logs for that line.
- **Stuck.** A row whose drain crashed is simply `queued` with `scheduled_for` up to 10
  minutes ahead; the next drain sends it. Rows that failed 6 times are parked `failed` — use
  the HQ requeue action (`/admin/notifications`).

```sql
select status, count(*), min(scheduled_for) as oldest_due
  from public.notification_email_queue
 where status in ('queued','failed') group by status;
```
A `queued` row whose `scheduled_for` is more than ~30 minutes in the past means the drain
cron is not running — see §7.

## 7. A cron that has stopped

`/api/health` publishes the age of the last successful run of **any** cron, so it shows the
scheduler stopping altogether but **not one cron failing while the others succeed**. A run
that is killed (timeout / out of memory) writes **no** `cron_runs` row at all — it looks
identical to "did not fire".

**Check — per-route staleness (compare against each route's schedule in `vercel.json`).**
```sql
select route,
       max(started_at) filter (where ok) as last_ok,
       max(started_at)                   as last_attempt,
       count(*) filter (where not ok and started_at > now() - interval '24 hours') as failures_24h
  from public.cron_runs
 group by route
 order by last_ok nulls first;
```
A route missing from the result, or whose `last_ok` is older than a few multiples of its
interval, needs attention. Check the Vercel function logs for that route (a killed run
appears there and nowhere else). Proposed, not built: a per-route freshness tripwire.

## 8. Recording a payment fails with "try again" when two people are working the same invoice

Two payments inserted on the same invoice at the same instant deadlock inside the
database's own triggers; Postgres lets one through and refuses the rest after about a
second (`40P01`). Nothing is lost or duplicated — the refused person retries and it works.
No action needed; listed so it is recognised rather than investigated.
