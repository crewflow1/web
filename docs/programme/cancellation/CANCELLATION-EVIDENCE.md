# Self-serve subscription cancellation — evidence

Branch `billing/self-serve-cancellation`, 2026-11-14. Labels per AGENT-RULES §5.

**Read this first.** No Stripe API was called at any point (no key, by design).
Every claim about Stripe's behaviour is **SIMULATED-ONLY**: a mocked client or
hand-built event fixtures. The database side is real: Postgres via the local
Supabase stack, with the two new migrations applied by `psql`.

## 1. Commands run and results

| Command | Result |
|---|---|
| `heavy.sh npm run typecheck` | exit 0 |
| `heavy.sh npx vitest run --config vitest.security.config.ts` (full tier) | 345 files, 8649 tests passed |
| `npx vitest run __tests__/billing __tests__/stripe __tests__/access-gate __tests__/hq/notifications.test.ts __tests__/sprint-a-friction` | 27 files, 483 tests passed |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/stripe` | 3 files, 58 tests passed (35 new, 23 existing) |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/rls/{gdpr-export,secdef-org-rpc-guard,least-privilege-grants,audit-log-grant-lockdown}.test.ts` | 4 files, 32 tests passed |
| Mutation check: tombstone guard removed from `apply_stripe_subscription_state` in the local DB, integration file re-run, function restored | 4 of 35 tests failed while mutated; 35 of 35 after restore |

**Not run:** the full unit suite, the full integration suite, `npm run build`,
and Playwright (see §4).

The first security-tier run failed 5 tests, all caused by this branch
(a flat `.limit(60)` on `billing_invoices`; the new table missing from the
retention exclusion census; a test and the E2E spec building Supabase clients
outside the guarded harness). All were fixed in commit "fix(billing): satisfy
F-1 / retention / destructive-target guards"; no guard was loosened.

## 2. Test matrix

Unit files are under `__tests__/billing/`; `IT` is
`__tests__/integration/stripe/subscription-cancellation.test.ts`.

| Scenario from the brief | Where | Label |
|---|---|---|
| Cancel while trialing / just after signup | `subscription-cancellation.test.ts` "TRIALING"; IT "TRIALING Stripe subscription", "TRIAL org with no Stripe subscription", "CANCEL JUST AFTER SIGNUP" | Stripe leg SIMULATED-ONLY; state VERIFIED |
| Active before renewal | unit "ACTIVE before renewal"; IT "ACTIVE org: cancel → …" | Stripe SIMULATED-ONLY; state, ledger, audit, notification rows VERIFIED |
| `past_due` during payment failure | unit "PAST_DUE"; IT "PAST_DUE (org suspended)" | same |
| After Stripe retries exhausted | unit "after Stripe's retries are exhausted", "UNPAID"; IT "RETRIES EXHAUSTED" | same |
| Already-cancelled org | unit "ALREADY CANCELLED" (3 cases); IT "WEBHOOK ARRIVES FIRST", "ALREADY-CANCELLED org marked by hand" | same |
| No subscription | unit "NO SUBSCRIPTION"; IT "LOCAL-ONLY" | VERIFIED (no Stripe involved) |
| Stripe error / timeout | unit "STRIPE ERROR / TIMEOUT" (9 cases); IT "STRIPE REFUSES", "TIMEOUT, outcome unknown" | SIMULATED-ONLY |
| Duplicate `customer.subscription.deleted` | IT "DUPLICATE customer.subscription.deleted" | VERIFIED (fixture event, real DB) |
| Late / out-of-order `subscription.updated` | IT "LATE customer.subscription.updated", "NO FLAP BACK", "OUT OF ORDER: updated → canceled" | VERIFIED |
| Late `invoice.payment_failed` | IT "LATE invoice.payment_failed" + "CONTROL" | VERIFIED |
| Late `invoice.paid` | IT "LATE invoice.paid" | VERIFIED |
| Concurrent cancellations | IT "CLAIM: 8 simultaneous claims", "CONFIRM: 6 simultaneous confirms", "TWO OWNERS / double-click" | VERIFIED (real concurrency on one Postgres) |
| Staff / admin / other-org / anon cannot cancel | `cancel-authz.test.ts` (real guard + real action, session stubbed); IT "ANON and an AUTHENTICATED user can neither read the ledger nor execute the functions" | VERIFIED |
| Cancelled owner can reach billing history and export | `cancel-authz.test.ts` "GET /api/account/export"; IT "BILLING HISTORY is readable for a CANCELLED org", and RLS read as a cancelled org's owner | VERIFIED at route/service/RLS level. **Page rendering IMPLEMENTED-UNTESTED** |
| Reactivation path | unit "reactivation request"; IT "REACTIVATION REQUEST … then a new subscription restores access", "REACTIVATION: a NEW subscription id applies", "STALE EVENT after reactivation", "HQ reactivates by hand" | VERIFIED (state); HQ checkout step is existing code, not exercised |
| Accounting records preserved | IT "ACCOUNTING PRESERVED" | VERIFIED |
| Confirmation email via the abstraction | `cancellation-email-and-history.test.ts`; IT asserts `sendEmail` called exactly once in both action-first and webhook-first orders | VERIFIED on the abstraction; nothing sent |
| Kill switch | `cancellation-rules.test.ts` "kill switch"; unit "disabled → refuses before loading anything" | VERIFIED |
| Copy makes no automatic-refund promise, no guilt-trip | `cancellation-rules.test.ts` "what the customer is told" | VERIFIED (text assertions) |

