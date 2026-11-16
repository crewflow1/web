# CrewFlow — Integrations & Background-Jobs Ops Audit

**Scope:** Code-level audit of every configured external integration and background job.
**Method:** Static read of the repository only. No live external calls, no secrets printed, no provider config touched, no dark feature enabled. Unit tier only (integration/E2E owned by the lead).
**Date:** 2026-11-02 · **Branch base:** `main` (worktree off `origin/main`, tip `0118d070`)

Verification axes applied to each subsystem: config gating (dark vs live), credentials read safely, failure handling, retries, **idempotency** (esp. webhooks + crons), event-signature authentication, rate limits, spend controls (£100 AI ceiling), customer-visible fallbacks, and for crons: auth + duplicate/overlap/partial-failure + job-history growth.

---

## 1. Executive summary

CrewFlow's integration layer is **mature and defensive**. Every webhook verifies its signature over the raw body **before** parsing, fails closed when dark, and is idempotent. Every one of the 47 cron routes gates on a shared Bearer-secret chokepoint and wraps its work in telemetry. The AI cost governor enforces the £100/month/org ceiling through an **atomic reserve-then-settle under a per-org advisory lock** and fails closed on unreadable ledgers. No P0/P1 defect was found.

The findings are one **P2** (two per-minute queue drains send before they claim, so overlapping ticks can double-send — one of them, push, is live) and a few **P3** hygiene items. One in-scope low-risk item (the cron-auth chokepoint used a non-constant-time secret compare and had no direct test) has been **fixed with a unit test** in this PR.

| Severity | Count | Items |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 1 | F-1 push/sms drains lack atomic claim-before-send (overlap double-send) |
| P3 | 4 | F-2 cleanup-every-minute; F-3 rate-limit fails open; F-4 cron-auth non-constant-time (**fixed**); F-5 maintenance → 401 semantics |

---

## 2. Findings ledger (for the lead's defect ledger)

### F-1 — Push & SMS drains send before they claim (overlap → double-send) · **P2**
**Files:** `lib/notifications/push.ts:377` (select `queued` → send → settle) · `lib/notifications/sms.ts:377-504` (same shape) · schedules `* * * * *` in `vercel.json` (`push-drain`, `sms-drain`).

Both drains `SELECT ... WHERE status='queued' AND scheduled_for <= now()` (sms `lib/notifications/sms.ts:381-387`), iterate, call `provider.send(...)`, and only **then** flip the row to `sent` (`settle`, `lib/notifications/sms.ts:456-464`). There is no atomic claim transition between the read and the send. Two overlapping cron invocations (Vercel does **not** guarantee non-overlap; a slow tick over a 50-row batch of network sends can run past the 60s boundary) both read the same `queued` rows and both dispatch → **duplicate push notification / duplicate SMS**. The `(notification_id, user_id)` unique constraint (`supabase/migrations/20261166000000_push_notifications.sql:181`) dedupes *enqueue*, not *send*.

This is a **deviation from the codebase's own reference pattern**: `server/services/webhook-dispatch.ts:131-138` (`webhook_claim_deliveries`) and `server/services/automation-schedules.ts:17-37` both claim atomically with a lease before acting, and the Stripe receiver does the same (`server/services/stripe-webhook-handler.ts:156-233`). The sms drain's own docstring even claims it "Mirrors push" and the push drain claims to mirror `webhook-dispatch` — but neither adopted the claim step.

**Blast radius today:** push is **live** (L1 set), so this is a real latent production defect; sms is **dark** (`isSmsConfigured()` false in prod), so inert until activation. Realistically low-frequency (requires tick overlap), hence P2 not P1.

**Not fixed here (out of scope):** a safe fix needs a lease/claim column + a claim RPC mirroring `webhook_claim_deliveries` (status `queued → delivering` with `lease_expires_at`, re-claim after cutoff). That is a **schema migration**, which the lead/DB owner must author and apply. A pure-code "mark sent before send" would trade double-send for silent message **loss** on crash — strictly worse — so it was deliberately not attempted.

### F-2 — SMS/push drains run the retention cleanup every minute · **P3**
**Files:** `app/api/cron/sms-drain/route.ts:52-58`, `app/api/cron/push-drain/route.ts:53-57`.

The route calls `cleanupOldSmsDeliveries()` / `cleanupOldPushDeliveries()` on **every** tick unless `?skip_cleanup=1` is passed, but Vercel cron hits the bare path, so the full-table retention DELETE (`lib/notifications/sms.ts:510-523`) runs 1,440×/day despite the function docstring saying "Nightly housekeeping". The delete is filtered + cheap and usually matches 0 rows, so this is wasted DB work, not a correctness bug. (When dark it is also a no-op; `isSmsConfigured()` short-circuits the whole route.) Suggested fix: gate the cleanup to a single daily window in the route (pure code), or move it to a dedicated daily cron like `cron-runs-prune`.

