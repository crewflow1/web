# First Impression Experience — milestone

> Goal: every company that sees CrewFlow for the first time reaches an "aha" moment within the first
> few minutes. Customer-facing quick-win milestone. All changes are additive and low-risk.

## What changed

### P1 — Guided first-run + sample data
- **New orgs enter the guided setup, not a cold dashboard.** `app/onboarding/company/actions.ts` now
  redirects a newly-created org to `/onboarding/setup` (the existing guided stepper) instead of
  `/dashboard`.
- **Realistic sample data is seeded at org creation.** `server/services/sample-data.ts`
  (`seedSampleData`) creates one self-explanatory demo set — a homeowner customer, a **draft** quote
  (`SAMPLE-001`, £14,400, three line items — a kitchen extension), and a scheduled job. Wired
  best-effort into `createOrgWithOwner` (`server/services/bootstrap-account.ts`): it **never throws and
  never blocks signup**, and is **idempotent + safe** — it only seeds an org that has zero customers,
  so it can never overwrite or duplicate real data. Every record is tagged in its notes as sample data
  safe to delete, and uses illustrative values (`example.com`, a `SAMPLE-` quote number that cannot
  collide with the real numeric quote sequence).

### P2 — Communications readiness guard (no silent email failure)
- `lib/comms/readiness.ts` reports whether each channel can actually send. `sendEmail` returns
  `{sent:false, reason:"no_key"}` when unconfigured — previously invisible. Now **`/api/health` exposes
  `comms.{email,sms,whatsapp,missedCallTextbackReady}` booleans** (no env-var names — the endpoint is
  public), so a misconfigured deploy that would silently drop customer quotes/invoices is caught by the
  smoke test and uptime monitor. **`comms.email=false` in production is an alert.**

### P3 — Missed-call text-back prepared for activation (NOT activated)
- `getMissedCallTextbackReadiness()` reports exactly what remains to switch the built-but-dark
  missed-call SMS text-back on: the feature flag and the Twilio SMS sender. Surfaced as
  `comms.missedCallTextbackReady` in `/api/health`. **Nothing is activated** — the flag stays default
  `false`; this only makes the remaining steps observable so it can be flipped the moment Twilio
  provisioning completes.

## Missed-call text-back — activation runbook (do this when Twilio is provisioned)

The pipeline is built, tested, and dark. To activate (a config-only change, no deploy of new code):
1. Provision a **Twilio** account + a phone number; configure the number's inbound webhook to CrewFlow.
2. Set in the Vercel production env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`
   (the sender), and `CHANNEL_INBOUND_SECRET` (the inbound gateway secret).
3. Verify readiness: `GET /api/health` → `comms.sms = true`, `comms.missedCallTextbackReady = false`
   ("one env flip from live").
4. Flip `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK=true` and redeploy env.
5. Confirm: `comms.missedCallTextbackReady = true`. A missed call now triggers an instant SMS text-back
   to the caller (human-safe, deterministic acknowledgement).
6. Rollback is a config flip: set the flag `false` or clear `TWILIO_SMS_FROM`.

## Comms readiness — reading it

`GET /api/health` includes, e.g.: `"comms": { "email": true, "sms": false, "whatsapp": false,
"missedCallTextbackReady": false }`. Before onboarding any customer, confirm **`comms.email = true`**
in production (set `RESEND_API_KEY`), or customer-facing emails silently do nothing.

## Tests
- Unit: `__tests__/comms/readiness.test.ts` (10) — configured/missing matrix for email/sms/whatsapp +
  the missed-call readiness state machine.
- Integration (real Postgres): `__tests__/integration/onboarding/sample-data.test.ts` (3) — seeds a
  coherent demo set; idempotent no-op on re-run; never seeds an org with existing data.
