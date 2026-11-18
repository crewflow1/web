# Stripe sandbox lifecycle testing

How CrewFlow's **sales-led** billing is tested against Stripe, what proves itself
today with no network, and the one external input still missing: a Stripe
**test-mode secret key** from the CEO.

CrewFlow billing is sales-led (self-serve signup is OFF): **£1,000 one-off setup
fee + £500/month** per customer, provisioned by an operator from
`/admin/customers/[id]`. The LIVE Stripe integration is already activated in
production with a restricted key, live webhook and live prices. **None of the
tests here touch any live configuration, and none can create a real charge.**

---

## TL;DR

- **Mocked tests run now, in CI, with no key** and prove CrewFlow's handling of
  the whole lifecycle (signature verification, idempotency, every state
  transition, failure classification, the dark self-serve gate).
- **The real-sandbox lifecycle test is runnable the moment a `sk_test_` key is
  provided.** Without it, it **skips cleanly**. It is the only part that needs an
  external input.
- **The missing input:** a Stripe **test-mode** secret key in
  `STRIPE_TEST_SECRET_KEY` (preferred) or `STRIPE_SECRET_KEY`, plus a local
  Postgres (`supabase start`). Test products/prices are created by the test
  itself — no pre-provisioning required.

---

## The lifecycle under test

```
operator (/admin/customers/[id])
   │  createSetupCheckout         → Stripe Checkout (mode=payment)   £1,000
   │  createSubscriptionCheckout  → Stripe Checkout (mode=subscription) £500/mo
   ▼
Stripe  ── webhook ──▶  POST /api/webhooks/stripe
                         │  verify Stripe-Signature (constructEvent)
                         ▼
                        processStripeEvent  (server/services/stripe-webhook-handler.ts)
                         • checkout.session.completed → stripe_customer_id,
                           setup_fee_status=paid / status=active, billing_invoices
                         • customer.subscription.created|updated → org.status
                           (active | suspended | cancelled), next_renewal_at,
                           org_subscriptions projection
                         • customer.subscription.deleted → recorded, NOT auto-cancel
                         • invoice.paid → billing_invoices (paid)
                         • invoice.payment_failed → billing_invoices (failed) + notify
                         • idempotent via billing_events.event_id (atomic claim + lease)
```

Key source files:

| Concern | File |
| --- | --- |
| SDK singleton + live/test label | `lib/stripe/client.ts` |
| Price discovery (lookup_key → amount) | `lib/stripe/prices.ts` |
| Idempotent product/price provisioning | `lib/stripe/provisioning.ts` |
| Webhook receiver (signature verify) | `app/api/webhooks/stripe/route.ts` |
| Webhook handler (side effects) | `server/services/stripe-webhook-handler.ts` |
| Operator checkout actions | `app/admin/customers/[id]/_stripe-actions.ts` |
| Self-serve billing (DARK) | `lib/billing/self-serve.ts`, `server/services/self-serve-billing.ts` |

---

## What the mocked tests verify (no key, no network)

Run with `npm run test` (unit tier) — all deterministic:

- **`__tests__/stripe/webhook-route.test.ts`** — executes the real `POST`
  handler against the **real Stripe SDK verifier** (signatures minted with
  `stripe.webhooks.generateTestHeaderString`):
  - valid signature → **200**, parsed event reaches `processStripeEvent`;
  - missing / forged / body-tampered / **stale** (outside the tolerance window)
    → **401**, handler never runs;
  - unconfigured key or webhook secret, and the maintenance window → **503**;
  - handler throw → **500** (so Stripe retries).
- **`__tests__/stripe/lifecycle-transitions.test.ts`** — executes
  `processStripeEvent` for **every** lifecycle event against a chainable Supabase
  mock and asserts the exact `organizations` / `billing_invoices` writes:
  setup-fee paid (£1,000), subscription active (£500), the demo pre-org flow,
  `subscription.updated` status machine (active/trialing → active,
  past_due/unpaid → suspended, canceled → cancelled), `subscription.deleted`
  (recorded, **not** auto-cancelled), `invoice.paid` (subscription vs one-off
  classification), `invoice.payment_failed` (reason captured + notify),
  finalized/voided status-only transitions, and unhandled types stored-not-actioned.
- **`__tests__/stripe/no-charge-when-dark.test.ts`** — wires the **real** env
  gate (`isSelfServeBillingConfigured`) into the self-serve entry points and
  proves no charge path opens while the feature is dark (every dependency throws
  if reached). Self-serve stays OFF.
- **`__tests__/stripe/sandbox-gate.test.ts`** — proves the sandbox gate's policy
  (skip / fail-loud / **refuse a live key** / run) deterministically, with no key.