### F-3 — Magic-link rate limiter fails open · **P3** (documented tradeoff)
**Files:** `app/(auth)/actions.ts:90-96`, `lib/security/rate-limit.ts:75,109,125,129-133`.

The per-address magic-link throttle (email-bomb / Supabase-cost-abuse guard) returns `{ allowed: true }` on any limiter internal error (store outage, clock skew, corrupted entry). During a limiter outage the throttle is bypassed and Supabase Auth email sends are uncapped. This is a deliberate, documented posture ("a broken limiter must not lock everyone out"), acceptable for availability, but worth the lead knowing it exists as an abuse window. No change recommended without a product call.

### F-4 — Cron-auth chokepoint: non-constant-time compare + no direct test · **P3** — **FIXED in this PR**
**File:** `lib/cron/auth.ts`.

`isCronAuthorised` compared the Bearer token with `header === \`Bearer ${secret}\`` — a short-circuiting compare, inconsistent with every other secret/signature comparison in the codebase, which uses `timingSafeEqual` (`lib/comms/providers/{meta-whatsapp,resend-events,inbound-email}.ts`, `lib/telephony/providers/vapi.ts`). It also had **zero direct unit coverage** — the 47 per-route tests all *mock* this function, so its own logic (secret match, missing-secret fail-closed, maintenance suppression) was untested. **Fix:** constant-time comparison via `node:crypto.timingSafeEqual` (length-guarded) + new `__tests__/cron/cron-auth.test.ts` pinning all four branches. Low risk, no schema/provider change.

### F-5 — Maintenance window returns 401 "unauthorized" for crons · **P3** (cosmetic)
**File:** `lib/cron/auth.ts` (maintenance check returns `false` → route answers `401 {error:"unauthorized"}`).

During `MAINTENANCE_MODE=on`, authentic cron calls are refused as *unauthorized* rather than a retry-safe maintenance signal. Functionally fine (Vercel does not retry a skipped tick; jobs resume next tick), but the status/label misattributes the cause in logs. Informational only.

---

## 3. Per-integration verification

### Stripe — SaaS billing webhook · **VERIFIED-safe (code)** / live-creds to prove E2E
- **Route** `app/api/webhooks/stripe/route.ts`: `nodejs` runtime, `force-dynamic`, raw body read via `request.text()` (`:61`), **mandatory** signature verify `stripe.webhooks.constructEvent` (`:65`) → 401 on missing/invalid (`:55-73`); 503 when Stripe/webhook-secret unconfigured (`:38-52`); maintenance → 503 retry-safe (`:29-36`). 500 on handler throw so Stripe retries (`:92-105`).
- **Handler** `server/services/stripe-webhook-handler.ts`: **atomic claim-based idempotency** — `event_id` UNIQUE INSERT is the first-delivery claim (`:163-169`); on 23505 collision a **single conditional UPDATE** reclaims only rows that are `processed_at IS NULL AND (error_message IS NOT NULL OR claimed_at < now()-15m)` (`:197-217`), closing the read-then-act double-dispatch window; live claims and completed rows ack as `duplicate` and run nothing (`:226-231`). `processed_at` stamped only on success/no-op (`markProcessed :740-758`); failures leave it NULL + record `error_message` (`markFailed :775-790`) so at-least-once retry works. Service-role client throughout for cross-tenant lookups. Handlers cover checkout/subscription/invoice/payment_intent/customer events.
- **Blocked to fully prove:** needs the live webhook signing secret + real/replayed Stripe events (integration tier, lead-owned) to exercise end-to-end. Per memory, write-scopes are not charge-tested by design.

### Stripe Connect — portal invoice webhook · **VERIFIED-safe (code)** / dark
- `app/api/webhooks/stripe-invoice/route.ts`: **separate** endpoint, **separate** secret `STRIPE_INVOICE_WEBHOOK_SECRET` (never the SaaS one, `:54`), **separate** Connect client; 503 before verifying when dark (`:23-57`), 401 on missing/invalid signature (`:59-73`). Delegates to `server/services/portal-invoice-webhook-handler.ts` → idempotent `settleInvoicePayment` keyed on `invoice_payments`, **never touches `billing_events`** (`:19-27`). Tenant-isolated.

