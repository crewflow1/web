# CrewFlow — Phase-5 Feature Activation Matrix

**Scope:** every gated / provider-resolved capability in the live production build.
**Baseline:** `origin/main` tip `aedb9279` (= live prod, crewflow.uk). Read-only audit; no code, flag, env or provider was changed.
**Date:** 2026-10-28.
**Authoritative gate documentation:** the richly-commented `lib/env.ts` (zod schema, every flag defaults `"false"`/optional) + the per-domain readiness helpers (`lib/comms/readiness.ts`, `lib/billing/readiness.ts`, `lib/weather/readiness.ts`, `lib/monitoring/readiness.ts`, `lib/analytics/readiness.ts`, `lib/migration/readiness.ts`, `lib/ai/governor/readiness.ts`, `lib/ai/quote-writer-readiness.ts`).

## The two-switch discipline (verified)
Every gated capability needs BOTH (a) a feature flag (`FEATURE_*` / `NEXT_PUBLIC_FEATURE_*`, each defaulting to `"false"` or unset) AND (b) a credential / provider / per-org binding, and every consumer **refuses-before-fetch** when either is missing. The readiness helpers never let a headline (`outboundReady` / `activated` / `available`) go true on a credential alone — the load-bearing rule `outboundReady` can never be true without a build-time `senderImplemented`/`modelBindingPresent` is enforced and drift-tested. There is a dedicated **security test tier** (`__tests__/security/`) that pins the dark/gated state of nearly every item below (named per row).

## Live `/api/health` snapshot (prod, operator-captured)
`email=true · whatsapp=true · sms=false · missedCallTextback not ready · weather unavailable · analytics client+server OFF · monitoring on · billing configured+webhook, selfServe=false · apiKeys implemented · migrationOperator configured`.

---

## Classification key
- **A** — implemented & safe to activate (finish validation / flip only; no external credential, no legal/commercial gate).
- **B** — incomplete but in-scope for launch (needs build).
- **C** — deliberately deferred (keep dark; reason stated).
- **D** — provider / credential / legal-dependent (everything built; names the exact external action).

## Summary table

