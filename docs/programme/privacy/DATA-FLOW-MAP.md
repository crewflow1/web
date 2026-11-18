# CrewFlow — service-by-service personal-data flow map (2026-11-16)

One block per third party that code on `origin/main` (`d24295e8`) **actually integrates**, plus the pending-PR
changes that alter a flow. It supersedes the summary table in `PROVIDER-REGISTER.md` for *current* state; the
register keeps the 2026-11-13 evidence detail. Engineering material, **not legal advice**; ⚖ = needs an adviser,
F-n = founder fact (`FOUNDER-FACTS-NEEDED.md`).

**How "enabled in prod" was established (read-only, 2026-11-16):** `GET https://crewflow.uk/api/health` →
`sha d24295e, comms.email=true, sms=false, whatsapp=true, monitoring.enabled=true, billing.configured=true,
webhookConfigured=true, selfServe=false, analytics.clientConfigured=true, serverEnabled=false,
weather.available=false`; response headers of `/login` (`x-vercel-id: lhr1::dub1::…`, the CSP below); the login
HTML ("Continue with Google" only). Server-side flags and provider dashboards cannot be read from outside: where
nothing public proves a state, the cell says so. Production row counts quoted are the 2026-11-13 aggregates
(`prod-row-counts.json`); no production database query was made for this document.

**Browser-side allow-list (live CSP on `/login`, 2026-11-16):** `connect-src` self, `*.supabase.co` (+wss),
`eu.i.posthog.com`, `eu-assets.i.posthog.com`, Sentry ingest (`*.ingest.de.sentry.io` is the DSN host; US/global
hosts are also allowed), `vitals.vercel-insights.com` (unused), `vercel.live`, `*.pusher.com`; `script-src` self +
`eu-assets.i.posthog.com` + `vercel.live`; `form-action` self + `checkout.stripe.com` + `billing.stripe.com`;
`img-src` adds `*.supabase.co`, `eu.i.posthog.com`. No Supabase client runs in the browser (no
`createBrowserClient` anywhere): the browser only fetches signed file URLs from Supabase Storage.

## Summary