- Existing coverage this builds on: `contract.test.ts` (source pins),
  `webhook-retry.test.ts` + `integration/stripe/webhook-claim-concurrency.test.ts`
  (idempotency / retry / in-flight concurrency), `provisioning.test.ts`,
  `is-live-mode.test.ts`, `stripe-permission-error.test.ts`,
  `invoice-subscription-id.test.ts`, `security/self-serve-billing.test.ts`.

---

## The real-sandbox lifecycle test

**`__tests__/integration/stripe/sandbox-lifecycle.test.ts`** — drives genuine
Stripe **test mode** with a **test clock** and **test cards**, then feeds every
real Stripe object through CrewFlow's own `processStripeEvent` against a **real
local Postgres**, asserting CrewFlow's state transitions at each step.

### Gate (safety)

Decision lives in `__tests__/stripe/_sandbox-gate.ts` (`evaluateSandboxGate`):

| Condition | Behaviour |
| --- | --- |
| `STRIPE_SANDBOX_E2E` unset | **SKIP** cleanly (the default; CI stays green) |
| enabled, no key resolvable | **FAIL LOUD** (misconfiguration, never silent-green) |
| enabled, key is `sk_live_` / `rk_live_` | **REFUSE** (never touches real money) |
| enabled, unrecognised prefix | **REFUSE** (fail-closed) |
| enabled + `sk_test_`/`rk_test_` key + local Postgres | **RUN** |

The Stripe client is built **directly from the gated test key** — never
`getStripe()` / `env.STRIPE_SECRET_KEY` — so it is impossible for this suite to
transact on the production live restricted key.

### Required environment

```bash
# 1. A Stripe TEST-mode secret key (THE missing input — from the CEO).
export STRIPE_TEST_SECRET_KEY='sk_test_<your-test-mode-secret>'   # or rk_test_<…>
#    (STRIPE_SECRET_KEY is also accepted, but ONLY if it is an sk_test_/rk_test_
#     value; a live key is refused.)

# 2. The opt-in switch.
export STRIPE_SANDBOX_E2E=1

# 3. A local Postgres (the test asserts CrewFlow's DB state).
supabase start   # exports SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY

# Run it:
npm run test:integration -- __tests__/integration/stripe/sandbox-lifecycle.test.ts
```

> **Test products/prices are created by the test** (ephemeral, per-run, carrying
> CrewFlow's canonical `lookup_key` idiom). You do **not** need to run
> `/api/admin/stripe/provision` first. The test cleans up by deleting its test
> clock (which removes its customers + subscriptions in test mode) and its local
> DB rows.

### What it asserts (end to end)

1. **Operator checkout wiring** — creates a real £1,000 Checkout Session and
   asserts `amount_total` + `mode` (proves price wiring against Stripe). Stripe
   has no headless "complete session" API, so the `checkout.session.completed`
   **handler** is then exercised with that real session object (only the user's
   in-browser payment is simulated) → `organizations.setup_fee_status = paid`.
2. **Setup fee charged** — a real one-off invoice is finalized + paid with a test
   card → `invoice.paid` handler → `billing_invoices` paid row, `£1,000`.
3. **Subscription start** — real `subscriptions.create` (£500/mo) → active →
   `customer.subscription.created` handler → `organizations.status = active`,
   `stripe_subscription_id` set, `org_subscriptions` projection written.
4. **First subscription invoice** paid → `billing_invoices` subscription row, `£500`.
5. **Clock advance (~1 month)** → next period billed → second paid invoice; org
   stays active, DB de-dupes by `stripe_invoice_id`.
6. **Cancellation** — `subscriptions.cancel` → `customer.subscription.deleted`
   handler → recorded, org **not** auto-suspended (operator decision).
7. **Failed payment** — a second customer with `tok_chargeCustomerFail`, clock
   advanced so the renewal charge fails → `customer.subscription.updated`
   (past_due/unpaid) → `organizations.status` suspended/cancelled.

### Test cards / tokens used

| Purpose | Value |
| --- | --- |
| Succeeding card | token `tok_visa` |
| Failing recurring charge | token `tok_chargeCustomerFail` |
| Time control | Stripe **test clock** (`testHelpers.testClocks`) |

(Equivalent `pm_card_visa` / `pm_card_chargeCustomerFail` PaymentMethods work
too; see Stripe's testing docs for the full matrix.)

---

## The one missing input

Everything is in place **except a Stripe test-mode secret key**. Provide it as
`STRIPE_TEST_SECRET_KEY` (an `sk_test_…` or `rk_test_…` value from the Stripe
dashboard in **test mode**), set `STRIPE_SANDBOX_E2E=1`, run `supabase start`,
and the real lifecycle executes. Until then the sandbox suite skips, and the
mocked tiers carry the proof.

**Do not** use the production live key here — the gate refuses it by prefix, by
design.
