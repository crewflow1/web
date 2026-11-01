# CrewFlow — First Paying Customer: Launch Checklist

> Concise go-live checklist for onboarding design-partner customer #1 (sales-led:
> £1,000 setup + £500/month). Prod: `crewflow.uk`, SHA `01f1bd3`, migration tip
> `20261268000000`, healthy. **No live charges or customer-account changes without
> founder action** — the items below marked 🙋 are the founder's to perform.

## Critical (must be done to onboard + operate customer #1)

### 1. Auth email deliverability (magic-link) 🙋
- **Why:** customer + staff users log in by magic link; if the custom SMTP sender
  isn't verified, logins don't arrive.
- **Status:** the dry-run showed **AUTH GATE GREEN** after the SMTP-587 fix; the
  launch tracker still lists "verify in the Supabase Auth dashboard."
- **Action:** confirm the custom SMTP sender is **Verified** in Supabase →
  Authentication → SMTP, then send a real magic-link to an external inbox and
  confirm delivery (check spam/SPF/DKIM on `crewflow.uk`).

### 2. Stripe billing — first live charge 🙋
- **Why:** sales-led billing of customer #1 (£1,000 setup + £500/mo).
- **Status:** Stripe **LIVE verified** (2026-10-28); prod `billing.configured=true`,
  `webhookConfigured=true`, self-serve deliberately OFF; operator-provisioned.
- **Action:** from HQ, provision the customer and authorise the first live charge.
  *(I cannot initiate live charges — safety boundary.)* Confirm the
  `checkout.session.completed` / `invoice.paid` webhooks flip the org to active.

### 3. Staff-login isolation verification (live) 🙋 + me
- **Why:** prove R5 staff isolation end-to-end in the real UI before real staff use it.
- **Status:** DB/RLS layer proven (authenticated, txn-rolled-back, 2026-10-31);
  app-level click-through is the remaining human-gated proof.
- **Action:** founder establishes a prod staff session (create a staff login / enter
  the password — I can't); then I drive the in-app browser to confirm a staff user
  sees only assigned jobs + is denied commercial/finance/other-worker data.

## Recommended before/at launch (not hard blockers)
- **Backups/DR:** off-platform backup restore-proven (2026-10-20 + pre-R5 drill);
  **PITR is OFF** (CEO cost call — reconsider at paying customers). Confirm the
  weekly backup is running + a recent `success` row on `/admin/ops`.
- **R5 Phase-3 remainder (PR #1023):** apply-held; operational read-isolation
  completeness. 0 live exposure today (no non-admin-staff users yet); apply before
  onboarding multiple staff users for full isolation on blueprints/assets/etc.

## Optional / post-launch
- **AI features:** need `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` + `CREWFLOW_INTERNAL_ORG_ID`
  (code-complete, dark on creds). Not required to run the core lead→quote→job→invoice→
  payment journey.
- **WhatsApp inbound:** Meta-side delivery unresolved — a feature, not an onboarding
  requirement.

## Already green (no action)
Core customer journey VERIFIED · R5 staff isolation LIVE · email (Resend) configured ·
monitoring (Sentry) on · billing webhooks configured · crons healthy.
