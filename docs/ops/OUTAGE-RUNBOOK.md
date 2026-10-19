# Production outage runbook

Written after the 2026-10 incident: **production was HTTP 402 for five days
(Vercel billing suspension) and nobody was notified.** This runbook covers
detecting that class of outage, recovering from it, verifying recovery, and
what an outage breaks *beyond* the obvious (webhooks, crons, backups).

Companion docs: [`docs/backup-recovery-runbook.md`](../backup-recovery-runbook.md)
(database restore procedure), [`docs/customer-success/FOUNDER-OPS-QUICKREF.md`](../customer-success/FOUNDER-OPS-QUICKREF.md)
(six-incident one-pager), [`docs/customer-success/FIRST-CUSTOMER-SUPPORT.md`](../customer-success/FIRST-CUSTOMER-SUPPORT.md)
(database-incident drill record). No secrets in this file.

---

## 1. How outages are detected (the independent monitor)

`.github/workflows/outage-monitor.yml` runs on **GitHub's infrastructure**
(independent of Vercel — the lesson of the 402 incident) roughly every
15 minutes and probes `https://crewflow.uk/api/health`:

| Check | Alert condition |
|---|---|
| HTTP status | anything but `200` (a **402** is the billing-suspension signature) |
| Body `ok` / `db` | `ok != true` or `db != "ok"` (app cannot reach Postgres) |
| Body `crons.lastSuccessAgeMinutes` | `> 45` — the Vercel cron scheduler has silently stopped while the page still serves (`null` = unknown → warning only, never an alert) |

A failing probe is re-run after 60 s before alerting (no single-blip pages).
On a confirmed failure the workflow **exits non-zero** (GitHub emails workflow
failures) and **opens/updates ONE GitHub issue** labelled `production-outage`
titled "🚨 PRODUCTION DOWN — crewflow.uk health check failing", appending a
comment per failing probe and closing the issue on recovery.

**Honest limitations — do not over-trust it:**

- GitHub cron is **best-effort**: runs can be delayed minutes or skipped under
  load. Expect detection "usually within ~20 minutes", not an SLA.
- GitHub **disables scheduled workflows after 60 days with no repo activity**.
  Any commit resets the clock.
- **The alert only reaches a human who has notifications on.** One-line owner
  action: *watch `crewflow1/web` ("Watch → All activity") and enable "Actions →
  Failed workflows only" at github.com/settings/notifications.*
- If GitHub itself is down there is no monitor. Independent of Vercel, not of
  everything.
- Backup freshness is **not** observable from production (dumps live on the
  founder's machine) — covered by policy in §6, not by the monitor.

---

## 2. Vercel billing suspension (the 402 incident class)

**Symptoms:** every route — pages, APIs, static assets — returns HTTP **402**
with Vercel error code `DEPLOYMENT_DISABLED`. Nothing is wrong with the code,
the database, or DNS. Supabase keeps running (so data is safe and crons' past
rows persist), but **nothing executes on Vercel: no pages, no API routes, no
cron invocations, no webhook receivers.**

**Recovery (dashboard, minutes):**

1. Vercel dashboard → the CrewFlow team → **Settings → Billing**. Settle the
   open invoice / replace the failed card.
2. Deployments re-enable on payment. If the site stays 402 after ~10 minutes,
   redeploy the current production deployment (Deployments → latest production
   build → ⋯ → Redeploy) — do **not** push new code to "fix" a billing outage.
3. Run the post-recovery verification (§3) top to bottom.

**Prevention:** billing email must reach a monitored inbox; the independent
monitor (§1) is the backstop, not the plan.

---

## 3. Post-recovery verification checklist (any outage, in order)

1. **Health green:**
   `curl -s https://crewflow.uk/api/health` → HTTP 200, `ok: true`,
   `db: "ok"`.
2. **Right build is serving:** the health body's `sha` equals main's tip —
   `git rev-parse --short origin/main` (after `git fetch`) — and `branch` is
   `main`.
3. **Crons resumed:** health body `crons.lastSuccessAgeMinutes` ≤ 45 within
   the first hour (several crons run every minute, so this recovers fast).
   Deeper check from the linked checkout (`~/Code/web` — the only directory
   where `--linked` works):

   ```
   supabase db query --linked "select route, max(started_at) as last_run, bool_or(ok) as any_ok from cron_runs where started_at > now() - interval '2 hours' group by route order by last_run desc"
   ```

   Vercel crons resume automatically once deployments are re-enabled — there
   is no "re-arm" step — but confirm the every-minute routes
   (`notifications-drain` is `*/15`; `push-drain`, `sms-drain`, `spine-drain`,
   `task-reaper`, `webhook-dispatch` are `* * * * *`) have fresh rows. The HQ
   view is `/admin/ops`.
4. **Webhook posture:** §4 per provider — this is where an outage keeps
   costing you *after* recovery.
5. **Monitor is green again:** the `production-outage` issue got its
   "Recovered" comment and auto-closed; manually dispatch
   `outage-monitor` (Actions → outage-monitor → Run workflow) for an
   immediate confirmation probe.
6. **Sentry / Resend logs:** no fresh error burst after recovery.

---

## 4. What an outage does to webhooks (and how to replay)

While Vercel is down, every webhook receiver
(`/api/webhooks/stripe`, `/api/webhooks/resend`, `/api/webhooks/whatsapp`,
`/api/webhooks/twilio`, …) answers 402/nothing. Providers retry on their own
schedules; past their window, events are **lost unless replayed manually**.

### Stripe (`/api/webhooks/stripe` — billing events)

- **Retry window:** Stripe retries failed deliveries with exponential backoff
  for **up to ~3 days** (and may auto-disable an endpoint that fails for
  days — re-enable it first if so).
- **Outage < 3 days:** expect automatic redelivery; verify, don't assume.
- **Outage ≥ 3 days (the 5-day incident class): manual replay is REQUIRED.**
- **Replay steps:** Stripe Dashboard → **Developers → Webhooks → [the
  crewflow.uk endpoint]**. Check the endpoint's status is *Enabled* (re-enable
  if auto-disabled). Open its **Event deliveries / failed** list, filter to the
  outage window, and **Resend** each failed event. CLI alternative:
  `stripe events resend <event_id>`. The receiver stores every verified event
  idempotently in `billing_events`, so re-sending an already-delivered event is
  a safe no-op.

