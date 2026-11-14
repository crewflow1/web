# Self-serve subscription cancellation — design

Branch `billing/self-serve-cancellation` · migrations `20261316000000`,
`20261317000000`, `20261318000000` · evidence: `CANCELLATION-EVIDENCE.md`.

Evidence labels follow AGENT-RULES §5. Nothing here has been run against Stripe:
this workstream had no Stripe key by design, so every statement about Stripe's
behaviour is **SIMULATED-ONLY** (mocked client) and cites where the claim comes
from.

## 1. What an owner can now do

| | Before | After |
|---|---|---|
| Cancel | Email support. The only in-app route (Stripe portal) is behind the self-serve flag, which is off in prod. The published terms already say "You can cancel at any time from the settings page". | Settings → Billing → **Cancel subscription** → one confirmation → done. Three clicks. |
| Cancel while payment is failing | Impossible in-app: `past_due` sets the org `suspended`, and every `(app)` route redirects a suspended org to `/access-pending`. | `/account/billing` (outside the app gate) has the same control. |
| After cancelling | `/access-pending`, headed "Pending approval", with a mailto. No invoices, no export. | `/account/billing`: invoices and receipts, data export, reactivation request. `/access-pending` links the owner there. |

## 2. Flow

```
owner clicks Cancel subscription → dialog (what stops / payments / unpaid invoices /
refunds / data) → "Cancel subscription now"
  └ cancelSubscriptionAction            app/account/billing/actions.ts
      resolveBillingOwner()             session user + OWN membership row, role = owner
      expected_org_id == session org    (guards against a switched active org; never a selector)
      cancelOrgSubscription()           server/services/subscription-cancellation.ts
        1 kill switch
        2 load org (admin client, id from the session)
        3 Stripe: list the customer's non-cancelled subscriptions (+ retrieve the recorded id)
        4 per live subscription:
             claim_subscription_cancellation      (DB, org row lock)
             stripe.subscriptions.cancel          (immediate)
             on ANY error: retrieve → terminated? treat as success : release claim, refuse
             stop automatic collection on open + draft invoices
             computeRefundReview                  (flag only)
             confirm_subscription_cancellation    (DB, exactly-once revoke)
        5 audit (admin_activity_log) · HQ notification · owner email
  └ { redirectTo: /account/billing?cancelled=1 } → window.location.assign
```

Stripe's `customer.subscription.deleted` webhook then arrives and is a no-op
(§5).

## 3. Authorisation

- **Owner only.** `resolveBillingOwner()` (`server/auth/billing-account.ts`) reads
  the user from the session and the org from that user's own `memberships` row
  (`getOrgForUser` without the impersonation option). Role must be `owner`.
- **No org id from the request selects anything.** `expected_org_id` is compared
  to the session-derived org and can only cause a refusal (`org_changed`).
- **HQ super-admins are refused**, so an impersonation session (which presents a
  synthetic `owner` role) cannot cancel a customer.
- Active org → `requireOrgContext()` also runs, so the org's MFA policy applies.
  Suspended/cancelled org → it cannot (that gate redirects), which is why the
  guard is separate.
- Staff, admin, a member of another org, anonymous: refused. Anonymous requests
  to `/account/billing` and `/api/account/export` are redirected to `/login` by
  middleware before reaching the guard.

## 4. Stripe semantics (SIMULATED-ONLY)

Call: `stripe.subscriptions.cancel(id, { prorate: false, invoice_now: false }, { idempotencyKey, timeout: 12s, maxNetworkRetries: 1 })`.

