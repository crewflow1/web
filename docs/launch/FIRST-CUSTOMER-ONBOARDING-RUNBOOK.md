# CrewFlow — First Customer Onboarding Runbook (sale → operational account)

> Sales-led: £1,000 setup + £500/month. Prod `crewflow.uk`, SHA `0118d07`,
> migration tip `20261273000000`, healthy. 🙋 = founder action (I cannot do live
> charges, create prod logins, or enter passwords). Nothing here changes prod
> config.

## Step 0 — close the sale (off-platform) 🙋
Agree scope + the £1,000 setup / £500-per-month terms with the customer. Capture the
customer's **company name** and the **primary owner's email**.

## Step 1 — provision the organisation (HQ) 🙋 (operator)
In Internal HQ (`/admin`), create the customer org via the demos→promote flow
(`app/admin/demos/actions.ts` → `promoteDemoToCustomer`) or `admin/customers`. This
mints a fresh **trial org + owner membership + `public.users` mirror** keyed to the
owner's email. (Provisioning is behind an explicit confirm token — verified by the
#990 hardening pass.)

## Step 2 — owner first login 🙋 (customer)
The owner signs in at `crewflow.uk` by **magic link** (`signInWithOtp` → Supabase
Auth SMTP) **or password** (`signInWithPassword`) — both are supported, so magic-link
deliverability is not a single point of failure. They land in their new org.
- **Pre-req to confirm once:** custom SMTP sender verified in Supabase → Auth → SMTP
  (so the magic link arrives). If not yet confirmed, set an owner password as the
  fallback.

## Step 3 — billing: setup fee + subscription (Stripe LIVE) 🙋 (operator)
From `/admin/customers/[id]` trigger Stripe checkout (`_stripe-actions.ts`):
- **£1,000 setup fee** (one-off) + **£500/month subscription**.
- Customer completes payment on Stripe (LIVE — verified 2026-10-28; `billing.configured`
  + `webhookConfigured` = true in prod).
- Webhooks settle automatically: `checkout.session.completed` → `setup_fee_status=paid`
  + org `status=active`; `subscription.created/updated` → active/suspended; `invoice.paid`
  (recurring) → `billing_invoices`. (Idempotent via `billing_events`; verified mocked
  in #988/#991.)
- Self-serve signup stays OFF (operator-provisioned only).

## Step 4 — staff setup 🙋 (owner)
Owner invites operatives (staff). Under R5 (now fully live), **staff see only the jobs
they are assigned to**; commercial/financial data, other workers' rota/time/
acknowledgements, and unrelated jobs are denied. Owner/admin retain full visibility.

## Step 5 — run the business (verified journey)
Owner creates customers + jobs, assigns staff, and runs the end-to-end flow —
**lead → quote (VAT) → approve → accept → auto job + draft invoice → record payment →
customer portal** — the exact path proven green in the CI e2e tier (`core-journey` +
`first-customer-sim`).

## What is already verified (no action)
- Core journey + multi-staff/jobs onboarding: **green CI e2e** (real app + Postgres).
- R5 staff isolation: **live + enforced** in prod (Phases 1–5 + all operational tables).
- Billing: Stripe LIVE configured + webhooks; email (Resend) + monitoring (Sentry) on;
  backups restore-proven; prod healthy.

## Founder actions before the customer is fully live (the only gates)
1. Confirm Supabase **Auth SMTP** delivers a magic link to an authorised inbox (or set
   owner passwords as fallback).
2. Perform the **first live Stripe charge** (£1,000 + £500/mo) at Step 3.
3. Create the **owner login** and (with me driving the in-app browser) do a one-time
   **staff-login isolation click-through** on prod.