### Resend (outbound email) + Resend/inbound-email webhooks · **VERIFIED-safe (code)** / dark
- **Send:** `lib/email/send.ts` degrades gracefully (`no_key`), self-loop guard (`:56-64`), never throws (structured `SendEmailResult`), dynamic import. No idempotency key passed to Resend — acceptable since callers are action- or claim-gated.
- **Resend events webhook** `app/api/webhooks/resend/route.ts` + `lib/comms/providers/resend-events.ts`: Svix HMAC-SHA256 over `<id>.<ts>.<rawBody>`, `timingSafeEqual` (`:98`), **replay guard** on signed timestamp (`:30,58-60`), dark gate before body read, dedupe on `(provider, provider_event_id)`.
- **Inbound email** `app/api/webhooks/email/route.ts` + `lib/comms/providers/inbound-email.ts`: HMAC `timingSafeEqual` (`:60`) before parse, fail-closed dark gate, idempotent claim ledger.

### Supabase Auth SMTP · **VERIFIED-safe (code)** / config-level to prove
- `app/(auth)/actions.ts`: magic link via `supabase.auth.signInWithOtp` (`:108-112`), per-address rate limit (`:90-96`, see **F-3**), email validated + length-capped (`:72,154,162`). Email+password sign-in is an **activation/config note** (`:136-142`), not code-gated. SMTP delivery itself is a Supabase dashboard config (per memory, 587 fix verified) — provable only against the live project.

### WhatsApp / Meta + Twilio SMS/voice + Vapi · **VERIFIED-safe (code)** / dark
- **WhatsApp** `app/api/webhooks/whatsapp/route.ts` + `lib/comms/providers/meta-whatsapp.ts`: GET verify handshake fails closed on token mismatch (`:52-57`), POST verifies `x-hub-signature-256` via `verifyMetaSignature` (`timingSafeEqual :57`) before parse; dark unless flag + app-secret + verify-token set.
- **Twilio SMS status** `app/api/webhooks/twilio/sms-status/route.ts` + `lib/comms/providers/twilio.ts`: `twilio.validateRequest` (SDK HMAC-SHA1) (`:181`), hard 401 on missing/invalid, idempotent receipt append; canonical-status allowlist else 4xx.
- **Vapi** `app/api/webhooks/vapi/route.ts` + `lib/telephony/providers/vapi.ts`: rate-limit → dark 503 → raw body → shared-secret `X-Vapi-Secret` compared **constant-time** (`:36-37,80`), optional HMAC path, fail-closed; idempotent on Vapi call id; org attributed from dialed number.
- Per memory, real inbound WhatsApp delivery is blocked Meta-side; all of the above need live provider credentials + real deliveries to prove end-to-end.

### AI cost governor + Anthropic/OpenAI call sites · **VERIFIED-safe (code)**; cheap tier proven, mid/high need creds
- **Ceiling enforcement** `lib/ai/governor.ts`: £100/month/org hard ceiling (`:10-11`). The authoritative path is `reserveBudget` → `ai_reserve_invocation` RPC, **atomic reserve-then-settle under a per-org advisory lock** (`:63-66,579-668`): reservation fails **closed** on any RPC error/throw/unrecognised outcome (`:600-607,637-672`). `checkBudget` also **fails closed** on unreadable ledger/reservation reads (denies rather than assuming £0, `:275-305`) with loud Sentry reporting. Dedupe + per-employee limit enforced inside the lock. Settlement records failures too (`FAILURE_FLOOR_PENCE`) so retry storms stay visible (`:1051-1082`); settle is best-effort with bounded retry, erring toward over-blocking not under-counting.
- **No ungoverned call site:** every `invokeWithGovernor` wrapper (40+ files) routes its provider leg through the reservation. The three services with a direct `new Anthropic(...).messages.create` (`server/services/lead-summary.ts:199`, `research-llm.ts:164`, `receptionist.ts:3072`) each do so **inside** a `*WithProvider` closure invoked by `invokeWithGovernor` (e.g. `lead-summary.ts:135-149`). The low-level adapters (`lib/ai/text/*`, `lib/ai/vision/*`, `lib/ai/embeddings/*`) are the governed callee layer. A per-tier dark short-circuit + cross-tier "provider resolvable while tier dark ⇒ refuse" backstop prevents ungoverned spend (`:931-984`).
- Mid/high tiers await CEO credential clicks (per memory); cheap tier production-proven. Live proof of a real spend-block needs armed providers (lead/CEO).

### Sentry / monitoring · **VERIFIED-safe (code)**
- `sentry.server.config.ts`: enabled only when DSN + env allow (`monitoringEnabled`), `beforeSend`/`beforeSendTransaction = scrubEvent` (`:31-34`) — PII/URL redaction in `lib/monitoring/scrub.ts` (`redactObject`, `redactUrl`, `scrubEvent` can drop an event entirely). `tracesSampleRate` 0.1 prod / 0.5 dev. `sendDefaultPii` not enabled — only scrubbed data attached.