| Decision | Choice | Why |
|---|---|---|
| When | Immediate (`DELETE /v1/subscriptions/:id`), not `cancel_at_period_end` | Founder's stated default. The SDK documents: "Cancels a customer's subscription immediately. The customer won't be charged again for the subscription." (`node_modules/stripe/types/SubscriptionsResource.d.ts:1987`) |
| Proration credit | `prorate: false` | No credit is generated for unused time. A credit on a churned customer's Stripe balance is neither a refund nor useful. |
| Final invoice | `invoice_now: false` | No invoice is created at cancellation. |
| Which subscriptions | Every live one on the org's Stripe customer (`trialing`, `active`, `past_due`, `unpaid`, `incomplete`, `paused`), plus the recorded id if it is not in that list | Stripe is the truth for "can still bill". A stale local id must not leave a second subscription charging. |
| Ownership | A subscription is only touched if its customer equals the org's `stripe_customer_id` (or, with no customer id, its `metadata.org_id` equals the org) | Never cancel another tenant's subscription. Otherwise: refuse `billing_mismatch`, alert HQ. |
| Open / past-due invoice | **Left open, automatic collection switched off** (`auto_advance: false`). Not voided, not marked uncollectible, not written off. | Stripe documents that on cancel it "stops automatic collection of all finalized invoices for the customer … to prevent unexpected payment attempts" (same file, line 1991). We also set `auto_advance: false` explicitly on that subscription's `open` invoices. The debt remains; whether to chase or void is policy (§9, Q3). |
| Draft renewal invoice | `auto_advance: false` as well | A draft created just before renewal would otherwise finalise and charge. |
| Pending invoice items | Counted and reported to HQ, not deleted | The SDK says pending invoice items "are still charged … unless manually deleted". CrewFlow code creates none (no `invoiceItems` call in `app/`, `lib/`, `server/`); a count > 0 means someone added one in the Dashboard. |
| Refund | None by code | §8. |
| Idempotency | Key `crewflow-cancel:{org}:{subscription}` on the cancel; `crewflow-cancel-inv:{invoice}` on each invoice update | **Caveat, from memory of Stripe's docs, not verified here:** Stripe honours idempotency keys on POST and states they have no effect on DELETE. The cancel is a DELETE. The key is sent (harmless) but the guarantees that matter do not depend on it: (a) the DB claim admits one in-flight caller per subscription; (b) after any error the code retrieves the subscription and treats "terminated" as success, so a repeat cancel that errors because it is already cancelled is handled; (c) the invoice updates are POSTs, where the key is effective. |
| Timeout / unknown outcome | Refuse (`stripe_timeout`), tell the user it is not confirmed and safe to retry, release the claim | If Stripe did in fact accept it, the webhook confirms, revokes access and sends the owner's email (§5). |
| Stripe unreachable / no key, org linked to Stripe | Refuse (`billing_unavailable`); nothing changes locally | We never say "cancelled" while a subscription might still bill. |
| No Stripe link at all | Local-only cancellation (a `subscription_cancellations` row with a null subscription id) | A founder-provisioned trial or manually billed workspace. HQ is told to check for a manual arrangement. |

## 5. State handling

### Ledger
`subscription_cancellations` (service-role only). One row per cancellation.
A row with a Stripe subscription id is unique per org and, once `confirmed`, is
a **tombstone**: that id can never grant access again.

### Three functions, each taking the org row lock first

| Function | Called by | Guarantee |
|---|---|---|
| `claim_subscription_cancellation` | action, before Stripe | One caller gets `claimed`; a second within the 120 s lease gets `in_flight`; a confirmed id gets `already_confirmed`. A failed or expired claim can be retaken. |
| `confirm_subscription_cancellation` | action after Stripe success; webhook on `subscription.deleted` or `updated → canceled` | `newly_confirmed` is true for exactly one caller per subscription id. `organizations.status → 'cancelled'` happens in that call, and only if not already cancelled. |
| `apply_stripe_subscription_state` | webhook on `subscription.created/updated` and `checkout.session.completed` (subscription) | Writes nothing if the subscription id is tombstoned. |

### Orderings

