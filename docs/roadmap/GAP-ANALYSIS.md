# CrewFlow — Roadmap Completion Gap Analysis

**Generated:** 2026-08-03 · **Prod `main`:** `b45226fa` · **Migration tip:** `20261108` · **Providers:** 100% dark (email/Resend only).

This is the canonical residual after the Roadmap Completion Programme (Waves 1–12). The rule of the programme: **build every engineering task that can be completed without an external credential, a CEO/product decision, real customer data, or legal approval** — and build every *gated* feature's full substrate DARK so activation is a configuration change, not an engineering project.

## ✅ Category 1 — ENGINEERING (buildable now): **EMPTY**

There is no remaining feature that can be built to production without one of the external inputs below. The census-identified buildable-now queue was shipped in full across Waves 6–12 (24 trains, migrations `20261096`–`20261108`), each adversarial-gated and production-verified. Highlights: full OAuth substrates (accounting, calendar, HMRC, banking, telematics) built dark; token-encryption seam; voice-telephony routing substrate; automation engine completion; the HQ AI-workforce (13 boarded) + decision centre + approval console + workflow-saga + apply-on-approval + cadence-clock; weather consumers; offline vertical-fill + field forms; van stock; stock reorder; CIS export; EOT notice; GDPR export; governor fail-closed.

**The genuine multi-session real builds below are NOT config-gated — they are net-new product surface** and were deliberately not faked. They are the only items that would grow Category 1 again, and each needs a CEO strategy call first (noted in Cat 3):
- **Native mobile apps** (iOS/Android) — current strategy is PWA; needs a PWA-wrapper-vs-native decision, then a real multi-session build.
- **i18n / multi-country / multi-jurisdiction tax** — hard-coded en-GB + UK tax today; a real programme (string extraction, locale routing, multi-jurisdiction tax model).
- **Marketplace** — bible-gated behind core; not started by directive.
- **Voice LIVE audio layer** — the dark routing/webhook/state substrate + governed AI-turn seam are built (`20261098`); the real-time STT/TTS/barge-in turn loop over live audio is genuine engineering **and** provider-gated.
- **Design AI / Documentation AI boards** — have no deterministic data source; require first building a new capability (a doc-freshness index / design-artefact records) before a board is honest. Building over absent data is forbidden by the honest-label rule.

## Category 2 — PROVIDER / CREDENTIAL (substrate built dark; activation = set secret + flag)

Every item here is a flip: the engineering is done and verified dark.
| Capability | What to supply |
|---|---|
| Accounting (Xero/QuickBooks) OAuth + export | `XERO_CLIENT_ID/SECRET`, `QBO_CLIENT_ID/SECRET`, `FEATURE_ACCOUNTING_CONNECT`, `INTEGRATION_TOKEN_ENCRYPTION_KEY` |
| Calendar (Google/Microsoft) OAuth | Google + MS Graph client creds, `FEATURE_CALENDAR_CONNECT`, encryption key |
| HMRC MTD (VAT/CIS300) OAuth | `HMRC_CLIENT_ID/SECRET`, flag, encryption key — **live submission also needs Cat 4 (recognition)** |
| Banking / open-banking feed | `BANKING_CLIENT_ID/SECRET`, provider, flag — **live connection also needs Cat 4 (FCA)** |
| GPS/telematics | `TELEMATICS_CLIENT_ID/SECRET`, flag + **provider choice (Cat 3)** |
| Voice telephony (routing substrate) | `TWILIO_*` / `VAPI_*` voice creds, `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` |
| SMS / WhatsApp / missed-call text-back | `TWILIO_ACCOUNT_SID/AUTH_TOKEN/SMS_FROM`; `WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID` + flag |
| All generative AI (quote-writer, receptionist AI-turn, embeddings/semantic recall, OCR receipts, HQ dark narratives, saga AI-decomposition) | provider key (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) — **also needs Cat 3 (tier binding)** |
| Observability | `SENTRY_DSN`, PostHog/BetterStack tokens |
| Token encryption at rest | `INTEGRATION_TOKEN_ENCRYPTION_KEY` (KMS/secret — **also a Cat 3 KMS decision**) |

## Category 3 — CEO / PRODUCT DECISION

| Decision | Effect |
|---|---|
| **Bind the AI cost tier** (`TIER_MODEL` + envelope) | Unblocks EVERY generative-AI feature at once; the governor/reservation/ratchet infra is complete and fail-closed. A cost decision, not engineering. |
| **Stripe customer "Pay now": Connect vs direct** | The ONE not-yet-built feature gated on a decision that shapes its schema — decide first, then build. |
| **Executor live cut-over (ADR 0011 R3+)** | Authority to bind a real apply-authority + per-employee live cut-over. Shadow recording + apply-on-approval runtime are built dark (default-off + unbound authority). |
| Stock **D1 valuation/COGS** policy | Operational-only vs reclassify-split vs real inventory accounting (first balance-sheet position). |
| **Quote-acceptance-by-staff** policy | "May staff record acceptances?" → then a ~1-trigger build. |
| **Portal appointments/booking** model | Self-serve booking scope → then build. |
| **MFA enforcement** / **Microsoft SSO** / **account-linking** activation | Policy + Supabase/Azure config (wiring built). |
| **Open API** / **outbound webhooks** activation | Decision to expose tenant data / which event verbs → flip flag. |
| **Maintenance-reminder** activation | Auto-emailing customers → flag (email provider already live). |
| **Telematics / banking provider** choice | Which aggregator → then Cat 2 creds. |
| **PITR / backup tier** | Supabase project/billing setting. |
| **Native mobile / i18n / marketplace** strategy | Green-lights the Cat 1 multi-session builds. |
| **Design/Documentation data-capability** | Decision to build a doc-index/design-artefact source, then those HQ boards become buildable. |

## Category 4 — LEGAL / COMPLIANCE

| Item | Gate |
|---|---|
| **HMRC software-vendor recognition** | Mandatory before ANY real VAT/CIS300 submission (the HMRC substrate is structurally `prepared\|held`-only until then). |
| **FCA / open-banking AISP authorisation** | Before any live bank connection. |
| **Voice call-recording consent/regulation** | Before enabling call recording. |
| **GDPR erasure / org-teardown storage cleanup** | The destructive half (export half is built); a legal/policy decision on retention + storage-orphan handling. |
| **CIS300 actual filing** | Recognition + filing agreement (export/statement delivery is built). |

---

**Bottom line:** The roadmap's engineering is complete to the boundary of what can be built without external inputs. Everything that remains is a credential to set, a decision to make, a law to satisfy, or a genuinely new multi-session product surface awaiting a strategy call — never an unbuilt piece of the substrate. Activation of any gated feature is, by construction, a configuration change.