## 3. Changes to existing tests (two, both disclosed)

- `__tests__/stripe/contract.test.ts` — the pin on the deleted-subscription
  handler asserted the source text `status: "cancelled"`. The write moved into
  `confirm_subscription_cancellation`. The pin now asserts the handler calls
  that function and that the function sets `organizations.status`. The old
  regex was also satisfied by an audit-metadata string, so it never proved the
  write existed.
- `__tests__/integration/stripe/subscription-lifecycle.test.ts` — each case now
  uses its own subscription id and starts with the org unlinked. Previously all
  six shared one id and reset status between cases, so a later case delivered
  `updated → active` for a subscription an earlier case had deleted. Stripe
  cannot produce that, and the tombstone now refuses it. No assertion changed.

## 4. Not done

| Item | Label | Exact next step |
|---|---|---|
| Playwright spec `e2e/billing-cancellation.spec.ts` | **IMPLEMENTED-UNTESTED** — written, typechecks, never executed | `cd cf-wt/cancel && source ../_shared/local-env.sh && PORT=3107 npm run dev` in one shell; then `PLAYWRIGHT_BASE_URL=http://localhost:3107 ../_shared/heavy.sh npx playwright test e2e/billing-cancellation.spec.ts`. It creates and deletes its own org and users. Expect to adjust selectors on first run. |
| The UI in a browser (dialog, `/account/billing`, `/access-pending` changes, Settings → Billing section) | **IMPLEMENTED-UNTESTED** — no page was rendered; no visual, responsive or axe check | Same run as above; the spec includes two axe scans. |
| Any call to Stripe | **SIMULATED-ONLY** | Founder, in Stripe test mode: cancel an `active` and a `past_due` test subscription through the UI; confirm status `canceled`, no proration credit, open invoice shows automatic collection off, `customer.subscription.deleted` processed as `already_confirmed`. |
| Restricted live key scopes | **NEEDS-FOUNDER** | See CANCELLATION-DESIGN.md §9. |
| Full unit suite, full integration suite, `npm run build` | NOT RUN | `heavy.sh npx vitest run`, `heavy.sh npx vitest run --config vitest.integration.config.ts`, `heavy.sh npm run build`. |
| Automatic refund | **NOT-IMPLEMENTED** by decision | Founder decision Q1. |
| HQ "Cancel" also cancelling in Stripe (F2) | **NOT-IMPLEMENTED** | Route `setCustomerLifecycle('cancelled')` through `cancelOrgSubscription`. |
| Read-only mode on payment failure (F3) | **NOT-IMPLEMENTED** | Out of scope; terms vs code mismatch. |
| Production migration | NOT APPLIED (local only) | Apply `20261316000000` then `20261317000000` before the code deploys. |

## 5. Residue in the shared local database

Integration tests delete the orgs, users and `billing_events` they create.
`admin_activity_log` is append-only, so rows with target ids of deleted test
orgs remain. `subscription_cancellations` and the three functions exist in the
shared local DB (applied by `psql`, not recorded in `schema_migrations`).