| Order | Result |
|---|---|
| Action confirms, webhook later | Webhook: `newly_confirmed = false` → no second revoke, no HQ alert, no email. |
| Webhook first (Dashboard cancel, dunning exhausted, action timed out) | Webhook revokes, alerts HQ, and emails the owner if the row was owner-initiated. A still-running action becomes the no-op for revocation and email. |
| Same event twice | `billing_events` dedupes it; the confirm would be a no-op anyway. |
| Late `subscription.updated` (active / past_due) for the cancelled id | `ignored_cancelled_subscription`; org stays cancelled; audited as `stripe.subscription_upsert_ignored`. |
| Late `checkout.session.completed` for a subscription cancelled just after signup | Same guard; org is not re-activated. |
| Late `invoice.payment_failed` | Accounting row and HQ alert written; the customer-facing "update your payment method" notification and email are **suppressed**. Org status untouched. |
| Late `invoice.paid` | `billing_invoices` row recorded; org status untouched. |
| Double-click / two owners | Second claim is `in_flight` → "already being processed". One Stripe call. |
| Reactivated on a new subscription, then a late `deleted` for the old id | Tombstone written, access left alone (stale-subscription guard). |
| HQ reactivates by hand, then a redelivery for the dead id | No-op: that id was already confirmed. |
| Stripe cancelled but our confirm fails (DB error) | User is told it is cancelled (true: not billable). Audited `billing.subscription_cancel_confirm_deferred`; the webhook confirms and revokes. |

HQ notifications are at-least-once: if the webhook wins the race, HQ gets its
generic alert and the action's detailed one (refund review, invoices). The
owner's email is exactly once.

## 6. After cancellation — what the owner keeps

`/account/billing` (`app/account/billing/page.tsx`), owner-only, any org status:

- **Invoices & receipts** (`server/services/billing-history.ts`): Stripe
  `invoices.list` with hosted-invoice and PDF links when the SaaS key is present
  and the org has a customer id; otherwise CrewFlow's own `billing_invoices`
  rows. Not behind the self-serve flag. Falls back to records if Stripe errors.
- **Data export** `GET /api/account/export`: the same archive as
  `/api/gdpr/export`, built by the same service (`buildOrgExport`), behind the
  owner guard instead of the active-access gate. RLS is membership-based, so it
  holds whatever the org's status. Records only — uploaded files are not in the
  archive, and the page says so.
- **Reactivation** (cancelled) or **Cancel** (suspended).

Billing records are untouched by cancellation: no `billing_invoices` or
`billing_events` row is updated or deleted.

## 7. Reactivation

Self-serve signup is off, and `createPlanChangeCheckout` cannot re-subscribe an
org to the plan it was on (`same_plan`). So reactivation is a request:

`requestReactivationAction` → audit `billing.reactivation_requested` → HQ
notification (deduped for 24 h) → HQ sends a subscription checkout from
`/admin/customers/[id]` (existing) → `checkout.session.completed` with a **new**
subscription id → `apply_stripe_subscription_state` → org `active`,
`cancelled_at` cleared. The old id stays tombstoned. No new billing system.

## 8. Refunds — the terms and the founder's default disagree

`app/terms/page.tsx` ("Billing"): **"Refunds are issued for unused prepaid time
when you cancel; pro-rata."** The founder's stated default was no automatic
refund unless the terms require one. They do.

What was built:

- **No money moves in code.** No proration credit, refund, credit note or void.
- The customer is told what the terms say, and that it is not automatic:
  *"Our terms give you a pro-rata refund for prepaid time you haven't used. It
  isn't paid automatically when you cancel: we work out what's due and refund it
  to your original payment method, then email you to confirm."*
- When the cancelled subscription was `active` with time left in the period, the
  ledger row is `refund_review = 'pending'` and HQ's notification carries an
  estimate (list price × unused fraction, before tax and discounts). A human
  issues the refund in Stripe.

Why not automatic: it is real money out, it could not be tested (no key), the
live restricted key's refund scope is unverified, and it contradicts the
founder's stated intent. Changing the terms, or automating the refund, is the
founder's call (Q1).

## 9. NEEDS-FOUNDER

**Policy**

- **Q1 Refunds.** Keep the terms (pro-rata refund, issued by hand — as built),
  automate it, or change the terms to no refund? Until decided, every paid
  cancellation creates a manual refund obligation. If the terms change, edit
  `CANCELLATION_COPY.refund` in `lib/billing/cancellation.ts`.
- **Q2 Refund timing.** The UI promises no deadline. Is there one?
- **Q3 Unpaid invoice at cancellation.** Left open and uncollected. Chase, void,
  or mark uncollectible? The UI says "we'll contact you about it".