### Resend (`/api/webhooks/resend` — email delivery events)

- These are delivery-status events (delivered / bounced / opened …), not the
  emails themselves — emails already sent were unaffected; emails *attempted
  during* the outage never sent at all (the app was down), so there is nothing
  queued at Resend to flush.
- Resend (Svix-signed) retries failed webhook deliveries for a limited window
  (hours–days, not weeks). After a multi-day outage assume status events from
  the window are gone: Resend Dashboard → **Logs** remains the source of truth
  for what was delivered/bounced in that period — reconcile anything
  user-facing from there. Webhook processing is idempotent on the Svix message
  id, so any provider redelivery is safe.

### Meta / WhatsApp (`/api/webhooks/whatsapp`)

- The WhatsApp **channel is dark** (no outbound transport, flag off), so if
  nothing was being sent, no customer-visible events were lost.
- Meta retries failed webhook deliveries with backoff, but **sustained failure
  can unsubscribe/disable the app's webhook**. After any multi-day outage:
  Meta App Dashboard → WhatsApp → **Configuration** → confirm the webhook URL
  is still verified and the `messages` field subscription is still active
  (re-verify + resubscribe if not).
- The `whatsapp-events-sweep` cron (every 15 min) reconciles inbound event
  state once crons resume.

### Twilio (`/api/webhooks/twilio` — SMS status callbacks)

- Same shape as Resend: status callbacks lost past Twilio's retry window;
  Twilio Console → Monitor → Logs is the reconciliation source. SMS sending is
  flag-gated; if the channel was dark, nothing was lost.

---

## 5. Cron outage specifics

- Vercel crons only run on the **production deployment**; a billing
  suspension stops them entirely — there is no catch-up: missed schedules are
  simply skipped, and the drain-style routes (notifications, push, SMS, spine,
  webhook-dispatch) pick the backlog up on their next tick after recovery.
  Expect a burst of queued work in the first minutes after recovery; that is
  the design, not a fault.
- Daily business routes (invoice reminders, quote follow-ups, compliance
  expiry, report delivery) that missed their day do **not** re-fire until the
  next scheduled day. If the outage crossed their fire time and the business
  impact matters, invoke the route once manually with the cron secret (it is
  authenticated; see `vercel.json` for paths) or accept the one-day gap.
- Telemetry: every run writes a `cron_runs` row; the staleness signal in
  `/api/health` (`crons.lastSuccessAgeMinutes`) is derived from the newest
  successful row and is how the monitor sees scheduler death.

---

## 6. Backup freshness policy (not monitorable from prod — hold the line here)

Off-platform logical dumps live in **`~/CrewFlow-backups/` on the founder's
machine** — outside Vercel *and* Supabase, which is the point. Production
cannot observe them, so freshness is policy, not telemetry:

- **Cadence:** refresh **monthly** at minimum; **always within 7 days before
  onboarding a new customer** (launch-checklist rule) and **before any risky
  migration/release**.
- **How:** the exact rehearsed command set (three `supabase db dump` calls —
  roles / schema / data — against the **IPv4 pooler** connection string; the
  direct `db.<ref>.supabase.co` host is IPv6-only and will not resolve from
  most operator networks) lives in `~/CrewFlow-backups/README.md` together
  with the restore rehearsal notes. It embeds credentials — **never commit it**.
  Generic shape, password from the founder's password manager
  (`SUPABASE_DB_PASSWORD`):

  ```
  supabase db dump --db-url "postgresql://postgres.jzntbskdqdopzwdqwvkp:<password>@<ipv4-pooler-host>:5432/postgres" -f "crewflow-$(date +%F)-<part>.sql"
  ```

- **Verify after each dump:** file is dated, non-trivial size, and the README's
  2-minute restore route still matches reality (last proven 2026-08-29: real
  prod-data restore in 80 s, exact match).
- **Platform-side:** Supabase daily backups + WAL archiving are on; **PITR is
  OFF** (paid add-on, CEO decision — tracked in
  `docs/customer-success/FIRST-CUSTOMER-SUPPORT.md`). Until PITR is on, data
  RPO is up to 24 h; the dated dump is the only copy outside Supabase.

---

## 7. Escalation / source of truth

- Database restore procedure: `docs/backup-recovery-runbook.md` (Steps 1–3).
- Database incident (corruption/loss, freeze-writes): the "Database incident"
  section of `docs/customer-success/FIRST-CUSTOMER-SUPPORT.md` — stop, note
  the exact UTC time, engineering on the call **before** touching Supabase
  Backups (restores are destructive).
- Status pages: status.vercel.com · status.supabase.com ·
  githubstatus.com (the monitor's own substrate).