| Flag / capability | Class | Prod state | Missing switch |
|---|---|---|---|
| `FEATURE_HQ_AUTONOMOUS_APPLY` | C | OFF (unset) | flag `"on"` — held by CEO (ADR-0011); triple-locked |
| `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` | D | OFF, not ready | flag **+** Twilio SMS creds + sender |
| `NEXT_PUBLIC_FEATURE_WHATSAPP` | D | **ON (outbound live)** | neither — both switches set; real inbound blocked **Meta-side** |
| `NEXT_PUBLIC_FEATURE_INBOUND_EMAIL` | D | OFF | flag **+** `INBOUND_EMAIL_WEBHOOK_SECRET` + external inbound-mail routing |
| `NEXT_PUBLIC_FEATURE_RESEND_EVENTS` | D | OFF | flag **+** `RESEND_WEBHOOK_SECRET` (Resend endpoint config) |
| `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` | D | OFF | flag **+** Twilio/Vapi provider creds |
| `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS` | A | OFF | **flag only** (email provider already live) — see consent caveat |
| `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` | C | OFF | flag — rides the dark receptionist channel; never autonomous |
| `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS` | A | OFF | **flag only** (per-org endpoint verify is the real gate) |
| `FEATURE_GDPR_ERASURE` | C | OFF | flag — destructive; enable only to perform an erasure |
| `FEATURE_RETENTION_PURGE` | C | OFF (dry-run) | flag — destructive; keep in dry-run |
| `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` | D | OFF | flag **+** `HMRC_CLIENT_ID/SECRET` **+** HMRC vendor recognition (legal) |
| `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` | D | OFF | flag **+** aggregator creds + `BANKING_PROVIDER` **+** FCA AISP auth (legal) |
| `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` | D | OFF | flag **+** aggregator creds + `TELEMATICS_PROVIDER` (CEO provider choice) |
| `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` | D | OFF | flag **+** `STRIPE_CONNECT_SECRET_KEY` **+** per-tenant connected account |
| `NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING` | D | OFF | flag **+** plan prices in Stripe (key already present) |
| `NEXT_PUBLIC_FEATURE_MERCHANTS` | D | OFF | flag **+** per-merchant creds/endpoint **+** trade-account contract (commercial) |
| `FEATURE_CALENDAR_CONNECT` | D | OFF | flag **+** Google/MS Graph client creds **+** `INTEGRATION_TOKEN_ENCRYPTION_KEY` |
| `FEATURE_ACCOUNTING_CONNECT` | D | OFF | flag **+** Xero/QBO/Sage client creds **+** `INTEGRATION_TOKEN_ENCRYPTION_KEY` |
| `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO` | D | OFF | flag **+** Azure AD app + Supabase Azure provider config |
| `NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING` | D | OFF | flag **+** Supabase "Manual Linking" dashboard toggle (no credential) |
| `FEATURE_MFA_ENFORCEMENT` | A | OFF | **flag only** (per-org `require_mfa` is the real gate); no external dep |
| `FEATURE_PUBLIC_API_JOBS` | C | OFF | flag — held pending CEO/product decision to expose tenant data |
| `FEATURE_MARKETPLACE` | C | OFF | flag — held pending a real partner/commercial program |
| `FEATURE_ENTERPRISE_SSO` | D | OFF | flag **+** per-org config + customer IdP metadata / SCIM token (external) |
| AI governor tiers (cheap/mid/high/embedding/transcription) | A | **ACTIVATED (bound + keyed), governed** | none — calibration/validation only |
| Stripe SaaS billing (sales-led) | A | **LIVE** (configured + webhook) | none — self-serve surface stays dark by choice |
| Resend email | A | **LIVE** (`email=true`) | none |
| Twilio SMS / voice | D | OFF | `TWILIO_ACCOUNT_SID/AUTH_TOKEN` (+ `TWILIO_SMS_FROM`) |
| Vapi voice | D | OFF | `VAPI_WEBHOOK_SECRET` + voice flag |
| WhatsApp (Meta) | D | **ON outbound** | Meta-side inbound delivery unresolved |
| Weather | D | unavailable | `WEATHER_PROVIDER=open-meteo` + `OPEN_METEO_API_KEY` (commercial licence) |
| Companies House sourcing | D | dark | `COMPANIES_HOUSE_API_KEY` (free key) |
| AI quote-writer | A | **available** (key present), human-review gated | none — validation only |

**Counts:** **A = 7** · **B = 0** · **C = 6** · **D = 20** (33 rows).
(No Class B: the build-dark doctrine means every item is engineering-complete behind its gate; nothing in this set is half-built.)

---

## Per-feature detail

### Class A — implemented & safe to activate (finish validation / flip only)

#### `FEATURE_MFA_ENFORCEMENT` (server-only)
- **Intended users:** org owners/admins (per-org enforceable MFA).
- **Prod state:** OFF (default). The `require_mfa` per-org flag + the fail-closed `aal2` gate in `server/auth/session.ts#requireOrgContext` are built and tested; while the deployment flag is off the path is wholly inert.
- **Missing switch:** flag only. Enforcement needs BOTH this deployment gate AND a given org's `organizations.require_mfa` — so no external credential.
- **Security:** positive (raises auth assurance); fail-closed; cannot gate anyone while off.
- **Cost:** free. **Coverage:** `__tests__/security/mfa-enforcement.test.ts`, `mfa-recovery-codes.test.ts`.
- **Safe activation:** flip the deployment flag, then let orgs opt in; validate the enrolment-bounce UX for owners with no factor first.

#### `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS`
- **Intended users:** orgs integrating CrewFlow events into their own systems.
- **Prod state:** OFF. While off the dispatch cron 204-no-ops (zero egress) and the settings UI is read-only.
- **Missing switch:** platform flag only; the **real** second gate is per-org (each org must configure AND verify a signed-ping endpoint before any event fans out).
- **Security:** SSRF-guarded (`lib/webhooks/ssrf.ts`), signed payloads, per-org verify. Low blast radius.
- **Cost:** free. **Coverage:** `__tests__/security/outbound-webhooks.test.ts`.
- **Safe activation:** flip flag; per-org verification remains mandatory.

