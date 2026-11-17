# Webhook & callback verification matrix

Workstream: injection / untrusted input · branch `security/injection-surface-hardening` · baseline `8cec66a7` · 2026-11-13.

Every inbound door that is called by a machine rather than a signed-in user. For each: what authenticates it, whether that check runs **before any side effect**, whether the comparison is **constant-time**, whether **replays** are refused, and what happens when the **secret env var is unset** (must fail closed).

Evidence labels follow AGENT-RULES §5. "Forgery matrix" = `__tests__/security/injection-webhook-forgery.test.ts` (new; drives the real route handler + real verifier, downstream service replaced by a spy; 23 tests).

## Provider webhooks

| Route | Auth mechanism | Verified before side effect | Constant-time | Replay defence | Secret unset ⇒ | Dark gate | Evidence |
|---|---|---|---|---|---|---|---|
| `POST /api/webhooks/stripe` | `stripe.webhooks.constructEvent` over the raw body, `STRIPE_WEBHOOK_SECRET` | Yes — nothing but the maintenance gate precedes it | Yes (Stripe SDK) | Yes — SDK 300 s timestamp tolerance; plus `billing_events` dedupe on event id | **503** `webhook_secret_not_configured`, handler not called | none (live) | **VERIFIED** — forgery matrix: 6 forged variants → 401; 1 h-old correctly-signed → 401; secret unset → 503; control → 200, handler called once |
| `POST /api/webhooks/stripe-invoice` | same, `STRIPE_INVOICE_WEBHOOK_SECRET`, separate Connect key | Yes | Yes (SDK) | Yes (SDK tolerance; idempotent settle) | **503**, also 503 when the feature flag / Connect key is absent | flag + key | **VERIFIED (static)** `app/api/webhooks/stripe-invoice/route.ts:47-76`; behavioural cover exists in `__tests__/security/portal-invoice-payments.test.ts` (not re-run by me in isolation) |
| `POST /api/webhooks/whatsapp` | `X-Hub-Signature-256` HMAC-SHA256 over raw body, `WHATSAPP_APP_SECRET` | Yes — raw body read, verified, only then parsed | Yes (`timingSafeEqual`, length pre-check) | **No provider timestamp** (Meta signs body only). Mitigated by the per-message claim ledger (`whatsapp_webhook_events`, idempotent on wamid) | **401** for every signature (`verifyMetaSignature` returns false with no secret) | flag `NEXT_PUBLIC_FEATURE_WHATSAPP` (404 before the body is read) | **VERIFIED** — forgery matrix: 8 forged variants → 401; secret unset → 401; flag off → 404; control → 200 |
| `GET /api/webhooks/whatsapp` (Meta subscribe handshake) | `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN` | n/a (no side effect; echoes `hub.challenge` as `text/plain`) | **Was `!==` — FIXED** to `constantTimeEqual` (commit `1d33d631`) | n/a | **403**, challenge not echoed | flag | **VERIFIED** — forgery matrix (unset token: `""`, `"undefined"`, `"null"`, absent all 403; near-miss tokens 403; exact → 200) |
| `POST /api/webhooks/email` | `x-crewflow-email-signature: sha256=<hex>` HMAC over raw body, `INBOUND_EMAIL_WEBHOOK_SECRET` | Yes | Yes | **No timestamp in the signed material.** Mitigated by the claim ledger keyed on provider message id (a replay is a no-op) | **404** (the two-switch gate requires the secret) | flag + secret | **VERIFIED** — forgery matrix: 6 forged → 401; secret unset → 404; control → 200 |
| `POST /api/webhooks/resend` | Svix: `svix-id` / `svix-timestamp` / `svix-signature`, HMAC over `id.timestamp.body`, `RESEND_WEBHOOK_SECRET` | Yes | Yes | **Yes** — timestamp is signed and checked against a tolerance; plus unique `(provider, provider_event_id)` | **404** | flag + secret | **VERIFIED** — forgery matrix: 8 forged (incl. id-swap, timestamp-swap, wrong scheme) → 401; ±1 h → 401; secret unset → 404; control → 200 |
| `POST /api/webhooks/twilio/voice` (+ `/gather`, `/status`, `/dial-status`, `/recording-status`) | `X-Twilio-Signature` via `twilio.validateRequest(authToken, sig, url, params)` | Yes — dark gate → raw body → verify → parse → org resolved from the **dialled number**, never the body | Yes (Twilio SDK) | **No** (Twilio's scheme has no timestamp). Call events are idempotent on `provider_event_id` | **401** (`verifyTwilioSignature` false with no `TWILIO_AUTH_TOKEN`); in practice 503 first because `isVoiceConfigured()` needs the token | flag + provider creds (503) | **VERIFIED (static + existing suites)** — gate order read in all 5 files; existing `__tests__/telephony/twilio-voice-*-route.test.ts` (green in the full unit-tier run) + `__tests__/integration/telephony/*` (green in the targeted integration run) — see audit §3 |
| `POST /api/webhooks/twilio/sms-status` | same Twilio signature | Yes | Yes | No timestamp; receipt write is idempotent on message sid | **401** | none in-route (fails closed on the token) | **VERIFIED (existing suite)** `__tests__/receptionist/twilio-sms-status-route.test.ts` (10 tests, run) |
| `POST /api/webhooks/vapi`, `POST /api/webhooks/vapi/chat-completions` | Shared secret `X-Vapi-Secret` (or `Authorization: Bearer`), `VAPI_WEBHOOK_SECRET`; optional HMAC only under `VAPI_WEBHOOK_HMAC` | Yes | Yes (`constantTimeEquals`) | **No** — a static shared secret cannot bind a timestamp. Events idempotent on provider ids | **401** — "never accept anything when no secret is configured" | flag + provider (503) | **VERIFIED (static + existing suites)** `lib/telephony/providers/vapi.ts:65-90`; `__tests__/telephony/vapi-*-route.test.ts` |
| `POST /api/integrations/calendar/{google,microsoft}/webhook` | Per-channel random token echoed by the provider (`X-Goog-Channel-Token` / `clientState`), stored encrypted | Yes — an unverified notification is a silent 2xx no-op | Yes (`secretsMatch` → `timingSafeEqual`) | No timestamp; effect is "trigger an incremental pull" (idempotent) | n/a — no global secret; no channel row ⇒ no-op. Not connectable ⇒ 200 no-op without any provider fetch | provider connectable | **VERIFIED (static)** `server/services/calendar-pull.ts:598-632`; existing `__tests__/security/calendar-pull.test.ts` |
| `POST /api/receptionist/inbound` (internal channel adapter door) | Shared secret header `x-crewflow-channel-secret`, `CHANNEL_INBOUND_SECRET`; org resolved server-side from the destination, never the body's `org_id` | Yes — 401 before the JSON body is parsed | Yes (`timingSafeEqual`, length pre-check) | No (shared secret) | **401** for everything incl. `""` / `"undefined"` | none in-route | **VERIFIED** — forgery matrix: 5 forged → 401; secret unset → 401; resolver + processor spies never called |

### Observations (not defects)

- **`validationToken` echo on the calendar webhook** (`route.ts:63-69`) runs *before* the dark guard and reflects an attacker-chosen string as `text/plain`. `X-Content-Type-Options: nosniff` is set globally (`lib/security/headers.ts:111`), so this is not XSS; it is unauthenticated reflected text on a first-party origin. Microsoft requires the echo. **P3, not changed** — recommend moving it after the connectable check when the calendar integration is activated.
- **Body-only HMAC schemes (Meta, inbound email) and shared-secret schemes (Vapi, channel door) cannot reject a replayed delivery by time.** Each handler is idempotent on a provider id, so a replay is a no-op rather than a duplicate side effect. If inbound email is ever fronted by a provider that signs a timestamp, the verifier should adopt it.
- **Twilio signature URL** is rebuilt from `x-forwarded-proto` / `x-forwarded-host`. An attacker who controls those headers still cannot forge the HMAC without the auth token, so this does not weaken verification.

## Cron routes (48)

| Property | Result | Evidence |
|---|---|---|
| Every `/api/cron/**/route.ts` calls `isCronAuthorised(request)` inside its handler, before any admin-client / telemetry / fetch / `.from(` | 48 / 48 | **VERIFIED** — forgery matrix "EVERY /api/cron route checks the gate before doing anything else" (source scan, comments stripped) |
| Fails closed when `CRON_SECRET` is unset | Yes — returns false; `"Bearer "`, `"Bearer undefined"`, `"Bearer null"` all refused | **VERIFIED** — forgery matrix |
| Only the exact `Bearer <secret>` header is accepted | Yes | **VERIFIED** — forgery matrix (8 near-misses refused) |
| Constant-time comparison | **Was `header === \`Bearer ${secret}\`` — FIXED** (`lib/cron/auth.ts`, commit `1d33d631`) | **VERIFIED** |
| Replay | Not applicable to a static bearer. Vercel Cron is the only intended caller; the secret is the whole control | — |
| Maintenance mode | All crons refused at the same chokepoint | **VERIFIED (static)** `lib/cron/auth.ts:21-23` |

## Other machine-facing doors (for completeness)

| Route | Auth | Note |
|---|---|---|
| `GET /api/dev/test-login` | 404 unless `VERCEL_ENV ∈ {preview, development}` or `NODE_ENV=development`; then token must match `DEV_TEST_LOGIN_TOKEN` | Allow-list environment gate (fails closed on unknown env). Token compare was `!==` — now constant-time. **VERIFIED (static)** |
| `/api/v1/**` (public API) | `guardPublicApiRequest` — hashed API key + scope | Out of this workstream (secrets / IDOR owners). PATCH handlers read by me use a column allow-list (`pickDefined(…, *_UPDATE_COLUMNS)`) — no mass assignment. |
| `/scim/v2/**`, `/api/sso/**` | SCIM bearer / IdP assertions | Auth correctness is out of scope here; the SSRF side of OIDC is INJ-03 in the audit. |
| OAuth callbacks (`/api/integrations/*/callback`) | `state` cookie + provider code | Not re-audited here (no finding from the redirect-sink sweep: all redirect to fixed in-app paths). |
