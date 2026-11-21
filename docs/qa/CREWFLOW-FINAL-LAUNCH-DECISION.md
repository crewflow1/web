# CrewFlow — Final Launch Decision (real-browser mission, v2)

> Evidence-backed verdict after Programme A (real Chromium browser, 3 roles +
> customer portal) **and** Programme B (code/backend/DB/security). **Date:**
> 2026-11-02. Prod baseline `0118d07` / tip `20261273000000`. Nothing was merged,
> applied, or deployed — all fixes are apply-held PRs.

## Verdict: **CONDITIONAL GO**

A construction-company owner can run the core of their business through the
rendered UI today — proven by hand in a real browser and verified in the
database. No P0 or P1 defect was found in either programme. The conditions below
are two small apply-held fixes plus the standing human-gated launch steps.

## The evidence that matters

**Someone can actually use the app (Chrome + DB verified):**
lead → customer → quote (mixed 20%/5% VAT, totals correct) → request approval →
self-approve → **customer accepts on the portal with an e-signature** → auto
invoice `INV-0001` + auto job created → **partial payment recorded** with correct
outstanding balance. Every figure matched the database.

**Security holds (Chrome + seeded-data leak test):**
staff see a role-scoped nav (no Sales/Money/Operations), are denied
invoices/quotes/reports/finances by direct URL, get a 404 on an unassigned job,
and **cannot read another member's pay or emergency contact even when that data
exists** (seeded and confirmed stripped by `staff_compensation` RLS).

**Platform admin works and is isolated:** HQ console (home, Customers OS across
51 orgs, customer profile with operator actions, system status with
presence-only env) renders and functions; superadmin and tenant surfaces are
mutually walled off.

**Engineering is sound:** all four test tiers green (unit 11,812 · integration
2,820 · security 8,598), typecheck + lint clean, financial arithmetic verified.

## Conditions to clear before onboarding the first paying customer

**Apply-held engineering (merge, with D-1's migration applied first):**
1. **#1030** — push/SMS double-send fix (carries migration `20261274000000`).
2. **#1033** — relative-timestamp hydration fix (no migration).
3. **#1027 / #1028 / #1029** — ops/test-infra/architecture (no migrations).

**Human-gated (founder — I cannot do these):**
4. Verify **Auth SMTP** delivery (magic link to a real inbox; password fallback exists).
5. First **live Stripe charge** (£1,000 + £500/mo) via HQ.
6. One **prod staff-login isolation click-through** (founder creates the session; I drive the browser).

**Schedule, not blocking:** D-7 (asset-inspections nav race), OBS-1 (hide
pay/emergency fields for non-admins — cosmetic), Wave-2 architecture debt.

## Honest coverage statement

Programme A tested the **critical revenue journey end-to-end**, the **staff
isolation boundary** thoroughly, the **core HQ surfaces**, and the **customer
portal quote-accept** — all in a real browser, most cross-checked in Postgres.
It did **not** click every one of the ~266 routes × 3 roles; remaining routes
(many owner domains, the AI-employee HQ consoles, the worker portal, HQ billing/
demos) are marked **NOT TESTED** in `COMPLETE-BROWSER-COVERAGE.csv`. This
decision does not claim exhaustive per-route browser coverage — it claims the
business-critical paths are proven and no launch-blocking defect was found.