#### `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS`
- **Intended users:** tenants sending proactive asset/vehicle maintenance reminders to their customers.
- **Prod state:** OFF — but this is the **only** gated feature whose provider half is already satisfied in prod: `isMaintenanceRemindersSending()` requires the flag AND `getEmailReadiness().outboundReady`, and email is `outboundReady=true` live. So the **flag is the only missing switch.**
- **Missing switch:** flag only.
- **Security / caveat:** activation causes the platform to **send customer-facing emails automatically** — treat as a product + consent (marketing-permission) decision, not a pure ops flip, even though it is engineering-ready.
- **Cost:** free (rides existing Resend). **Coverage:** `__tests__/security/maintenance-reminders.test.ts`, `phase7.test.ts`.
- **Safe activation:** product/consent sign-off, then flag flip; validate the skipped_dark→sending transition and unsubscribe handling.

#### AI governor tiers — cheap / mid / high / embedding / transcription
- **Intended users:** every governed AI surface (receptionist, insights, HQ boards, quote-writer, OCR, memory, research).
- **Prod state:** **ACTIVATED.** All five tiers are BOUND in `lib/ai/governor/registry.ts` (`TIER_MODEL`): cheap→`claude-haiku-4-5-20251001`, mid→`claude-sonnet-5`, high→`claude-opus-5`, embedding→`openai/text-embedding-3-small`, transcription→`openai/gpt-4o-mini-transcribe`. With the vendor keys present (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) the governor reports `activated=true`. Spend is live only where the **feature/channel** is also live (see AI safety section — most customer-facing surfaces are still dark channels or degrade deterministically).
- **Missing switch:** none for the tiers themselves; what remains is per-feature/channel activation and **envelope calibration** (`ai_reservations_month_totals.overrun_count`).
- **Security:** governed — £100/org/month hard ceiling, per-org advisory-lock atomic reservation, per-employee limits, audit ledger, fail-closed. Zero ungoverned inference entry points (`AI_UNGOVERNED_INFERENCE_ENTRY_POINTS = 0`, ratchet-pinned).
- **Cost:** metered-AI (ceiling-bounded). **Coverage:** `ai-cost-governor.test.ts`, `ai-budget-controls.test.ts`, `ai-governance-closure.test.ts`, `ai-cost-observability.test.ts`, `tier-bindings` (unit).
- **Safe activation:** already active; calibrate reservation envelopes and keep per-channel activation CEO-gated.

#### AI quote-writer
- **Intended users:** operators drafting a scope-of-works (manual "Draft with AI", human-reviewed before it becomes a quote).
- **Prod state:** `available=true` when `ANTHROPIC_API_KEY` is present (pipeline built, `quote.writer_draft` registered, mid tier bound). It is **human-gated** (draft-first; the operator edits/prices/approves) and governed; it is never autonomous.
- **Missing switch:** none when the key is present — validation only.
- **Security:** mandatory human review; no auto-send; governed under the mid tier.
- **Cost:** metered-AI. **Coverage:** `__tests__/security/ai-quote-writer.test.ts`.
- **Safe activation:** validate draft quality + governor accounting; keep the human-review gate.

#### Stripe SaaS billing (sales-led) & Resend email
- **Stripe SaaS billing:** **LIVE** — `secretConfigured=true`, `webhookConfigured=true`. Powers the demo/sales-led checkout (£1,000 setup + £500/mo). Self-serve surface deliberately dark (`selfServeFlag=false`). Restricted `rk_live_` least-privilege key (per ops memory). Coverage: `stripe-connect-onboarding.test.ts`, billing readiness.
- **Resend email:** **LIVE** (`email=true`, `outboundReady`). Core customer-facing channel (quotes/invoices/notifications). No flag (core capability).

---

### Class C — deliberately deferred (keep dark)