- **Q4 Data after cancellation.** Terms: deleted "within 30 days". The old lock
  screen said "retained for 30 days in case you change your mind". These are
  different promises. The copy now follows the terms. Which is intended, and
  does the deletion workstream implement it?
- **Q5 Setup fee.** Not refunded by anything here. Confirm.
- **Q6 Who may cancel.** Owner only, as briefed. Should an admin with
  `settings:manage` also be allowed?
- **Q7 Trials never end by themselves.** `organizations.trial_ends_at` is
  display-only: `orgHasActiveAccess` (`server/auth/session.ts`) passes any
  `trial` org regardless of the date, and no route under `app/api/cron`
  references the column (grep, 2026-11-14). A `trial` org keeps access until HQ
  changes its status by hand. Not built here. Decide: automatic expiry (and to
  which state), or keep it manual.

**Stripe Dashboard — confirm before merge**

- **Restricted key scopes** (`STRIPE_SECRET_KEY`): Subscriptions write (cancel),
  Subscriptions read (list, retrieve), Invoices read (history), Invoices write
  (`auto_advance`), Invoice items read. Missing write on Subscriptions makes
  every cancel fail safe with `stripe_error`; missing Invoices read falls back
  to records.
- **Webhook endpoint** subscribes to `customer.subscription.deleted`,
  `customer.subscription.updated`, `invoice.payment_failed`, `invoice.paid`.
- **Billing → Subscriptions and emails → Manage failed payments**: what happens
  after all retries fail (cancel subscription / mark unpaid / leave past-due)?
  "Cancel" is the setting under which exhausted retries arrive as
  `subscription.deleted` and revoke access.
- **Customer emails**: is Stripe's own "subscription cancelled" email on? If so
  the customer gets two confirmations.
- **Customer portal**: if it is ever enabled with cancellation allowed, its
  cancel mode (immediate vs period end) and proration setting should match §4.
- **Pending invoice items**: none should exist on customers; HQ is alerted if
  one does.
- **Test-mode run** of §4 before the first real cancellation: cancel a `past_due`
  test subscription and confirm the open invoice stops retrying.

