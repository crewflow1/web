# CrewFlow — External-Proof Readiness

> **Why this document exists.** The final steps to full engineering maturity are
> not code — they are **proofs that require resources only the CEO/operator can
> provision**: a staging environment (a second Supabase + Vercel project, on your
> accounts), a live error-monitoring backend (a Sentry DSN), an external
> penetration test (a security firm), real provider credentials (Stripe, HMRC,
> banking), and real production traffic. This document does everything an
> engineering session *can* do — prepares the code, config, scope, and runbooks
> so each item is **one operator action from done** — and states that action
> precisely. Nothing here is faked, and no external-dependent item is claimed as
> complete. Each section ends with **EXTERNAL ACTION REQUIRED**.

---

## 1. Staging environment

**Status: ENGINEERING COMPLETE / EXTERNAL PROVISIONING REQUIRED.**

CrewFlow runs on a **single production Supabase** with no staging today. Every
migration and deploy is rehearsed against local Supabase (`supabase db reset
--local`) and validated read-only against prod (`EXPLAIN`), but there is no
production-shaped pre-prod environment. That is the correct next infrastructure
investment; it cannot be self-provisioned because it requires creating billable
projects on your Supabase and Vercel accounts.

**What is ready (code/config side):**
- Migrations are additive, ordered, and idempotent — a fresh project reaches the
  current schema by applying `supabase/migrations` in order.
- All external providers are **dark** and behind config flags, so a staging env
  runs safely with no real provider creds.
- `supabase db reset --local` already stands up the full schema locally, proving
  the migration set is self-contained.

**EXTERNAL ACTION REQUIRED (CEO/operator):**
1. Create a new Supabase project (e.g. `crewflow-staging`) — record its ref, URL, anon key, service-role key.
2. Create a Vercel "Preview/Staging" environment (or a second project) bound to a `staging` branch.
3. Populate staging env vars from the new Supabase project + dark-provider placeholders.
4. `supabase link --project-ref <staging-ref>` then `supabase db push` to apply all 347 migrations.
5. (Optional) seed with the synthetic dataset generator (see §5).

Once done, the deploy flow in §4 gains a real pre-prod rehearsal stage. **Do not
substitute local Supabase for staging in any claim** — local is a dev aid, not a
production-shaped environment.

---

## 2. Observability activation

**Status: ENGINEERING COMPLETE / DSN REQUIRED.**

The error-monitoring substrate is **already built**:
- `sentry.client.config.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts` — all three runtimes wired.
- `lib/monitoring/scrub.ts` — a deterministic `beforeSend` PII/secret scrubber wired into all three configs (redacts `Authorization`, Supabase keys, cookies, `?api_key=`, form emails) **before** any event leaves the process.
- `lib/api/request-id.ts` — `x-request-id` correlation minted in middleware, tagged on Sentry events, echoed on responses; header-injection safe.
- `app/api/health/route.ts` + `lib/health/db-probe.ts` — liveness + DB reachability probe.
- `lib/monitoring/readiness.ts` — readiness gating.

The **only** missing piece is a Sentry **DSN** (an external account credential).
Without it the SDK is inert by design — no events ship, nothing breaks.

**EXTERNAL ACTION REQUIRED (operator):**
1. Create a Sentry project; copy its DSN.
2. Set `SENTRY_DSN` (+ `NEXT_PUBLIC_SENTRY_DSN` for client) in Vercel prod (and staging) env.
3. Trigger a test exception and confirm it arrives **scrubbed** (no secrets) with a `request_id` tag.
4. Configure alert rules (error-rate spike, new-issue, health-probe failure) and confirm an alert actually fires — *this is the "prove alerts fire" step that needs the live backend.*

Until steps 3–4 run against the live backend, observability is **engineering-ready,
not production-proven** — do not claim otherwise.

---

## 3. External penetration test

**Status: SCOPE READY / ENGAGEMENT REQUIRED.**

Internal adversarial security work is extensive (many audit waves; 292 security
tests; structural trust-boundary guards). A genuine security score of 100 still
requires an **independent** external pentest — self-assessment cannot certify
itself.

**Scope / rules-of-engagement to hand the firm:**
- **Primary target:** multi-tenant isolation. Attempt cross-org read/write/download via: active-org pin bypass, SECDEF RPC parameter tampering, composite-FK cross-org injection, signed-URL cross-tenant reuse, invite-role escalation (`app_metadata` vs `user_metadata`), inbound-org spoofing (body `org_id` vs dialed address).
- **Secondary:** authn/session (MFA/TOTP, password recovery), API-key scope enforcement on the public `/api/v1` surface, webhook signature verification, storage-object ACLs.
- **Financial correctness abuse:** VAT/CIS/payroll input tampering, negative-stock/manufacture bypass.
- **Out of scope:** dark providers with no live creds (no external systems to test); DoS/volumetric (see load testing §5); social engineering.
- **Environment:** run against **staging** (§1) once provisioned, with seeded synthetic data — never against live tenant data.
- **Deliverable:** findings ranked by severity with reproduction; each becomes a fix + a new correctness guard.