#### `FEATURE_HQ_AUTONOMOUS_APPLY` (+ `CREWFLOW_EXECUTOR_APPLY`, `CREWFLOW_HQ_APPLY_ON_APPROVAL`, `CREWFLOW_EXECUTOR_SHADOW`)
- **Intended users:** HQ/AI-employee autonomous execution of bound apply boundaries. **Highest blast radius in the repo.**
- **Prod state:** OFF. **Triple-locked:** (1) deny-by-default structural posture floor (`server/sdk/gate.ts`), (2) two runtime kill-switches, (3) this master lock — each requires the exact literal `"on"`. While off, every apply authority resolves every descriptor to `null` before any tool is consulted.
- **Why deferred:** CEO stage-gated per ADR-0011; enabling autonomous apply is a deliberate, separate CEO act. This is exactly the "enable autonomous customer-facing AI actions" that CLAUDE.md prohibits without explicit human action.
- **Cost:** metered-AI when on. **Coverage:** `autonomous-apply-dark.test.ts`, `hq-apply-drain-cron-dark.test.ts`, `hq-apply-on-approval.test.ts`, `executor-shadow-crosses-no-boundary.test.ts`, `executor-consumes-not-mutates-registry.test.ts`.
- **Keep dark** until an explicit CEO ADR-0011 decision.

#### `FEATURE_GDPR_ERASURE` (server-only, destructive)
- Right-to-erasure / account teardown. OFF. Three locks (flag + authenticated org OWNER/super-admin + confirmation token = org slug; DB primitive is service_role-only and re-checks). Deferred because it is **destructive** — enable only at the moment a human-authorised erasure is performed, then disable. Coverage: `gdpr-erase.test.ts`, `gdpr-export.test.ts`, `compliance-delete-gate.test.ts`.

#### `FEATURE_RETENTION_PURGE` (server-only, destructive)
- Data-retention purge. OFF ⇒ every enabled per-org policy runs in **dry-run** (audits, deletes nothing). Flipping makes the same policies purge for real; DB primitive is service_role-only and enforces the statutory/financial/audit exclusion allowlist regardless. Deferred — keep in dry-run until a deliberate purge is authorised. Coverage: `retention-purge-primitive.test.ts`, `retention-policy-exclusions.test.ts`, `retention-register-org-scope.test.ts`, `retention-schedule-pure.test.ts`.

#### `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION`
- R28 Conversation Execution Engine's controlled live booking. OFF ⇒ every prepared booking is `blocked_by_org`. Even when armed, the strongest eligibility is `requires_human_review` — **never autonomous**. Deferred: it rides the receptionist/voice channel which is itself dark. Coverage: receptionist execution/live-execution invariants tiers.

#### `FEATURE_PUBLIC_API_JOBS` (server-only)
- Public, key-authenticated read API (`/api/v1/jobs*`, 15 endpoints built dark). OFF ⇒ routes 404. Flag-only engineering, but **deliberately held**: exposing tenant data through a public API is a CEO/product decision, not an ops flip. Coverage: `public-api-jobs.test.ts`, `public-api-expansion.test.ts`, `public-api-writes.test.ts`, `public-api-rate-limit-failclosed.test.ts`, `api-keys.test.ts`.

#### `FEATURE_MARKETPLACE` (server-only)
- Partner/marketplace platform (developer listings, consent-gated installs). OFF ⇒ surface 404s. Engineering complete; deferred because going live needs a real external partner program (commercial agreements, developer vetting) that does not exist yet. Coverage: `marketplace-trust-boundary.test.ts`.

---

### Class D — provider / credential / legal-dependent (built; exact external action named)

> All items below **refuse-before-fetch** while any required credential is absent, and all are pinned dark/gated by a dedicated security test. Tokens-at-rest for the OAuth integrations reuse `INTEGRATION_TOKEN_ENCRYPTION_KEY` (unset today; the callback tripwire refuses a token exchange without it).

#### `NEXT_PUBLIC_FEATURE_WHATSAPP` — WhatsApp (Meta Cloud API)  ⚠️ **ON in prod**
- **Intended users:** receptionist inbound/outbound WhatsApp.
- **Prod state:** `comms.whatsapp.outboundReady = true` ⇒ **both switches are set in production** (flag `true` + `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` + usable `COMMS_WHATSAPP_PROVIDER`). This is a **deliberate activation attempt**, not a leak, but it is the one gated channel that is actually ON. Narrowed by the founder `WHATSAPP_TEST_RECIPIENT_ALLOWLIST` safety net.
- **External action outstanding:** resolve the **Meta-side inbound delivery failure** (Meta sends 0 POSTs to CrewFlow) — real inbound is **not production-proven**; app-level verify-token drift remains. Inbound readiness also needs `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`.
- **Security:** HMAC X-Hub-Signature verify (fails closed), test-recipient allowlist, governed AI drafting. **Coverage:** `comms-invariants.test.ts`, `whatsapp-events-sweep-cron-dark.test.ts`, receptionist transport invariants.
- **Cost:** new-recurring (Meta conversation pricing).