## 10. Findings outside this change

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | P1 | Terms promise a pro-rata refund; founder's default assumed none. | `app/terms/page.tsx` "Billing" | NEEDS-FOUNDER (Q1). Handled as a manual review. |
| F2 | P1 | HQ "Cancel" set the org `cancelled` without cancelling the Stripe subscription: the customer was locked out and still billed. Two actions had it: `setCustomerLifecycle` (`app/admin/customers/actions.ts`) and `setOrganizationStatus` (`app/admin/actions.ts`). | pre-change source of both files | **Fixed** (§12). The `/account/billing` "Check and stop billing" notice remains as a net for orgs cancelled by hand before this change. |
| F3 | P1 | Terms: "We won't lock you out of your data if a payment fails, your workspace becomes read-only first, and you have 30 days to pay or export before access is suspended." Code: `past_due → suspended` immediately, full lock-out. There is no read-only mode. | `server/services/stripe-webhook-handler.ts` (status mapping), `server/auth/session.ts` `orgHasActiveAccess` | Partly mitigated: a suspended owner can now export and see invoices. Read-only mode NOT-IMPLEMENTED. |
| F4 | P2 | Terms said cancel "from the settings page"; no such control existed for provisioned customers. | `app/terms/page.tsx` "Termination" | Fixed by this change. |
| F5 | P2 | `/access-pending` labelled a cancelled workspace "Pending approval" and gave the owner no route to invoices or data. | `app/access-pending/page.tsx` (pre-change) | Fixed. |
| F6 | P2 | `billing_invoices` and `subscription_cancellations` cascade on organisation delete. If account deletion hard-deletes the org row, CrewFlow's own billing records go with it. | `\d billing_invoices` (`ON DELETE CASCADE`) | For the deletion workstream. Not changed here. |
| F7 | P3 | Subscription status events for a LIVE subscription are applied in arrival order, not `event.created` order. A late `past_due` after `active` suspends wrongly until the next event. The cancelled case (the failure-drill item ST-04) is closed by the tombstone; this one is not. | `handleSubscriptionUpsert` | **Still open.** NOT-IMPLEMENTED. Fix would compare `event.created` against a stored last-applied timestamp. |
| F9 | P2 | A trial has no automatic end (Q7). | `server/auth/session.ts` `orgHasActiveAccess`; no cron reads `trial_ends_at` | NEEDS-FOUNDER. Not built. |
| F8 | P3 | `/api/account/export` duplicates the ZIP assembly of `/api/gdpr/export` (that route's source is test-pinned, so it was left alone). | both route files | Follow-up. |

## 11. Rollback

Merging changes production billing behaviour: owners can terminate their own
Stripe subscription, and webhook status writes go through new SQL functions.

1. **Instant, no deploy of code:** set `BILLING_SELF_SERVE_CANCELLATION_DISABLED=true`
   and restart/redeploy the runtime. The control is replaced by "email us" and
   the action refuses before any Stripe call. Webhook handling is unaffected.
2. **Full:** revert the PR. The webhook handler then no longer calls the new
   functions. The migrations are additive and can stay; to remove them, after
   the revert is live:
   ```sql
   drop function public.apply_stripe_subscription_state(uuid, text, text, text, timestamptz);
   drop function public.confirm_subscription_cancellation(uuid, text, text, jsonb, uuid, boolean, text);
   drop function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer, text);
   drop table public.subscription_cancellations;
   ```
3. **Order on the way in:** apply all three migrations **before** the code deploys.
   The new webhook handler calls the functions on every subscription event; if
   they are missing the event fails, is recorded with `error_message`, and Stripe
   retries it — nothing is lost, but nothing is applied until the migration is in.
4. A cancellation that has already happened cannot be rolled back: a cancelled
   Stripe subscription is terminal. Reactivation is a new subscription (§7).

## 12. HQ-initiated cancellation (F2)

Both HQ actions that can set an org to `cancelled` now call
`stopBillingForHqCancellation` **first**. It runs the same path as the owner's
cancel (every live subscription terminated, invoice collection stopped, refund
review flagged, ledger tombstoned, org revoked by
`confirm_subscription_cancellation`), with `initiator: "hq"`:

- ledger `source = 'hq'` (migration `20261318000000`); audit action
  `billing.subscription_cancelled_by_hq`; HQ notification titled "Subscription
  cancelled by HQ";
- no "your subscription is cancelled" email to the operator, from the action or
  from the webhook (the webhook only emails when `source = 'owner'`);
- the self-serve kill switch does not apply to HQ.

**If billing cannot be stopped the org is NOT marked cancelled.** The operator
is redirected with a message beginning "NOT cancelled." and, on the customers
page, the attempt is audited as `customer.lifecycle_cancel_blocked`. Refusing
was chosen over "cancel but flag billing-still-active" because `cancelled` is
the state that locks the customer out: locked-out-and-billed is the harm, and a
flag on a cancelled org can be missed where a still-active org with an error on
screen cannot. If the operator then cancels in the Stripe dashboard, the webhook
revokes access on its own.

`suspended` (and `active` / `trial`) never touch the subscription.

Consequence to know: in an environment with no Stripe key, HQ cannot mark a
Stripe-linked org `cancelled` — it gets `billing_unavailable`. An org with no
Stripe link cancels normally.

## 13. Webhook hardening brought in from the failure-drill branch

Commit `fe8c5d2f` (`ops/independent-backup-and-failure-drills`) is cherry-picked
here as `f72249f7`, so this branch is the single home for Stripe-handler
changes. Conflicts were resolved keeping both behaviours:

- its `mustWrite` (every handler write checked), loud `orgIdByCustomer`, and
  `in_flight` → 409 for a live claim are all present;
- the three access-controlling organisation writes it wrapped in `mustWrite`
  (activate on checkout, subscription status, revoke on deleted) are the ones
  this branch had already moved into SQL functions. They stay as RPC calls; the
  RPC wrappers throw on a database error, which is the same "failed write keeps
  the event retryable" guarantee;
- `invoice.payment_failed` has both: the tombstone check that suppresses the
  customer notice, and `mustWrite` on its two `billing_invoices` writes.
