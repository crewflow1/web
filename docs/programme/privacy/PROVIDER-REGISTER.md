# CrewFlow — third-party provider register (verified 2026-11-13)

**Scope.** Every third party that code in this repository can send personal data to, or that the visitor's browser contacts when using crewflow.uk. Each row is classified from evidence, not from older documents:

- **ACTIVE** — the code path is live in production and the credential/flag that arms it is present.
- **ARMED** — credential **and** flag are present in production, but no customer traffic has used it.
- **DORMANT** — built, but dark behind a named switch (flag and/or credential).
- **ABSENT** — not in the build.

**Evidence labels** follow `AGENT-RULES.md` §5. "VERIFIED" means the cited command, header, file or count was observed on 2026-11-13. Things only the founder can confirm (contracts, DPAs, plan tiers, dashboard settings) are marked **NEEDS-FOUNDER** and listed in `FOUNDER-FACTS-NEEDED.md`.

**How production state was read (all read-only):** `curl https://crewflow.uk/api/health`; response headers of public routes; the public JavaScript chunks served by crewflow.uk; aggregate `COUNT(*)` queries on the production catalogue; the code at `origin/main` (`8cec66a7`). No secret value was read or recorded.

---

## 1. Summary table

| # | Provider | Status | Role (CrewFlow's view) | Personal data sent | Region / transfer | Key evidence |
|---|---|---|---|---|---|---|
| 1 | **Supabase** (Postgres, Auth, Storage) | ACTIVE | Processor (sub-processor for tenant data) | Everything in the database and 13 storage buckets; auth identities, sessions (IP + user agent) | **eu-west-1 (Ireland)** — VERIFIED from the linked project's pooler host | §2.1 |
| 2 | **Vercel** (hosting, serverless functions, logs) | ACTIVE | Processor (sub-processor) | Every HTTP request and response in transit; request logs (IP, URL, user agent); function runtime logs (`console.*`) | Edge: London (`lhr1`). Serverless functions execute in **`dub1` (Dublin)** since 2026-11-15 (`vercel.json` `regions`) — VERIFIED `x-vercel-id: lhr1::dub1::…` on 2026-11-16 (was `iad1`, USA, on 2026-11-13) | §2.2 |
| 3 | **Stripe** (CrewFlow's own SaaS billing) | ACTIVE (live mode, self-serve OFF) | Independent controller for payment processing / processor for billing records — **legal review** | Organisation name, organisation email, internal org id; prospect email on a setup-fee checkout link; card details go **directly** to Stripe (never touch CrewFlow) | Stripe (global; US parent) — NEEDS-FOUNDER for DPA/transfer mechanism | §2.3 |
| 4 | **Resend** (transactional email + Supabase Auth SMTP) | ACTIVE | Processor (sub-processor) | Recipient email address, subject, full email body (quotes, invoices, statements, notifications, invites), PDF attachments | NEEDS-FOUNDER (Resend account region) | §2.4 |
| 5 | **Anthropic** (Claude API) | ACTIVE | Processor (sub-processor) | Prompt content: lead text, enquiry text, minimised quote context, business aggregates, **images/PDFs of receipts, imported documents and forms** | USA — NEEDS-FOUNDER for DPA/transfer mechanism and retention terms | §2.5 |
| 6 | **OpenAI** (embeddings, transcription) | ACTIVE for HQ-internal memory embeddings; DORMANT for tenant-search embeddings and voice transcription | Processor (sub-processor) | HQ memory text (CrewFlow's own notes; may name a customer organisation). If tenant-search embedding is switched on: denormalised tenant record text | USA — NEEDS-FOUNDER | §2.6 |
| 7 | **Sentry** (error + performance monitoring) | ACTIVE | Processor (sub-processor) | Error events and 10% of traces: URLs, stack traces, breadcrumbs, browser/OS, IP as seen by Sentry | **Germany (`ingest.de.sentry.io`)** — VERIFIED from the public bundle | §2.7 |
| 8 | **PostHog** (product analytics) | ACTIVE **only after the visitor clicks Accept** (browser sink); server sink DORMANT | Processor (sub-processor) | Page views with UUID-masked URLs, device/browser properties, PostHog's own cookie/identifier, IP as seen by PostHog | **EU (`eu.i.posthog.com`)** — VERIFIED from the public bundle | §2.8 |
| 9 | **Google** (OAuth sign-in) | ACTIVE | Independent controller (identity provider) | The user is redirected to Google; Google returns name, email, profile-picture URL to Supabase Auth | Google (global) | §2.9 |
| 10 | **Backblaze B2** (off-platform backup) | ACTIVE | Processor (storage of ciphertext only) | A weekly **AES-256-encrypted** archive of the full database + storage; B2 never receives plaintext or the key | NEEDS-FOUNDER (bucket region) | §2.10 |
| 11 | **Vercel KV / Upstash** (cache) | ACTIVE (credentials reported present 2026-11-10) | Sub-processor via Vercel | Cached AI "insight narrative" text (business aggregates) keyed by org; ops snapshot | NEEDS-FOUNDER (KV region) | §2.11 |
| 12 | **Meta — WhatsApp Cloud API** | **ARMED** | Processor for messages CrewFlow sends; Meta is also an independent controller of its platform | When used: recipient phone number, message text, media | Meta (global; US) | §2.12 |
| 13 | **Companies House** (public register API + bulk file) | ACTIVE credential; 0 sourced rows in prod | Source of public data, not a recipient of personal data | Outbound: search terms / company numbers only | UK | §2.13 |
| 14 | **GitHub** (CI, outage monitor) | ACTIVE | Not a recipient of production personal data | Source code and CI logs; the outage monitor only polls `/api/health` | — | §2.14 |
| 15 | **Twilio** (SMS, voice) | DORMANT | would be sub-processor | When enabled: phone numbers, SMS text, call audio/recordings | — | §3 |
| 16 | **Vapi** (voice AI) | DORMANT | would be sub-processor | When enabled: call audio, transcripts | — | §3 |
| 17 | Inbound email (via Resend inbound) | DORMANT | — | When enabled: sender address, full email | — | §3 |
| 18 | Web Push (browser vendors: Google FCM, Mozilla, Apple) | DORMANT (0 subscriptions) | — | When enabled: encrypted notification payload to the device's push endpoint | — | §3 |
| 19 | Accounting: Xero, QuickBooks, Sage | DORMANT | — | When enabled: customer + invoice data pushed | — | §3 |
| 20 | Banking: Plaid, GoCardless (Nordigen), TrueLayer | DORMANT | — | When enabled: bank transactions pulled | — | §3 |
| 21 | HMRC (MTD VAT, CIS verification) | DORMANT | HMRC = independent controller | When enabled: VAT return, UTRs, fraud-prevention headers (user IP, user agent) | — | §3 |
| 22 | Calendar: Google Calendar, Microsoft Graph | DORMANT | — | When enabled: job/rota events pushed; calendar events pulled | — | §3 |
| 23 | Telematics: Samsara, Verizon Connect | DORMANT | — | When enabled: vehicle GPS positions pulled | — | §3 |
| 24 | Builders' merchants (JP Corry, Jewson, Travis Perkins, Haldane Fisher) | DORMANT | — | When enabled: purchase orders | — | §3 |
| 25 | Microsoft (Azure AD OAuth sign-in) | DORMANT | — | — | — | §3 |
| 26 | Tenant-configured outbound webhooks / marketplace partners | DORMANT | recipients chosen by the tenant | When enabled: event payloads | — | §3 |
| 27 | Weather (Open-Meteo / Met Office) | DORMANT — `/api/health` reports `weather.available=false, providerImplemented=false` | not personal data (postcode **district** only) | — | — | §3 |
| 28 | Vercel Analytics / Speed Insights | **ABSENT** | — | — | — | §4 |
| 29 | Google Analytics / Tag Manager / Fonts / Maps embeds, Meta pixel, Hotjar, Clarity, any ad network | **ABSENT** | — | — | — | §4 |

---

## 2. ACTIVE providers — detail and evidence

### 2.1 Supabase — ACTIVE · VERIFIED
- **What it holds:** the whole product database (288 tables/views across `public`, `auth` and `storage` carry personal data — see `data-register.csv`), Supabase Auth (`auth.users`, `auth.identities`, `auth.sessions` with raw IP + user agent, MFA factors), and 13 **private** storage buckets.
- **Region:** `aws-0-eu-west-1` (Ireland). Evidence: the linked project's pooler host (`supabase/.temp/pooler-url` in the linked checkout; host only, no credential read).
- **Buckets:** all 13 are `public = false` — VERIFIED by `select id, public from storage.buckets` on production. Files are served through short-lived signed URLs.
- **Backups:** Supabase daily managed backups (7-day retention on Pro — NEEDS-FOUNDER to confirm in dashboard); PITR add-on is **not** purchased (`docs/backup-recovery-runbook.md`, CEO-deferred).
- **Invoked indirectly by:** nothing — it is the system of record. Supabase Auth in turn sends its emails through Resend SMTP (§2.4) and redirects to Google for OAuth (§2.9).
- **Auth audit log:** `auth.audit_log_entries` has **0 rows** in production (VERIFIED count). Auth events are therefore not being retained in the database; whether they exist in Supabase's log explorer and for how long is NEEDS-FOUNDER.

### 2.2 Vercel — ACTIVE · VERIFIED
- **2026-11-16 update — resolved:** `vercel.json` now sets `"regions": ["dub1"]` (commit `e3773aa1`) and `curl -sI https://crewflow.uk/login` returns `x-vercel-id: lhr1::dub1::…`. The paragraph below is the 2026-11-13 finding, kept for the record.
- **(2026-11-13) Function region was the United States.** `curl -sI https://crewflow.uk/login` → `x-vercel-id: lhr1::iad1::…`; same for `/q/[token]` and `/api/v1/openapi.json`. The first segment is the edge location that received the request (London); the second is where the serverless function ran (`iad1`, Washington DC). `vercel.json` sets no `regions`; only three webhook routes pin `preferredRegion = "lhr1"`. The edge-runtime health route runs in `lhr1`.
- **Consequence:** every server-rendered page and server action — i.e. essentially all personal data the product displays or accepts — is processed in memory in the USA, then read from / written to the database in Ireland. That is a restricted international transfer that the live privacy policy does not disclose (it says data is "hosted in the European Union"), and it also adds a transatlantic round trip to every query.
- **Logs:** Vercel request logs (IP, path, user agent) and function logs (`console.log/error` output — 1,264 call sites). Log retention depends on the Vercel plan — NEEDS-FOUNDER.
- **Personal data found in URLs that reach logs:** `/login?error=…&email=<address>` is produced by `bounceToLogin()` in `app/auth/callback/route.ts` when sign-in bootstrap fails; bearer tokens are path segments on `/q/<token>`, `/customer-portal/<token>`, `/worker-portal/<token>`, `/a/<token>`.
- **Vercel Analytics / Speed Insights:** ABSENT (no `@vercel/analytics` or `@vercel/speed-insights` dependency; the CSP `connect-src` entry for `vitals.vercel-insights.com` is unused allowance).
- **`vercel.live`:** allowed in CSP for the preview toolbar; not loaded on production pages (not present in the production HTML fetched 2026-11-13).

### 2.3 Stripe — ACTIVE (live mode) · VERIFIED for configuration, register-level for mode
- `/api/health` → `billing.configured=true, webhookConfigured=true, selfServe=false`.
- **What CrewFlow sends:** `stripe.customers.create({ name: org.name, email: org.email, metadata: { org_id } })` (`app/admin/customers/[id]/_stripe-actions.ts`); for a demo prospect, `customer_email: demo.email` on a Checkout Session (`lib/stripe/demo-checkout.ts`). Founder-initiated only — self-serve billing is off.
- **What comes back:** webhook events stored in `billing_events.payload` (retained indefinitely; classed "retain" on org erasure).
- **Not active:** customer-portal card payments / Stripe Connect (`NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS`; `org_payment_connections` has 0 rows).

### 2.4 Resend — ACTIVE · VERIFIED
- `/api/health` → `comms.email=true`. One sender: `lib/email/send.ts` (`resend.emails.send`).
- **What it receives:** recipient address(es), subject, HTML/text body and attachments for: quotes and invoices (with PDF) to tenants' customers, statements, payment reminders, review requests, staff notifications and digests, staff invites, leave and material-request emails, demo confirmations, HQ notifications. Supabase Auth emails (magic link, password reset) also go through Resend SMTP (baseline fact from the programme brief; the SMTP setting lives in the Supabase dashboard — NEEDS-FOUNDER to confirm).
- **Events webhook:** `comm_events` holds 16 rows in production, so Resend delivery events (recipient address + provider payload) are being received and stored. There is no retention rule on `comm_events`.
- **Inbound email:** DORMANT (`email_webhook_events` 0 rows, `email_inbound_routes` 0 rows).

### 2.5 Anthropic — ACTIVE · VERIFIED (ledger)
- 580 rows in `ai_invocations` in production. The activation register (2026-11-10) attributes real spend to HQ narratives, `insights.narrative`, `imports.ocr`; the tenant features share the same governed path.
- **Feature → what leaves** (from `lib/ai/governor/registry.ts` and the calling services):

| Feature id | Trigger | Personal data in the prompt |
|---|---|---|
| `lead.summary` | staff open/action a lead | lead fields incl. contact name and message text |
| `quote.writer_draft` | staff click "draft with AI" | closed disclosure contract (`lib/ai/quote-context.ts`): **no** customer name, email, phone or full address — outward postcode only; free-text notes go as typed |
| `site_manager.answer`, `insights.narrative`, `insights.question` | staff ask / view | job and business aggregates; free text from site diaries / snags |
| `expense.receipt_extraction` | receipt upload | the receipt image/PDF |
| `imports.ocr` | data import of a scan/PDF/image | the uploaded file — may be a full customer or staff list |
| `document.form_autofill` | "import a document" on a form | the uploaded document — the cron comment names CVs, V5C logbooks and insurance certificates |
| `receptionist.*`, `chat.auto_reply` | inbound channel message | enquiry text + caller reference — **dormant** (no inbound channel) |
| `hq.*`, `research.*`, `memory.summarise` | CrewFlow HQ staff | CrewFlow's own business data; prospect company research |

- **What CrewFlow keeps:** `ai_invocations` stores user id, feature, model, token counts, cost and a **hash** of the prompt — not the prompt or the response. Drafts/summaries are stored in their own tables.
- **No redaction layer** sits in front of the model: apart from the quote-writer contract, prompts carry whatever the tenant typed or uploaded.
- **Budget control:** per-org ceiling via the cost governor (`docs/ai-cost-governor.md`).

### 2.6 OpenAI — ACTIVE (narrow) · VERIFIED by code + register
- **Active:** `memory.embedding_write` / `memory.embedding_query` — embeddings of CrewFlow's **HQ memory** entries (`hq_memories`, 6 rows; internal notes that can name a customer organisation). `hq_embedding_runs` has 6 rows.
- **Dormant:** tenant semantic search — `tenant_search_documents` has 503 rows with **0** embedded (`embedded_at` null for all; VERIFIED count). The embedder is behind a database flag (`tenant_search_embed_enabled`). A column deny-list (`lib/search/semantic/mappers.ts`) keeps money, secrets and NI numbers out of the index text.
- **Dormant:** `voice_note.transcription` — the provider is bound and has self-test spend, but there is no way to record audio in the product (Permissions-Policy `microphone=()`; `voice_notes` 0 rows).
- OpenAI is also wired as an optional text provider (`lib/ai/text/index.ts`) — only if a governor tier is bound to it.

### 2.7 Sentry — ACTIVE · VERIFIED
- `/api/health` → `monitoring.enabled=true`. Region: the DSN host in the public bundle is `*.ingest.de.sentry.io` (Germany). `tracesSampleRate` 0.1 in production; Session Replay **off** (`replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`); `sendDefaultPii: false`; `Sentry.setUser` is never called.
- **Scrubbing** (`lib/monitoring/scrub.ts`, wired as `beforeSend` and `beforeSendTransaction` in all three configs): headers/cookies/secret-named keys, secret query parameters, user reduced to `{id}`.
- **Gap found 2026-11-13; fix now owned by the SECURITY workstream (`security/injection-secrets-hardening`, commits `be7140af` + `a0c26962`) — not on this branch:** a synthetic event showed the scrubber let through (a) the bearer token in the **path** of `/q/<token>`, `/customer-portal/<token>`, `/worker-portal/<token>`, `/a/<token>` and (b) email addresses / phone numbers embedded in exception messages and console breadcrumbs. Both are masked on that branch. **Until it is deployed, production Sentry can receive them** (IMPLEMENTED on branch, not deployed).
- Event retention depends on the Sentry plan — NEEDS-FOUNDER.

### 2.8 PostHog — ACTIVE behind consent · VERIFIED
- `/api/health` → `analytics.clientConfigured=true, serverEnabled=false`; the public bundle contains a PostHog project key and `eu.i.posthog.com`.
- **Gate:** `lib/analytics/consent.ts` + `lib/analytics/load.ts` — `posthog-js` is dynamically imported **only** after the visitor chooses Accept (cookie `cf_cookie_consent=granted`). Reject or no choice → nothing loads.
- **Configuration:** `autocapture: false`, `disable_session_recording: true`, `person_profiles: "identified_only"` and no `identify()` call — so visitors are anonymous; `capture_pageview: true`; UUIDs in URLs are masked (`lib/analytics/sanitize-url.ts`).
- **Surfaces:** the banner and analytics never mount on `/q/*` or `/customer-portal/*` (`isFirstPartySurface`). **Not excluded:** `/worker-portal/<token>` and `/a/<token>` — on those the banner shows and, if accepted, the page-view URL would carry a non-UUID bearer token to PostHog. Flagged to the cookie-consent workstream (`COMPLIANCE-GAPS.md` G-9).
- `posthog-js` is a production dependency (`package.json`); `posthog-node` backs the dormant server sink.
- The live privacy policy says "We do not currently run product-analytics tracking" — no longer accurate.

### 2.9 Google OAuth — ACTIVE · VERIFIED
- The live `/login` page renders "Continue with Google"; `auth.identities` has 2 `google` identities. Default scopes (`openid email profile`); `prompt=select_account`.
- Supabase Auth stores what Google returns (name, email, picture URL) in `auth.users.raw_user_meta_data` / `auth.identities.identity_data`. CrewFlow used to copy the picture URL into `users.avatar_url`; that stopped on this branch (commit `015c53fb`).
- **Fonts — no remote font host at all.** Inter is loaded with `next/font/google`, which downloads the files at **build** time and serves them from crewflow.uk; Clash Display and Satoshi (marketing pages) are self-hosted with `next/font/local` from `app/_marketing/fonts/`. The browser makes no request to Google Fonts or Fontshare: the CSP is `font-src 'self' data:` and the production HTML references neither `fonts.googleapis.com`, `fonts.gstatic.com` nor `api.fontshare.com` (VERIFIED 2026-11-13).
- **Maps:** `lib/maps.ts` builds outbound *links* to Google/Apple Maps. Nothing is embedded; the address reaches the map provider only if a user clicks the link.

### 2.10 Backblaze B2 — ACTIVE · VERIFIED by script + runbook
- `scripts/ops/off-platform-backup.sh`: dumps schema + data + **auth data** + every storage object, validates, encrypts locally (`openssl enc -aes-256-cbc -pbkdf2 -iter 600000`), uploads only the ciphertext with `rclone`, keeps the newest **8** (weekly → roughly 8 weeks). `ops_backup_runs` has 16 rows.
- **Not obvious from the summary line "backups are encrypted":** the script also keeps the last 8 **plaintext** dump directories on the operator's Mac (`docs/ops/off-platform-backup-automation.md` → "Retention / rotation": "plaintext dated dirs + encrypted artifacts"). See `COMPLIANCE-GAPS.md` G-6.
- The header comment of the script still says "Cloudflare R2"; the runbook and default remote are Backblaze B2. Bucket region is NEEDS-FOUNDER.

### 2.11 Vercel KV — ACTIVE (register-level)
- Used by `server/services/ai-insights.ts` to cache the generated narrative text per org (`lib/cache/kv.ts`; every call no-ops when KV is not configured). No direct identifiers by design; narrative text is generated from business aggregates. Presence of `KV_REST_API_*` in production is taken from the 2026-11-10 activation register (not re-verifiable without dashboard access) — IMPLEMENTED-UNTESTED from my side.

### 2.12 Meta WhatsApp Cloud API — ARMED · VERIFIED (**contradicts prior documents**)
- `/api/health` → `comms.whatsapp=true`. By `lib/comms/readiness.ts` that boolean is `outboundReady`, which is true only when `WHATSAPP_ACCESS_TOKEN` **and** `WHATSAPP_PHONE_NUMBER_ID` are present **and** `NEXT_PUBLIC_FEATURE_WHATSAPP === "true"`.
- Production holds 1 `whatsapp_number_routes` row and 1 `whatsapp_webhook_events` row; 0 messages, 0 conversations, 0 opt-outs, 0 inbound media.
- The activation register (2026-11-10) lists WhatsApp as "flag off / `WHATSAPP_*` missing / EXTERNALLY BLOCKED", and the programme baseline lists WhatsApp as dark. **Both are stale on this point:** the channel is switched on and credentialed; it simply has no traffic (inbound delivery from Meta is the known blocker). A founder-test recipient allow-list exists (`WHATSAPP_TEST_RECIPIENT_ALLOWLIST`) — whether it is set in production is NEEDS-FOUNDER.
- **Policy treatment chosen:** described as "available only when a company connects WhatsApp" — not listed as a current recipient of anyone's data.

### 2.13 Companies House — ACTIVE credential, no personal data sent
- `COMPANIES_HOUSE_API_KEY` reported present (register); `hq_sales_sourcing_pool` has 0 rows in production. Outbound requests carry search terms/company numbers. The data that comes *back* is public-register company data which CrewFlow would hold as a controller for B2B prospecting (see `COMPLIANCE-GAPS.md` G-12).

### 2.14 GitHub — ACTIVE, not a personal-data recipient
- `.github/workflows/outage-monitor.yml` polls `/api/health` (booleans only). `companies-house-bulk-sourcing.yml` processes the public bulk file. `GITHUB_TOKEN`/`VERCEL_TOKEN` for HQ "CTO telemetry" are reported absent.

---

## 3. DORMANT providers — the switch that keeps each one off

| Provider | Switch (all must be set) | Production evidence it is off |
|---|---|---|
| Twilio SMS | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_SMS_FROM` | `/api/health` `comms.sms=false`; `sms_deliveries` 0 rows |
| Twilio voice / AI receptionist | `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` + `COMMS_VOICE_PROVIDER` + Twilio credentials | `calls` 0, `call_events` 0, `phone_numbers` 0 |
| Missed-call text-back | `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` + SMS ready | `/api/health` `missedCallTextbackReady=false` |
| Vapi | `VAPI_WEBHOOK_SECRET` (+ voice provider selection) | no call rows |
| Channel adapters (generic inbound) | `CHANNEL_INBOUND_SECRET` | `inbound_enquiries` 0, `conversations` 0 |
| Inbound email | `NEXT_PUBLIC_FEATURE_INBOUND_EMAIL` + `INBOUND_EMAIL_WEBHOOK_SECRET` | `email_webhook_events` 0 |
| Web Push | VAPID key pair + a subscribed device | `push_subscriptions` 0, `push_deliveries` 0 (the public key is reported present; the drain cron runs and finds nothing) |
| Accounting (Xero/QBO/Sage) | `FEATURE_ACCOUNTING_CONNECT` + OAuth app credentials | `accounting_connections` 0 |
| Banking (Plaid/GoCardless/TrueLayer) | `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` + `BANKING_*` | `bank_connections` 0 |
| HMRC | `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` + `HMRC_CLIENT_ID/SECRET` | `hmrc_connections` 0 |
| Calendar (Google/Microsoft) | `FEATURE_CALENDAR_CONNECT` + OAuth app credentials | `calendar_connections` 0 |
| Telematics (Samsara/Verizon) | `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` + `TELEMATICS_*` | `telematics_connections` 0, `telematics_readings` 0 |
| Merchants | `NEXT_PUBLIC_FEATURE_MERCHANTS` + per-merchant keys | no connection rows |
| Microsoft sign-in | `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO` | live `/login` shows only "Continue with Google" |
| Enterprise SSO / SCIM | `FEATURE_ENTERPRISE_SSO` + per-org config | `org_sso_config` 0 |
| Outbound webhooks | `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS` | `webhook_endpoints` 0 |
| Public API | API keys issued by a tenant | `api_keys` 0, `api_request_log` 0 |
| Portal card payments (Stripe Connect) | `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` + Connect keys | `org_payment_connections` 0 |
| PostHog server sink | `ANALYTICS_SERVER_ENABLED` + `POSTHOG_SERVER_KEY` | `/api/health` `analytics.serverEnabled=false` |
| Tenant-search embeddings (OpenAI) | DB flag `tenant_search_embed_enabled` | 0 of 503 documents embedded |

Server-side flag *values* in production cannot be read from outside; for those rows the evidence is the absence of any data the feature would create.

## 4. ABSENT — checked and not found
`@vercel/analytics`, `@vercel/speed-insights`, Google Analytics / gtag / Tag Manager, Meta pixel, Hotjar, Microsoft Clarity, Plausible, Intercom/Crisp chat widgets, reCAPTCHA/hCaptcha/Turnstile, YouTube/Vimeo embeds, Google Fonts/Maps network requests, any advertising SDK.
Evidence: `package.json` dependencies; `grep` for the vendor hosts across `app/ lib/ components/`; the production home page HTML (2026-11-13) references no third-party host other than outbound `<a>` links to social profiles; the CSP `script-src` allows only `self`, `eu-assets.i.posthog.com` and `vercel.live`.

## 5. What tenants will need: sub-processor list
For a tenant DPA (Art. 28), the sub-processors that actually touch tenant data today are: **Supabase, Vercel, Resend, Anthropic, Sentry, Backblaze, Vercel KV/Upstash**, plus **OpenAI** and **Meta** the moment tenant-search embeddings or WhatsApp carry tenant data, and **PostHog** for consenting app users. Stripe relates to CrewFlow's own billing of the tenant. A published sub-processor page with a change-notification mechanism does not exist yet (`COMPLIANCE-GAPS.md` G-3).
