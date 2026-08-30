# Production Activation Matrix

**Programme:** Final Live Activation · **Baseline:** main `d2638d56` = prod `d2638d5` · parity 387/387 tip `20261227` · **Date:** 2026-08-30

Every gated capability in the platform, classified L1–L5:
**L1** safe to activate autonomously · **L2** needs a CEO credential/config · **L3** creates/increases cost · **L4** legal/compliance/provider approval · **L5** explicit CEO risk approval.
Target end-states: **LIVE** · **LIVE — APPROVAL GATED** · **LIVE — CUSTOMER CONFIGURABLE** · **EXTERNAL ACTIVATION BLOCKED** (documented). Nothing stays silently BUILT+DARK.

The house invariant (verified in code): `activated` can never be true without the build-time capability — a stray credential can never manufacture a capability; every dark path refuses **before** any network call.

## Already LIVE in production (verified this audit)

| Capability | Gate | State |
|---|---|---|
| Outbound email (Resend) | `RESEND_API_KEY` (set) — no flag | **LIVE** — auth emails, invoice/quote sends, 6 crons, /api/demo. Kill: unset key / `COMMS_EMAIL_PROVIDER=none` |
| Stripe SaaS checkout + `/api/webhooks/stripe` | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (set) — no flag | **LIVE — APPROVAL GATED** (super-admin click mints real checkout; £1,000 setup / £500-mo). Webhook signature-verified |
| Sentry monitoring | `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` (set) | **LIVE** |
| `/api/v1/me` substrate probe | none | LIVE (reads no tenant data; the rest of v1 is flag-gated) |
| HQ research web-fetch | none (SSRF-guarded, cron/super-admin only) | LIVE (fetch+store only; interpreting LLM is dark) |
| Maintenance kill switch | `MAINTENANCE_MODE` unset (inert) · `MAINTENANCE_BYPASS` pre-staged | Correct runbook posture |

## L1 — activated autonomously this programme

| # | Capability | Roadmap | Flag(s) | 2nd switch | Result state | E2E | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | Enterprise SSO (SAML/OIDC) + SCIM 2.0 | (R161-adj) | `FEATURE_ENTERPRISE_SSO=true` | per-org config row `enabled=true` + IdP metadata / minted SCIM token — no auto-provision path exists | **LIVE — CUSTOMER CONFIGURABLE** | /settings/sso reachable + SSO route no longer 404s / SCIM 401s (not 404) | unset flag |
| 2 | MFA enforcement | (R161-adj) | `FEATURE_MFA_ENFORCEMENT=true` | per-org `organizations.require_mfa` (all false today ⇒ inert) | **LIVE — CUSTOMER CONFIGURABLE** | security settings shows enforcement control; no session behaviour change while orgs opted out | unset flag |
| 3 | Outbound webhooks | R152 | `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS=true` | per-org endpoint must pass signed-ping to reach `active`; SSRF-guarded, HMAC-signed, circuit-broken | **LIVE — CUSTOMER CONFIGURABLE** | /settings/webhooks live; dispatch cron 200s with zero endpoints | unset flag |
| 4 | Web push (VAPID) | (R029-adj) | `VAPID_PUBLIC_KEY`+`VAPID_PRIVATE_KEY` (self-generated P-256 pair — no vendor, no cost; set directly into Vercel env, never echoed) | user opt-in per browser | **LIVE** | push-drain cron healthy; settings push toggle offers subscription | unset keys |

## CEO QUEUE — L1-recommended (your one-word decision; no credential needed)

