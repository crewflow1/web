# CHROME-OWNER-QA — real-browser testing, construction-company owner

> **Environment:** local CrewFlow dev server (`next dev`, port 3001) against local
> Supabase, driven in a real Chromium browser (the Claude built-in browser pane —
> a genuine rendered DOM, not source inspection). Synthetic account
> `e2e-owner@crewflow.test`, org **E2E Co** (`ea7326a9…`). No production data.
> **Date:** 2026-11-02. Every "PASSED" below was clicked in the browser AND, where
> it writes data, verified directly in Postgres.

## Headline — the end-to-end money journey works (Chrome + DB verified)

The complete revenue workflow was executed by hand in the browser and checked in
the database at every step:

| Step | Action in Chrome | DB verification | Status |
|---|---|---|---|
| Login | password sign-in as owner | redirected to `/dashboard`, session active | **PASSED** |
| Lead | `/leads/new` → filled + saved "Sarah Murphy / Kitchen extension" | `leads` row: contact fields, `postcode=LS1 4DY`, `estimated_value=18500`, `status=new`; **lead-scoring engine** computed band "hot" (72) with per-factor detail | **PASSED** |
| Customer | `/customers/new` → business customer "Marsh & Co Builders Ltd" | `customers` row: `customer_type=business`, `company_number`, `vat_number`, address all correct | **PASSED** |
| Quote + VAT | `/quotes/new` → 2 lines, **mixed VAT** (15000@20% + 3500@5%), lead linked | live totals Subtotal £18,500 / VAT **£3,175** / Total £21,675; `quotes` row `number=Q-0001`, `subtotal=18500`, `vat_total=3175`, `total=21675`, `lead_id` linked — **mixed per-line VAT correct** | **PASSED** |
| Approval | "Request approval" → self-approve (clear self-approval notice) | quote lifecycle advanced; portal link activates only after approval | **PASSED** |
| Customer portal accept | opened `/q/<token>` as the customer, typed e-signature "Sarah Murphy", "Accept & sign" | quote `status=accepted`; **auto-created** invoice `INV-0001` (amount 18500, vat 3175, total 21675, `status=draft`) **and** job `bb77d21b` (scope carried from quote) | **PASSED** |
| Payment | `/invoices/[id]` → recorded £10,000 partial payment | `invoice_payments` row (10000, ref FP-REF-10K); UI PAID £10,000 / **OUTSTANDING £11,675** (correct); next-payment field auto-set to the £11,675 balance | **PASSED** |

**This directly answers "prove someone can actually use the application."** A new
contractor can take an enquiry to a signed, invoiced, part-paid job entirely
through the rendered UI, and every figure is arithmetically correct and
persisted.

## Notable correct behaviours observed (not bugs)

- **Product-truth honesty:** the quote screen shows "AI quote drafting **Off** —
  configured but not connected… nothing is generated", i.e. a dark capability is
  not marketed as live. Correct per the product-truth guardrail.
- **Draft-quote portal guard:** before approval the public `/q/<token>` link
  correctly refuses with a well-designed customer error ("…hasn't been approved
  yet") — no leak of unapproved quotes.
- **Console/network:** `/dashboard`, `/leads/*`, `/customers/*`, `/quotes/*`,
  `/invoices/*` produced **no console errors** on load.

## Routes exercised so far (owner)
`/login`, `/dashboard`, `/leads`, `/leads/new`, `/leads/[id]`, `/customers`,
`/customers/new`, `/quotes`, `/quotes/new`, `/quotes/[id]`, `/q/[token]` (portal),
`/invoices`, `/invoices/[id]`. Each is recorded in `COMPLETE-BROWSER-COVERAGE.csv`.

## Defects found so far
None in the core revenue journey. (One non-defect UX note: `/finances/[id]`
is not an invoice route — invoices live at `/invoices/[id]`; `/finances` is the
costs ledger. Correct by design.)

## Extended sweep (operations + money + settings) — all render clean

A second pass swept the operational and money domains in Chrome:

- **Operations:** `/operations` hub, **`/assets/new` → created a JCB 3CX asset**
  (DB-verified: price 42000, value 35000, serial) which then **appears in
  `/assets`** (full round-trip); `/fleet`, `/stock` hubs render; **`/suppliers/new`
  → created "Leeds Builders Merchants Ltd"** (DB-verified: category, 30-day terms).
- **Money — cross-module financial consistency verified (a strong positive):**
  - `/cash` COLLECTABLE NOW **£11,675.00** = the outstanding on INV-0001 after the
    £10,000 partial payment; NET POSITION £10,210.18.
  - `/tax` OUTPUT VAT **£1,464.82** (cash basis) ties to the cash-position "owed
    out"; Corporation Tax = 19% × £18,500 = **£3,515.00** (correct).
  - `/reports` (P&L, aged debtors, cashflow forecast, staff utilisation, sales
    pipeline) + `/expenses` (AI receipt extract) render.
  - So the **quote → invoice → payment → cash → VAT → corporation-tax chain all
    reconciles arithmetically** across five separate screens.
- **Settings:** `/settings` (profile + organisation) renders.

## Coverage boundary (honest)
This file covers the **critical owner revenue journey** end-to-end, the primary
Sales/Money routes, and a representative sweep of every owner domain (operations,
money, settings) with 5 DB-verified create forms. It does **not** claim full
per-route/per-control coverage of all ~185 owner routes; `COMPLETE-BROWSER-
COVERAGE.csv` lists the remaining routes as NOT TESTED. No defects found in the
swept owner routes (the one owner-surface defect, D-2 hydration, is fixed in #1033).