#### `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` + Twilio SMS
- Missed-call SMS text-back. OFF + not ready. Needs flag AND Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`. **External action:** provision a Twilio account + sender number. Cost: new-recurring (Twilio per-SMS). Coverage: comms readiness + `comms-invariants.test.ts`.

#### `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` + Twilio/Vapi voice
- Inbound voice receptionist (Wave 8). OFF ⇒ voice webhooks 503. Needs flag AND a resolvable voice provider: Twilio (`TWILIO_ACCOUNT_SID`+`AUTH_TOKEN`) or Vapi (`VAPI_WEBHOOK_SECRET`), via `COMMS_VOICE_PROVIDER`. **External action:** provision Twilio or Vapi + a phone number. Cost: new-recurring. Coverage: `telephony-voice-invariants.test.ts`, `telephony-terminal-extraction.test.ts`, receptionist voice tiers. (Spoken AI turn `receptionist.voice_turn` is governed/dark until the channel is live.)

#### `NEXT_PUBLIC_FEATURE_INBOUND_EMAIL` + `INBOUND_EMAIL_WEBHOOK_SECRET`
- Inbound email ingestion (lead + notification only; opens no outbound path by design). OFF ⇒ webhook 404s before any work. Needs flag AND the shared HMAC secret. **External action:** stand up an inbound-mail provider/adapter that signs-and-POSTs, and set the secret. Cost: provider-dependent. Coverage: `inbound-email-isolation.test.ts`, `inbox-org-isolation.test.ts`.

#### `NEXT_PUBLIC_FEATURE_RESEND_EVENTS` + `RESEND_WEBHOOK_SECRET`
- Resend delivery-events ingestion (open/click/bounce audit). OFF ⇒ webhook 404s. Needs flag AND the SVIX signing secret. **External action:** configure a Resend webhook endpoint and copy its `whsec_` secret (low effort — Resend is already the live email provider). Cost: free. Coverage: comms delivery-monitoring invariants.

#### `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` + HMRC MTD
- OFF ⇒ connect/callback 503. Needs flag AND `HMRC_CLIENT_ID`+`HMRC_CLIENT_SECRET`. **Even both only enable CONNECT, never SUBMIT.** **External action:** obtain HMRC OAuth credentials AND complete **HMRC vendor recognition (a legal gate)** before any return can be filed. Cost: new (HMRC MTD). Coverage: `hmrc-connections.test.ts`, `hmrc-submit-adapters.test.ts`, `hmrc-submit-wiring.test.ts`, `hmrc-rti-fps.test.ts`.

#### `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` + Open Banking
- OFF. Needs flag AND aggregator creds (`BANKING_CLIENT_ID/SECRET`) AND a bound `BANKING_PROVIDER` (`truelayer|plaid|nordigen`) AND `INTEGRATION_TOKEN_ENCRYPTION_KEY`. **External action:** aggregator account + **FCA AISP authorisation (legal gate)**. Cost: new-recurring. Coverage: `bank-connections.test.ts`, `bank-sync.test.ts`, `bank-match-invoice-org-scope.test.ts`.

#### `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` + GPS fleet feed
- OFF ⇒ routes 503. Needs flag AND `TELEMATICS_CLIENT_ID/SECRET` AND `TELEMATICS_PROVIDER` (`samsara|verizon_connect`) AND the encryption key. **External action:** telematics provider account + **CEO provider-choice decision**. Cost: new-recurring. Coverage: `telematics-connections.test.ts`, `telematics-sync.test.ts`.

#### `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` + Stripe Connect
- Tenant→customer "Pay now". OFF ⇒ pay-now action + `/api/webhooks/stripe-invoice` refuse-before-fetch. Needs flag AND `STRIPE_CONNECT_SECRET_KEY` + `STRIPE_INVOICE_WEBHOOK_SECRET` AND a per-tenant `org_payment_connections.status='connected'`. **Completely separate** from SaaS billing — SaaS being live does NOT make this live. **External action:** Stripe Connect platform setup + per-tenant onboarding. Cost: new (Stripe fees). Coverage: `portal-invoice-payments.test.ts`, `portal-invoice-ownership-authority.test.ts`, `stripe-connect-onboarding.test.ts`.

#### `NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING`
- OFF (`selfServe=false` confirmed in prod). Needs flag AND `STRIPE_SECRET_KEY` (**already present** — same key as SaaS checkout). The remaining gate is **plan PRICES configured in Stripe** (CEO config, resolved by `lookup_key`). **External action:** create the plan prices in Stripe, then flip the flag. Cost: free (reuses billing). Coverage: `self-serve-billing.test.ts`.

#### `NEXT_PUBLIC_FEATURE_MERCHANTS` + builders' merchants
- OFF. Per-merchant (not one aggregator): `MERCHANT_<P>_API_KEY` + `_ENDPOINT` for JP Corry / Jewson / Travis Perkins / Haldane Fisher, + flag + encryption key. **External action:** a **trade-account integration CONTRACT** per merchant (endpoint provisioned per contract; no public host). SSRF-validated. Cost: commercial. Coverage: `merchant-connections.test.ts`, `merchant-writers.test.ts`.

#### `FEATURE_CALENDAR_CONNECT` + Google Calendar / MS Graph
- OFF ⇒ connect/callback short-circuit. Needs flag AND `GOOGLE_CALENDAR_CLIENT_ID/SECRET` and/or `MS_GRAPH_CLIENT_ID/SECRET` + encryption key. The MS client is a **separate Graph Calendars app** from auth SSO. **External action:** register the OAuth client(s). Cost: free (API quotas). Coverage: `calendar-connections.test.ts`, `calendar-pull.test.ts`, `calendar-sync-cron.test.ts`.

#### `FEATURE_ACCOUNTING_CONNECT` + Xero / QuickBooks / Sage
- OFF ⇒ substrate refuses-before-fetch; CSV export/import works today. Needs flag AND a provider's client creds (`XERO_*`/`QBO_*`/`SAGE_*`) + encryption key. One client-credential set serves every tenant (per-org tokens in `accounting_connections`). **External action:** register the OAuth app(s). Cost: free/low. Coverage: `accounting-connections.test.ts`, `accounting-export.test.ts`, `accounting-import.test.ts`, `accounting-sage.test.ts`, `token-encryption-seam.test.ts`.

#### `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO`
- "Continue with Microsoft" on /login. OFF ⇒ button does not render. Needs flag AND an **external** Supabase Azure provider configured with an Azure AD app registration (client id/secret + redirect URI). **External action:** register the Azure AD app + configure the Supabase provider. Cost: free. Coverage: `auth-completion.test.ts`.

#### `NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING`
- "Link account" controls. OFF. Needs flag AND Supabase **"Manual Linking"** enabled in the dashboard (a config toggle, **not a credential**). **External action:** enable Manual Linking in Supabase Auth settings, then flip the flag so the button never dead-ends. Cost: free. Coverage: `auth-completion.test.ts`.

#### `FEATURE_ENTERPRISE_SSO` (server-only, SAML/OIDC + SCIM)
- OFF ⇒ SSO routes 404, SCIM 401/403, nothing auto-provisions. Needs flag AND per-org config row enabled AND a real customer IdP's metadata (SAML entityID+SSO URL+x509 cert, or OIDC issuer+client creds) or a minted SCIM bearer token. SCIM maps to EXISTING memberships only (deny-unmatched, never auto-create). **External action:** per-tenant IdP onboarding. Cost: enterprise/commercial. Coverage: `enterprise-sso-dark.test.ts`.

#### Weather intelligence
- `available=false` (unavailable in prod). `open-meteo` adapter EXISTS (built-dark); `metoffice` adapter does not. Needs `WEATHER_PROVIDER="open-meteo"` + `OPEN_METEO_API_KEY`. **External action:** take the **commercial-licence decision** (Open-Meteo keyless tier is non-commercial only) and buy the commercial key. Cost: new-recurring. Coverage: `weather-intelligence.test.ts`, `weather-consumers.test.ts`.

#### Companies House sourcing (HQ research / lead sourcing)
- Dark. Needs `COMPANIES_HOUSE_API_KEY`; absent ⇒ probes record "not configured" and fetch nothing. **External action:** register for a (free) Companies House API key. Cost: free. Coverage: `companies-house-sourcing.test.ts`. (Note: NI/BT postcode data needs a separate LPS licence per ops memory.)

---

## AI safety verification (required confirmations)

Confirmed from source — the governor enforces every named guarantee, and **no autonomous customer-facing AI execution is on**:

- **Approval gates preserved.** `lib/ai/safety.ts#AI_FORBIDDEN_ACTIONS` forbids creating/modifying invoices/quotes/jobs, sending emails, deleting records, changing customer-visible data, impersonation — without explicit operator approval. Quote-writer is draft-first/human-reviewed; portal live-chat auto-reply is **HELD by CEO** (`CHAT_AUTO_REPLY_GENERATIVE` build constant keeps `maybeGenerateChatReply` returning null) and always posts a deterministic, `auto_generated=true`-labelled ack. Autonomous apply is triple-locked OFF.
- **Tenant isolation.** Per-org attribution + RLS; HQ-internal spend billed to `CREWFLOW_INTERNAL_ORG_ID` (fails closed to null, FK-checked). Governor reserve runs under a per-org advisory lock.
- **Usage limits / ceiling.** Hard **£100/org/month** ceiling (`AI_MONTHLY_CEILING_PENCE`, a code constant, not an env var), override bounded to a £500 hard-max in both app and SQL. `evaluateBudget` blocks at exactly 100% (inclusive); a non-positive ceiling means "no AI", not "unlimited".
- **Atomic reservation.** `ai_reserve_invocation` reserves worst-case claim BEFORE the call under the advisory lock; `MIN_RESERVATION_PENCE=1` floor stops N concurrent unpriced calls slipping the gate; 10-min TTL self-heals crashed claims.
- **Audit logs.** Every governed call writes `ai_invocations` (feature, task_class, hashed fingerprint — content never stored). The feature registry is the closed set; `invokeWithGovernor` rejects unregistered keys and refuses a call whose declared task_class disagrees with the registry (no self-promotion to a dearer tier).
- **Fail-closed.** `deterministic` task class routes to no model (refused loudly; DB CHECK omits it). Dark tiers short-circuit before any provider and run the deterministic fallback with **zero DB reads**. Reserve-path read failures fail closed.
- **Kill switches.** Per-tier bindings in `registry.ts` are the arming switch (reviewed diff, not a deploy dashboard); `COMMS_*_PROVIDER=none/off/disabled` and `TRANSCRIPTION_API_KEY` are independent kill switches; `isGovernorActivated()` gates both provider doors (text + vision).
- **Cost controls.** Fixed pessimistic USD→GBP rate (no network in the refusal path); sub-penny calls round UP; failed calls floor at 1p so a retry storm is visible to the ceiling.
- **Ungoverned paths = 0.** `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS = 0`, derived from source text and pinned by `__tests__/security/ai-governance-closure.test.ts`; `isAiConfigured()` has zero callers (pinned). A bare vendor key can therefore reach no model at any door.

---

## Flagged inconsistencies with intended-dark

1. **WhatsApp outbound is ON in production** (`whatsapp=true` ⇒ `outboundReady`). This is the one gated customer-messaging channel whose BOTH switches (flag + Meta credentials) are set live, against an otherwise-dark posture. It appears to be the **deliberate** WhatsApp activation attempt (not an env leak), is narrowed by the founder test-recipient allowlist, and is **not production-proven for real inbound** (Meta sends 0 POSTs; app-level verify-token drift outstanding). **Recommend:** confirm the activation was intended for this stage, confirm the test-recipient allowlist is set in prod env, and either resolve the Meta-side inbound block or re-dark the channel until it is proven.
2. No other gated flag appears ON. `email=true` (core, expected), `billing configured+webhook / selfServe=false` (expected: SaaS live, self-serve dark), `sms=false`, `weather unavailable`, `analytics OFF`, `monitoring on` are all consistent with the documented posture.
3. **Observability note (not in the required flag list):** `monitoring.enabled` relies on `SENTRY_DSN`; analytics (client + server) is OFF. If prod expects error capture, `SENTRY_DSN` is the missing switch — worth confirming given the historical 5-day-402 incident class.