| # | Capability | Flag | Why queued not auto | Recommendation |
|---|---|---|---|---|
| Q1 | Public API v1 + /developers + SDKs | `FEATURE_PUBLIC_API_JOBS=true` | Exposes a key-authed tenant-data surface (guarded, rate-limited, 404-while-dark, tested) — a deliberate posture change | **ENABLE** |
| Q2 | Maintenance-reminder emails | `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS=true` | Starts autonomous outbound email to real customers (cron; Resend already live; both surfaces read one predicate) | **ENABLE** |
| Q3 | GDPR erasure (real) | `FEATURE_GDPR_ERASURE=true` | Irreversible destruction — but triple-locked (flag + org OWNER + slug token) and Art.17 arguably requires it live | **ENABLE** |
| Q4 | Retention purge (real) | `FEATURE_RETENTION_PURGE=true` | Flips org-enabled policies from dry-run to real deletion (statutory exclusions DB-enforced) | **ENABLE** (no org has policies enabled yet ⇒ inert today) |
| Q5 | Resend delivery events | `NEXT_PUBLIC_FEATURE_RESEND_EVENTS` + `RESEND_WEBHOOK_SECRET` | Needs a webhook secret from YOUR Resend dashboard (L2, free, ingest-only; starts honest bounce-suppression) | **ENABLE** — steps below when you say go |

## L2 — needs a CEO credential/config (no/negligible cost)

| Capability | Roadmap | What you must create | Then |
|---|---|---|---|
| GitHub telemetry (CTO PR review, QA CI signal, devops) | R090, R092 | Fine-grained PAT, **read-only** (Contents+PRs+Actions: read) on `crewflow1/web` → `GITHUB_TOKEN`, `GITHUB_REPO` | read-only; merge/deploy tools stay dormant (ADR-0011) |
| Companies House lead sourcing | R088 | Free CH developer account → live API key → `COMPANIES_HOUSE_API_KEY` | weekly sourcing leg lights; DRAFT prospects only |
| Vercel deploy telemetry | (R090-adj) | Scoped read token → `VERCEL_TOKEN` (+project/team ids) | read-only |
| Inbound email ingestion | R034-part | Provider-side route (e.g. Resend Inbound → webhook) + self-generated `INBOUND_EMAIL_WEBHOOK_SECRET` + flag | leads from emails; zero outbound |
| Microsoft SSO login / account linking | (R161-adj) | Supabase Azure provider config (+ Manual Linking toggle) | then flags |
| Accounting connect (Xero/QBO/Sage) | (unatomised) | Developer apps at each vendor → client id/secret pairs + `INTEGRATION_TOKEN_ENCRYPTION_KEY` (self-generated) + `FEATURE_ACCOUNTING_CONNECT` | per-tenant OAuth; writes real ledger entries — staged rollout advised |
| Calendar sync (Google/MS Graph) | (unatomised) | OAuth apps → creds + `FEATURE_CALENDAR_CONNECT` + token key as above | per-user consent |

## L3 — creates or increases cost (CEO billing approval)

| Capability | Roadmap | Cost shape | Notes |
|---|---|---|---|
| **Generative AI estate** (~13 surfaces: quote writer, OCR, receptionist drafting, HQ narratives/seams, insights…) | R039 R050 R089 R091 R093 R101 (+R034) | Per-token usage; £100/org/month fail-closed ceiling with atomic pre-reservation | `ANTHROPIC_API_KEY` already in prod but reaches NOTHING (verified: 0 ungoverned entry points, security-pinned). Activation = **reviewed code diff** binding `TIER_MODEL` tiers (by design) + your spend approval. Transcription additionally needs a transport diff |
| SMS + missed-call textback (Twilio) | R034-part | Number rental + per-message | UK number, sender registration; missed-call textback is the one autonomous-send path — its own flag |
| WhatsApp (Meta Cloud API) | R034 R036 | Per-conversation | Meta business verification + number; draft-first preserved |
| Voice inbound + AI turn (Twilio/Vapi) | R101 | Per-minute + tier usage | Two independent gates (voice flag+creds; mid tier) |
| Weather (Open-Meteo commercial) | R045 | Commercial subscription | Deliberately no free-tier auto-select (licence); `WEATHER_PROVIDER=open-meteo` + key |
| PostHog analytics | R223 | Free tier → usage | Consent-gated client-side; your account + key |
| Self-serve billing | (unatomised) | Stripe fees; tenants self-modify recurring charges | Also **flips entitlement enforcement from allow-all to enforcing** (side effect, documented) — stage carefully |
| Stripe Connect portal payments | R061 | Platform/Connect fees; KYC liability | Separate `STRIPE_CONNECT_SECRET_KEY` + invoice webhook secret + per-org onboarding |
| PITR backups | R141 | Paid Supabase add-on | Account-owner dashboard toggle; RPO ~24h→~2min |