### Storage / signed URLs · **VERIFIED-safe (code)**
- All ~12 `createSignedUrl(s)` sites use **short TTLs** (60s typical; `company-logo` uses `LOGO_SIGNED_TTL`), via the service-role admin client behind authz checks. Customer-portal attachment downloads verify the token→resource binding before signing (`app/customer-portal/[token]/documents/attachments/[id]/route.ts:47`). Consistent with the storage-evidence wave that closed the historical cross-tenant signed-URL primitive (per memory).

### Cron fleet (47 routes) · **VERIFIED-safe (code)**, except F-1/F-2
- **Auth:** every route calls `isCronAuthorised` (verified across all 47) → 401 otherwise; Bearer `CRON_SECRET`, fail-closed when unset, maintenance-suppressed (`lib/cron/auth.ts`). Now constant-time + unit-tested (**F-4**).
- **Telemetry / history growth:** every route wraps work in `withCronTelemetry` (`lib/ops/cron-telemetry.ts`) writing one `cron_runs` row; never throws (best-effort), surfaces non-throwing `ok:false`. **`cron_runs` growth bounded** by `cron-runs-prune` (14d success / 90d failure, batched — `app/api/cron/cron-runs-prune/route.ts`, `server/services/cron-runs-prune.ts`), which fixed the table being ~70% of the DB.
- **Registry:** `lib/ops/cron-routes.ts` derives the roster from `vercel.json` (single source of truth; throws on a path outside `/api/cron/`), pinned by `__tests__/ops/cron-coverage.test.ts`.
- **Overlap/duplicate:** outbox-style jobs claim atomically (`webhook-dispatch`, `automation-schedules-drain`, `task-reaper` lease recovery, saga/spine consumers) ✓. Daily reminder crons are idempotent via unique partial indexes (e.g. `invoice_reminders_unique_auto_stage`, `app/api/cron/invoice-reminders/route.ts:150-221`) and run daily, so overlap is practically impossible. The exceptions are the two per-minute drains in **F-1**.
- **Dark gating:** dark crons (sms, whatsapp-sweep, memory-embed, bank/calendar/telematics sync, weather, HQ runners, outreach/research) short-circuit before any DB/network work (e.g. `sms-drain` 204 no-op), each pinned by a `*-cron-dark` test.

---

## 4. Fixes applied in this PR

| File | Change |
|---|---|
| `lib/cron/auth.ts` | Secret compare hardened to constant-time (`node:crypto.timingSafeEqual`, length-guarded), matching the comms webhook verifiers. Behaviour unchanged for valid/invalid tokens. |
| `__tests__/cron/cron-auth.test.ts` | **New** direct unit coverage for the cron-auth chokepoint: accepts exact secret; rejects wrong secret, missing header, scheme-less token, and a length-mismatched prefix; fails closed with no secret; suppresses all crons during maintenance. 7 tests, green. |

**Verification:** `npx vitest run __tests__/cron/cron-auth.test.ts` → 7/7 pass. Regression: `sms-drain-cron-dark` + `push-drain-cron-dark` + cron-auth → 13/13 pass. ESLint clean on both files. `npm run typecheck` surfaces only pre-existing `e2e/*.spec.ts` Playwright `playwright-core` dual-resolution errors (a worktree artifact — `web/node_modules` vs `web-main/node_modules`), none in changed files.

---

## 5. Blocked / NEED-live-credentials-to-prove

These are **code-verified** but cannot be proven end-to-end without live credentials / real provider traffic (all out of scope for this audit):

- **Stripe SaaS + Connect** — live signing secrets + real/replayed events (charge-testing out of scope by design).
- **Resend send + events, inbound email** — Resend API key + endpoint secret + real deliveries.
- **WhatsApp/Meta, Twilio SMS/voice, Vapi** — provider credentials + real inbound (Meta-side delivery currently blocked per memory).
- **Supabase Auth SMTP** — live Supabase project SMTP config (dashboard).
- **AI governor mid/high tiers** — armed Anthropic/OpenAI keys (CEO clicks); cheap tier already production-proven.
- **Bank / calendar / accounting / telematics / weather sync** — dark; provider credentials + flags.

---

## 6. Recommended follow-ups (for the lead)

1. **F-1 (P2):** author a claim RPC + lease column for `sms_deliveries` / `push_deliveries` mirroring `webhook_claim_deliveries`, and switch both drains to claim-before-send. Needed before SMS activation; fixes live push double-send-on-overlap.
2. **F-2 (P3):** gate the per-minute drains' retention cleanup to a daily window (pure code).
3. **F-3 (P3):** product decision on whether the magic-link limiter should fail open or closed.
