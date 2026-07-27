# Payment allocation (Financial Operations)

One real-world payment — a single bank transfer, cheque, or cash receipt — can
settle **several invoices at once**. This slice adds that without forking the
payment system: it extends the existing `invoice_payments` ledger rather than
building a parallel one.

## The insight (why there is no `payment_allocations` table)

`invoice_payments` already links a payment amount to **one** invoice, and
`_tg_invoice_payments_sync_status` already recomputes that invoice's paid status
by summing its rows. That machinery already handles **partial payments** (many
rows per invoice). The only thing missing was a way to **group** several of
those rows under one real-world receipt.

So the model is:

- **`payments`** (new) — one real-world receipt: `amount`, `paid_at`, `method`
  (`bank_transfer` / `card` / `cash` / `cheque` / `other`), `reference`,
  `source`, optional `customer_id`. `unique (id, org_id)` for composite FKs.
- **`invoice_payments.payment_id`** (new column) — when set, that row is an
  **allocation** of a payment to an invoice. Standalone rows (the existing
  per-invoice "record a payment" flow) keep `payment_id` NULL and are untouched.

Because an allocation **is** an `invoice_payments` row, the existing per-invoice
status trigger fires for free — no retarget, no data migration. This is a
simpler, lower-risk design than a separate allocations table + a rewritten
trigger, and it satisfies the same requirement.

Migration: `20261010000000_payment_allocation.sql`.

## DB-enforced invariants (never the frontend)

1. **A payment can't be over-allocated.** `tg_invoice_payments_no_over_allocate`
   (BEFORE INSERT/UPDATE) rejects any allocation that would push the sum of a
   payment's allocations past its `amount` (± half a penny).
2. **Concurrency-safe.** The guard does `SELECT amount FROM payments WHERE
   id = :payment_id FOR UPDATE` first, so two simultaneous allocations to the
   same payment **serialise** — the second sees the first's committed row and is
   rejected. Without the row lock both could read "0 allocated" and both write,
   corrupting the ledger (a TOCTOU race). Proven by a real-Postgres concurrency
   test.
3. **Tenant integrity.** Composite FK `(payment_id, org_id) → payments(id,
   org_id)` (matching the existing `(invoice_id, org_id)` FK) makes it
   impossible to allocate across orgs. RLS mirrors `invoice_payments`: members
   select/insert/update within their org; admins delete.
4. **Atomic writes.** `allocate_payment(...)` (SECURITY INVOKER) creates the
   payment and every allocation in **one transaction**. If any allocation trips
   the guard, the whole payment rolls back — never a half-allocated receipt.

## Server + UI

- `allocate_payment` RPC — the atomic write path; the caller's RLS, the org
  FKs, and the guard all apply.
- `recordAllocatedPayment` server action (`app/(app)/payments/allocate-actions.ts`)
  — validates with `recordPaymentSchema`, does a friendly over-allocation
  pre-check (the DB remains authoritative), calls the RPC, writes an
  `payment.recorded` audit entry, revalidates.
- `/payments/new` — pick the amount + method + reference, then split it across
  outstanding invoices with live "allocated / unallocated" running totals and a
  "Fill" shortcut per invoice. Entry point: **Record payment** on `/payments`.
- `lib/payments/allocation.ts` — pure math (`computePaymentAllocation`,
  `computeInvoiceBalance`) shared by the form and mirrored by the DB rounding
  contract (`lib/money`, `numeric(12,2)`).

## Tests

- **Unit** (`__tests__/payments/allocation.test.ts`, 14) — allocation/ balance
  math, statuses, float tolerance, string/null coercion.
- **Integration / RLS / concurrency** (`__tests__/integration/rls/payment-allocation.test.ts`, 5)
  against real Postgres: member allocates across two invoices + statuses sync;
  over-allocation rejected + atomic rollback; cross-org rejected; non-member
  rejected; **two concurrent allocations never exceed the payment**.
- **E2E** (`e2e/payment-allocation.spec.ts`) — the record-payment surface sits
  behind the auth wall.

## Not in scope

No payment gateway — CrewFlow tracks money, it doesn't process it. Refunds /
reallocation editing and CIS/HMRC deductions remain out (the latter is an
explicit product decision).