**EXTERNAL ACTION REQUIRED (CEO):** engage a reputable firm; provide staging
access + this scope.

---

## 4. Deployment & rollback

**Status: DOCUMENTED / STAGING-REHEARSAL PENDING §1.**

Current flow (proven this cycle): branch → CI on real infra (lint, security,
tests, typecheck, e2e on real app+Postgres, integration on real Postgres) →
merge to main → Vercel auto-deploy → poll deployed SHA → `/api/health` returns
`{status:healthy, db:ok}`. Migrations are applied **schema-first** (before the
code that depends on them). See `docs/PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md`.

**Rollback:** Vercel instant rollback to the prior deployment for code; migrations
are additive/reversible-by-design (a new `create or replace` can be re-pointed to
the prior body with no data change — see the webhook-fairness migration header as
the worked example). **Never** chain `checkout && db push` with `;` across
worktrees (a worktree-locked branch once applied a migration from the wrong tree).

**EXTERNAL ACTION REQUIRED:** once staging exists (§1), insert a mandatory
staging-rehearsal stage before every prod migration deploy, and rehearse a full
rollback there quarterly.

---

## 5. Scalability & performance proof

**Status: HARNESS-READY / REPRESENTATIVE-PROOF REQUIRED.**

The code is written for scale (all aggregates paginate via `fetchAllRows`; per-org
fair drains; connection-pooling notes in `docs/connection-pooling-and-scale.md`).
What is **not** yet honestly proven is p50/p95/p99 at target volumes
(e.g. thousands of orgs, tens of millions of invoices/time-entries). A local
single-container Postgres run is **not** representative proof and must not be
reported as one.

**What can be prepared here:** a synthetic large-volume seed generator and a load
harness that reports p50/p95/p99 on the money-heavy read paths (VAT quarter,
payroll run, dashboard tiles, outstanding). These run honestly only against
**staging** (§1) on production-class infra.

**EXTERNAL ACTION REQUIRED:** provision staging on production-class Supabase
compute (§1), seed to target volume, run the harness, record the percentiles.
Only percentiles measured on representative infra may be cited.

---

## 6. Operational readiness drills

**Status: PROCEDURES DOCUMENTED / DRILLS PENDING STAGING+MONITORING.**

Runbooks exist (`backup-recovery-runbook.md`, deployment runbook, maintenance
cutover). The drills that turn procedures into proven readiness — restore-from-
backup, simulated outage, secret rotation, incident response with a real alert
firing — require the staging env (§1) and the live monitoring backend (§2) to be
meaningful. **PITR** is a Supabase **plan setting** (operator-only) and cannot be
enabled from code.

**EXTERNAL ACTION REQUIRED (operator):** confirm PITR/backups on the prod plan;
once staging+Sentry exist, run each drill and record the result + timing.

---

## 7. Provider activation (product readiness)

**Status: DARK / CREDENTIAL + RECOGNITION GATED.**

Every non-email provider (Stripe, HMRC MTD, banking Plaid/Nordigen, telematics,
merchant integrations, calendar OAuth, voice telephony) is built dark behind a
config flag. Activation is a **config flip plus real credentials** — no code
change. HMRC additionally requires **HMRC production recognition** (a regulatory
step). Voice telephony has a genuine engineering gap (no `phone_numbers` real
provisioning) noted in `SUBSYSTEM-OWNERSHIP.md`.

**EXTERNAL ACTION REQUIRED (CEO):** obtain each provider's production
credentials + (for HMRC) recognition; then flip the flag. Sandbox contract tests
should run against each provider's sandbox before flipping. **Never** fake a
provider or enter credentials on the CEO's behalf.

---

## Summary of external actions (the CEO/operator checklist)

| # | Action | Unblocks |
|---|---|---|
| 1 | Create staging Supabase + Vercel projects; push migrations | Staging, load proof, drills, pentest env |
| 2 | Create Sentry project; set DSN; confirm scrubbed event + alert fires | Observability proof |
| 3 | Engage external pentest firm with the §3 scope | Security certification |
| 4 | Confirm PITR/backups on prod plan | DR readiness |
| 5 | Obtain provider prod creds + HMRC recognition; flip flags | Product readiness |
| 6 | Assign a named human owner per subsystem; staff to bus-factor > 1 | Bus-factor |

Everything an engineering session can do for each of these is done. The remaining
proof is external by nature and is **not** claimed as complete anywhere in this
repo.