| # | Service | Prod state | Browser / server | Where processed | Before any cookie choice |
|---|---|---|---|---|---|
| 1 | Supabase (DB, Auth, Storage) | ACTIVE | server; browser fetches signed file URLs | Ireland (eu-west-1) | yes — necessary |
| 2 | Vercel (hosting, functions, logs) | ACTIVE | both (it serves every request) | functions Dublin `dub1`, edge London | yes — necessary |
| 3 | Stripe (CrewFlow's SaaS billing) | ACTIVE, live, self-serve OFF | server; browser only on Stripe Checkout / Billing pages | ⚖ F-9 | no Stripe script on CrewFlow pages |
| 4 | Resend (email + Auth SMTP) | ACTIVE | server | F-9 (account region unknown) | n/a (email) |
| 5 | Anthropic (Claude API) | ACTIVE (tiers armed) | server | USA | n/a |
| 6 | OpenAI (embeddings, STT) | ACTIVE narrow (HQ memory); tenant search + STT DORMANT | server | USA | n/a |
| 7 | Sentry | ACTIVE | both | Germany (DSN `ingest.de`) | **errors: yes**; performance: yes on main, consent-gated by #1092 |
| 8 | PostHog | ACTIVE after Accept (browser); server sink DORMANT | browser | EU | **no** |
| 9 | Google (OAuth sign-in) | ACTIVE | browser redirect | Google (global) | only on click |
| 10 | Backblaze B2 (off-platform backup) | ACTIVE (weekly, operator-run) | operator machine → B2 | F-9 (bucket region) | n/a |
| 11 | Vercel KV / Upstash | reported ACTIVE (2026-11-10 register) | server | F-9 | n/a |
| 12 | Meta WhatsApp Cloud API | **ARMED** (`whatsapp=true`), no traffic | server | Meta (USA/global) | n/a |
| 13 | Companies House API | ACTIVE credential (HQ only) | server | UK | n/a |
| 14 | GitHub | CI + uptime monitor only | — | — | n/a |
| 15 | Twilio (SMS/voice), Vapi | DORMANT (`sms=false`) | server | USA | n/a |
| 16 | Microsoft (Azure AD sign-in, Graph calendar) | DORMANT | browser redirect / server | — | n/a |
| 17 | Accounting (Xero, QuickBooks, Sage), banking (Plaid, GoCardless, TrueLayer), HMRC, telematics (Samsara, Verizon Connect — US endpoint), merchants, Open-Meteo/Met Office, Web Push vendors, outbound webhooks | DORMANT | server | various | n/a |

---

## 1. Supabase — database, Auth, Storage
- **Purpose:** system of record for every tenant and CrewFlow record; sign-in (email+password, magic link, Google OAuth); file storage (13 private buckets, signed URLs).
- **Data categories:** everything in `data-register.csv` (1,097 personal-data columns across 293 tables/views); Auth identities, password hashes, MFA factors, sessions with **raw IP + user agent**; uploaded files (photos may carry EXIF location — `DATA-MINIMISATION.md` M-6).
- **Browser vs server:** all queries server-side (server components, actions, route handlers; service role only on the server). Browser contacts `*.supabase.co` only to load signed file URLs; Cloudflare in front of Storage sets a `__cf_bm` security cookie (consent workstream register).
- **Prod state:** ACTIVE — `/api/health db=ok`.
- **Region / transfer:** Ireland (`aws-0-eu-west-1`, VERIFIED 2026-11-13 from the linked pooler host). Supabase Inc. is a US company: support/ops access is a transfer question ⚖.
- **Terms to verify (F-9):** DPA accepted; sub-processor list (AWS); transfer mechanism for US support access; Auth SMTP points at Resend (F-17); session lifetime (F-17).
- **Retention / deletion:** live rows until deleted by the tenant or a deletion flow (#1091, dark); daily managed backups ~7 days (F-16); PITR off. Auth audit table empty in prod (G-20).
- **Pre-consent:** yes — strictly necessary to provide the service.
- **AI training:** not an AI provider; dashboard AI assistant not used on customer data — verify account setting.

## 2. Vercel — hosting, serverless functions, logs
- **Purpose:** serves every page, runs every server action / route / cron.
- **Data categories:** all request and response content in transit; request logs (IP, URL incl. query string, user agent); function logs (`console.*` output). Auth URLs no longer carry the email address once `privacy/data-minimisation` ships (M-7/G-10 fixed; today's main still does); bearer tokens in `/q/…`, `/customer-portal/…`, `/worker-portal/…` paths.
- **Browser vs server:** both.
- **Prod state:** ACTIVE.
- **Region / transfer:** functions **`dub1` (Dublin)**, edge `lhr1` — VERIFIED `x-vercel-id: lhr1::dub1::…` on 2026-11-16 (`vercel.json` `regions: ["dub1"]`, commit `e3773aa1`). The 2026-11-13 US processing (G-2) is resolved. Vercel Inc. is US: log storage location / support access ⚖.
- **Terms to verify:** DPA; log retention on the plan (F-16); transfer mechanism.
- **Retention / deletion:** logs age out on the plan's retention; cannot be edited (`DELETION-DESIGN.md` §6).
- **Pre-consent:** yes — necessary. Vercel Analytics / Speed Insights are **not** installed.
- **AI training:** not expected; verify account data-use settings.

## 3. Stripe — CrewFlow's own SaaS billing
- **Purpose:** charge the setup fee and monthly subscription to tenant companies.
- **Data categories:** organisation name + email + internal org id on the Stripe customer; prospect email on a founder-issued setup-fee Checkout link; card details go **directly** to Stripe (never touch CrewFlow); webhooks stored in `billing_events.payload`.
- **Browser vs server:** server SDK; the browser only visits `checkout.stripe.com` / `billing.stripe.com` (CSP `form-action`). No Stripe.js on CrewFlow pages.
- **Prod state:** ACTIVE live mode, `selfServe=false` (founder provisions customers). **Pending #1090:** owner self-cancel from Settings → Billing schedules `cancel_at_period_end` (no proration, no automatic refund), records `subscription_cancellations` (PENDING in the register), raises an HQ refund **review** only where a paid period is cut short. Portal card payments (Connect) DORMANT.
- **Region / transfer:** contracting Stripe entity and data location F-9 ⚖.
- **Terms to verify:** Stripe's DPA; Stripe acts as an independent controller for its own fraud/compliance purposes ⚖.
- **Retention / deletion:** CrewFlow does not delete Stripe customers (invoices are CrewFlow's 6-year accounting records — #1091 L2 ⚖); local copies: `billing_invoices`, `billing_events` (no age rule, G-16), `privacy_retained_billing_records` after a company deletion (#1091).
- **Pre-consent:** none — Stripe is reached only when someone opens a payment link.
- **AI training:** Stripe uses payment data in its own fraud models (Radar) — disclose ⚖; verify.

## 4. Resend — transactional email and Supabase Auth SMTP
- **Purpose:** quotes, invoices, statements, reminders, review requests, staff notifications/digests/invites, demo confirmations, HQ notifications; magic-link and password-reset email.
- **Data categories:** recipient address, subject, full HTML/text body, PDF attachments; delivery events back via webhook into `comm_events` (recipient + payload).
- **Browser vs server:** server only (`lib/email/send.ts`).
- **Prod state:** ACTIVE — `comms.email=true`. Inbound email DORMANT.
- **Region / transfer:** account/domain region unknown — F-9.
- **Terms to verify:** DPA; message-log retention on the plan (F-16).
- **Retention / deletion:** no API deletes a sent email; logs expire on plan retention. Local queue rows deleted 90 days after send; `comm_events` never purged (G-16).
- **Pre-consent:** n/a.
- **AI training:** not an AI provider; verify.

## 5. Anthropic — Claude API
- **Purpose:** governed AI features: lead summary, quote-writer draft (closed disclosure contract, `lib/ai/quote-context.ts`), site-manager answers, insights narratives, receipt extraction (vision), import OCR (vision), document form-autofill (vision), HQ narratives/research. Receptionist/auto-reply features DORMANT with their channels.
- **Data categories:** prompt content — lead/enquiry text incl. contact name, business aggregates, free text from diaries/snags, **whole uploaded receipts, import files (customer/staff lists) and documents (CVs, V5C logbooks, insurance certificates)**. CrewFlow keeps only a hash + token/cost ledger (`ai_invocations`), never the prompt.
- **Browser vs server:** server only.
- **Prod state:** ACTIVE (tiers armed; real spend in the ledger, 580 calls at 2026-11-13). Spend governed in-app: per-org monthly ceiling (default £100) reserved atomically before each call (`docs/ai-cost-governor.md`); **pending (AI workstream):** a CrewFlow-wide monthly ceiling (`ai_platform_budget`, migration 20261358). There is **no per-organisation "AI off" switch** (G-13).
- **Region / transfer:** USA — restricted transfer ⚖ (F-9/F-10).
- **Terms to verify (F-10):** the commercial terms actually accepted; request/response retention period; zero-data-retention availability; transfer mechanism.
- **Retention / deletion:** no API to delete individual requests; provider retention is contractual — record it in the sub-processor list (#1091 L13).
- **Pre-consent:** n/a.
- **AI training:** Anthropic's commercial API terms are understood not to use API inputs/outputs for model training by default — **verify against the accepted terms before stating it publicly** (F-10).

## 6. OpenAI — embeddings, transcription
- **Purpose:** embeddings of CrewFlow's internal HQ memory (ACTIVE); tenant semantic search embeddings (DORMANT — DB flag `tenant_search_embed_enabled`, 0 of 503 embedded at 2026-11-13); voice-note transcription (DORMANT — no capture surface, `microphone=()`).
- **Data categories:** HQ memory text (may name a customer organisation); if enabled, denormalised tenant record text (money, secrets and NI numbers excluded by `lib/search/semantic/mappers.ts`).
- **Browser vs server:** server only.
- **Region / transfer:** USA ⚖. **Terms to verify:** as Anthropic (F-10).
- **Retention / deletion:** provider-contractual; local `hq_memories` lifecycle cron.
- **Pre-consent:** n/a. **AI training:** API data understood not to train models by default — verify (F-10).

## 7. Sentry — error and performance monitoring
- **Purpose:** error reports (server + browser) and sampled performance traces (10% in production).
- **Data categories:** stack traces, URLs, breadcrumbs, browser/OS, IP as seen by Sentry; `sendDefaultPii:false`, no `setUser`, Session Replay off. Scrubbing by key name on main; **path tokens and emails/phones in free text are masked only once the SECURITY branch (`be7140af`, `a0c26962`) ships**.
- **Browser vs server:** both.
- **Prod state:** ACTIVE — `monitoring.enabled=true`.
- **Region / transfer:** Germany (DSN host `*.ingest.de.sentry.io`, VERIFIED 2026-11-13). Functional Software Inc. is US ⚖.
- **Terms to verify:** DPA; event retention (F-16); AI/ML data-use settings in the Sentry organisation.
- **Retention / deletion:** events expire on plan retention; an event that shows PII can be deleted in the UI.
- **Pre-consent:** **on main today, browser errors *and* performance traces are sent before any choice.** Pending **#1092**: error reports stay consent-free (classed strictly necessary — lawful basis ⚖, decision PD-5 in `COMPLIANCE-GAPS.md`), performance telemetry only after the visitor enables "Performance monitoring"; nothing optional on `/q`, `/customer-portal`, `/worker-portal`, `/l`.
- **AI training:** verify organisation AI settings.

## 8. PostHog — product analytics
- **Purpose:** anonymous page-view statistics.
- **Data categories:** page views with UUID-masked URLs (query values other than UUIDs are **not** masked; the auth-URL email leak M-7 is fixed at source on `privacy/data-minimisation`), device/browser properties, random visitor id cookie, IP as seen by PostHog. No autocapture, no session recording, no `identify()`.
- **Browser vs server:** browser (`posthog-js`, loaded dynamically only after consent). Server sink DORMANT (`serverEnabled=false`).
- **Region / transfer:** EU (`eu.i.posthog.com`, CSP VERIFIED 2026-11-16).
- **Terms to verify:** DPA; project data retention (F-16); IP capture setting.
- **Retention / deletion:** project retention; withdrawal deletes the cookie/local state (#1092).
- **Pre-consent:** **none** — nothing loads before Accept (main) / the analytics switch (#1092).
- **AI training:** verify PostHog AI feature settings.

## 9. Google — OAuth sign-in
- **Purpose:** "Continue with Google" (the only social sign-in on the live `/login`, VERIFIED 2026-11-16).
- **Data categories:** Google returns name, email, picture URL to Supabase Auth (`auth.users.raw_user_meta_data`). CrewFlow no longer copies the picture URL (M-2).
- **Browser vs server:** browser redirect to Google; Supabase Auth exchanges the code.
- **Role / terms:** Google is an independent controller of the Google account ⚖. **Retention:** Auth identity lives until account deletion (#1091, dark).
- **Pre-consent:** only when the user clicks. **AI training:** n/a.

## 10. Backblaze B2 — off-platform encrypted backups
- **Purpose:** disaster recovery independent of Supabase.
- **Data categories:** a weekly archive of schema + data + **auth data** + every storage object, AES-256 encrypted on the operator's machine before upload (`scripts/ops/off-platform-backup.sh`); B2 never sees plaintext or the key.
- **Browser vs server:** neither — operator-run script (rclone).
- **Prod state:** ACTIVE (`ops_backup_runs` rows; alerting PR #1099 pending).
- **Region / transfer:** bucket region F-9.
- **Retention / deletion:** last 8 archives (~8 weeks), remote and local. **The script also keeps the last 8 *plaintext* dated directories on the operator's machine** (VERIFIED on main: the local-plaintext prune keeps `RETENTION` copies) — G-6. Deleted data is "beyond use" and ages out; the #1091 tombstone re-application on restore is built, its upload beside the backup is staged.
- **Pre-consent / AI training:** n/a.

## 11. Vercel KV / Upstash
- **Purpose:** cache of the AI insights narrative per org; ops snapshot (`lib/cache/kv.ts`; no-op when `KV_REST_API_*` absent).
- **Data categories:** generated narrative text from business aggregates (no direct identifiers by design; free text could name people).
- **Prod state:** credentials reported present (2026-11-10 activation register) — not re-verifiable from outside.
- **Region:** F-9. **Retention:** cache TTL. **Pre-consent / AI training:** n/a.

## 12. Meta — WhatsApp Cloud API
- **Purpose:** tenant ↔ customer WhatsApp messaging and the (dormant) assistant.
- **Data categories when used:** phone numbers (`wa_id`), message text, media, captions/transcripts; inbound location messages are parsed (`lib/comms/providers/meta-whatsapp.ts`).
- **Prod state:** **ARMED** — `/api/health comms.whatsapp=true` (token + phone-number id + `NEXT_PUBLIC_FEATURE_WHATSAPP=true`), 2026-11-16; no customer traffic known (1 route, 1 event at 2026-11-13). Contradicts documents that call it dark (G-17, F-19).
- **Region / transfer:** Meta (USA/global) ⚖. **Terms to verify:** WhatsApp Business terms / DPA; Meta's own controller uses.
- **Retention / deletion:** no Meta API to delete messages; local rows go with the org. DPIA before real use (G-21).
- **AI training:** verify Meta business-messaging data-use terms.

## 13–14. Companies House; GitHub
- **Companies House:** HQ prospecting; outbound requests carry search terms/company numbers; returned public-register data makes CrewFlow a controller of prospect contacts (G-12). UK.
- **GitHub:** source code and CI only; the uptime monitor reads `/api/health` booleans. Not a recipient of production personal data.

## 15–17. Dormant integrations — what would flow when switched on
| Service | Switch | Would receive | Note before activation |
|---|---|---|---|
| Twilio SMS / voice, Vapi | Twilio creds + `COMMS_*_PROVIDER` + `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` / `…MISSED_CALL_TEXTBACK` | phone numbers, SMS text, call audio, recordings, transcripts | DPIA (G-21); recording notice; provider deletion step (#1091 §6) |
| Microsoft (sign-in, Graph calendar) | `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO`, `FEATURE_CALENDAR_CONNECT` | identity; calendar events | — |
| Google Calendar | `FEATURE_CALENDAR_CONNECT` | job/rota events out, calendar events in | — |
| Xero / QuickBooks / Sage | `FEATURE_ACCOUNTING_CONNECT` | customers, invoices | — |
| Plaid / GoCardless / TrueLayer | `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` | bank transactions | — |
| HMRC | `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` | VAT returns, UTRs, fraud-prevention headers (IP, UA) | HMRC = controller |
| Samsara / Verizon Connect | `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` | vehicle GPS positions (= driver tracking); Verizon endpoint is US (`fim.api.us.fleetmatics.com`) | DPIA + worker notice (G-21) |
| Merchants (JP Corry, Jewson, Travis Perkins, Haldane Fisher) | `NEXT_PUBLIC_FEATURE_MERCHANTS` | purchase orders | — |
| Web Push vendors | VAPID keys + a subscribed device | encrypted payload to the device endpoint | — |
| Outbound webhooks / marketplace | `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS`, `FEATURE_MARKETPLACE` | event payloads to tenant-chosen URLs | tenant is controller of the destination |
| Weather | `weather.available=false` | postcode district only | not personal data |

## Pending-PR changes to these flows (none on main yet)
| PR | Flow change |
|---|---|
| #1090 billing | Owner self-cancel → Stripe `cancel_at_period_end`; ledger `subscription_cancellations` (requested_by_email + reason; anonymised on erasure); HQ notice + owner email via Resend. No data deletion on cancellation. |
| #1091 deletion (flag `FEATURE_ACCOUNT_DELETION`, default off) | Account / company / staff erasure; Stripe subscription cancelled first, customer kept; minimised billing archive; tombstones for restores. |
| #1092 consent | Banner categories necessary / analytics / performance; Sentry performance consent-gated; Cookie settings control; optional tracking never on `/q`, `/customer-portal`, `/worker-portal`, `/l`. |
| AI spend governance | Platform-wide monthly AI ceiling + audit (HQ operator id/email). |
| Security branch | Sentry free-text and path-token scrubbing. |