## L4 — legal/compliance/provider approval → EXTERNAL ACTIVATION BLOCKED

| Capability | Blocker (documentary) |
|---|---|
| HMRC MTD submit (VAT / CIS300 / FPS / CIS-verify) | **HMRC vendor recognition** (lib/env.ts:377-383; fraud-header conformance part of the gate). Creds+flag only ever enable CONNECT, never SUBMIT — both module and orchestrator refuse per flow. Internal prepare/hold works today |
| Open Banking (TrueLayer/Plaid/Nordigen) | **FCA AISP authorisation** (env.ts:437-448) — AND the adapter body is `pending.ts` (code deliberately incomplete until the legal gate opens) |
| Builders' merchants cXML (Jewson/TP/JP Corry/Haldane Fisher) | **Trade-account integration contracts** — endpoints are provisioned per contract; no public API exists |
| Telematics (Samsara/Verizon) | Provider account/contract — AND adapter body is `pending.ts` |
| Marketplace | Partner onboarding/commercial agreements (flag alone yields an empty catalogue — recommend dark until partners exist) |
| External penetration test | Firm engagement (scope + rules-of-engagement already written: docs/engineering/EXTERNAL-PROOF-READINESS.md §3) |
| Ad-campaign analytics (Marketing AI sub-part) | A real ad account must exist; no credential defined by construction |
| Competitor monitoring (Product AI sub-part) | External data source/licence; no scraping by doctrine |

## L5 — explicit CEO risk approval (safety architecture preserved)

| Capability | State | Note |
|---|---|---|
| HQ autonomous apply / executor (merge/deploy authority) | 4 kill switches all off (`FEATURE_HQ_AUTONOMOUS_APPLY`, `CREWFLOW_EXECUTOR_APPLY`, `CREWFLOW_HQ_APPLY_ON_APPROVAL`, `CREWFLOW_EXECUTOR_SHADOW` — literal `"on"` required) | **Stays dark per ADR-0011**; the bound production authority is deliberately unbuilt. NOT upgraded by this programme |
| Booking execution arming | `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` | Bundle with comms activation; even armed, max outcome is `requires_human_review` |

## CEO dashboard actions (not env)

PITR toggle (L3) · GitHub branch-protection required checks · Supabase Azure provider (for MS-SSO) · Stripe price `lookup_key`s (for self-serve billing).

## Activation-truth defects found (code fixes, batched into one reviewed PR)

1. **False control panel**: `/admin/settings` renders 3 toggles (`enable_ai_coo`, `enable_whatsapp_outbound`, `enable_self_service_billing`) persisted to JSONB and **read by nothing** → remove.
2. Four autonomous-apply kill switches + `SAGE_CLIENT_ID/SECRET/API_BASE_URL` undeclared in `lib/env.ts` schema → declare.
3. `ops-snapshot` TRACKED_ENV misses `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_DSN`, `CREWFLOW_SUPERADMIN_EMAILS`, `MAINTENANCE_MODE/BYPASS` → add presence rows.
4. Dead declarations: `INNGEST_EVENT_KEY/SIGNING_KEY`, `BETTERSTACK_*`, `INTERNAL_API_SECRET`, `POSTHOG_PERSONAL_API_KEY` → remove (`MET_OFFICE_API_KEY` kept: documented reserved seam; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` kept: documented reserve).
5. Honesty note (no code change): impersonation atom R235's capability is an audit-only stub by recorded design; banking/telematics adapters incomplete pending their L4 gates — both stated here rather than discovered later.

*(Final states are stamped into this file as activations complete.)*
