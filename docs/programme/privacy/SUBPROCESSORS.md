# CrewFlow sub-processors (DRAFT for publication, 2026-11-16)

**Status: draft. Do not publish until the `[FOUNDER: …]` cells are filled and reviewed `[LEGAL REVIEW]`.** Source: `DATA-FLOW-MAP.md` (code on main `d24295e8`; production state from `/api/health` and response headers on 2026-11-16). Where a provider's account region, DPA or transfer mechanism cannot be seen from the code it says so.

Controller entity: `[FOUNDER: F-1 legal name, F-3 company number]`. Questions and objections: `[FOUNDER: F-5 privacy contact]`. Last updated: `[FOUNDER: F-15 date]`. Changes to this list: customers are told `[FOUNDER: notice period — suggest 30 days]` before a new sub-processor handles their data (see DPA clause 6).

## A. Sub-processors that handle customer (tenant) data today

| Provider | Purpose | Customer data involved | Location | Transfer mechanism | Status in production |
|---|---|---|---|---|---|
| **Supabase** (Supabase Inc.; hosted on AWS) | Database, sign-in, file storage, managed backups | All workspace data; sign-in identities and sessions (IP, user agent); uploaded files | Ireland (`eu-west-1`) | US-parented: support/ops access `[LEGAL REVIEW]`; `[FOUNDER: F-9 DPA accepted? mechanism]` | **Active** |
| **Vercel** (Vercel Inc.) | Hosting, application servers, request and function logs | All data in transit; request logs (IP, URL, user agent) | Functions Dublin (`dub1`); edge London | US-parented `[FOUNDER: F-9 mechanism; log location/retention F-16]` | **Active** |
| **Resend** | Sending email (quotes, invoices, statements, reminders, notifications; sign-in emails) | Recipient address, subject, body, PDF attachments, delivery events | `[FOUNDER: F-9 account region]` | `[FOUNDER: F-9]` | **Active** |
| **Anthropic** | AI drafting and extraction on request: lead summaries, quote drafts, site-manager answers, insight narratives, receipt/import/document reading | Content the user submits to the feature, including names in lead text and images of receipts or documents. CrewFlow keeps a hash and cost record, not the prompt | USA | `[FOUNDER: F-10 / F-9(c)]` `[LEGAL REVIEW]` restricted transfer | **Active** (company can switch off: not yet — `[FOUNDER: PD-6]`) |
| **Backblaze** (B2) | Off-platform disaster-recovery backup | Weekly archive of the whole database, auth data and files, **encrypted by CrewFlow (AES-256) before upload**; Backblaze holds ciphertext only and never the key | `[FOUNDER: F-9 bucket region]` | `[FOUNDER: F-9]` | **Active** (weekly, operator-run) |
| **Vercel KV / Upstash** | Short-lived cache (AI insights narrative; ops snapshot) | Generated narrative text from business aggregates | `[FOUNDER: confirm region and that it is active]` | `[FOUNDER: F-9]` | Reported active, not verifiable from outside `[FOUNDER: confirm]` |
| **Sentry** (Functional Software Inc.) | Error and performance monitoring | Stack traces, URLs, browser/OS, IP; no user identity set; free-text scrubbing pending | Germany (`ingest.de.sentry.io`) | US-parented `[FOUNDER: F-9]` | **Active** — telemetry about users is CrewFlow-controller processing |

## B. Sub-processors for CrewFlow's own (controller) purposes — website and account

| Provider | Purpose | Data | Location | Status |
|---|---|---|---|---|
| **Stripe** | Charging CrewFlow's setup fee and subscription | Organisation name, email, internal id; card details go directly to Stripe. Stripe is also an independent controller for fraud/compliance | `[FOUNDER: F-9 entity/location]` | **Active** (live mode; self-serve sign-up off) |
| **PostHog** | Anonymous page-view statistics, **only after the visitor accepts analytics** | URL (ids masked), device/browser, random visitor id, IP as seen by PostHog | EU (`eu.i.posthog.com`) | **Active after consent** |
| **Google** | "Continue with Google" sign-in (Google is an independent controller of the Google account) | Name, email, picture URL passed to sign-in; CrewFlow does not store the picture | Global | **Active** (on user click) |
| **Companies House** (UK public register) | CrewFlow's sales prospecting only | Search terms / company numbers out; public-register data in | UK | Active, HQ only; not customer data |
| **OpenAI** | Embeddings for CrewFlow's internal memory | Internal notes that may name a customer organisation. Tenant search embeddings and voice transcription are **off** | USA | Active (narrow); customer-data use **dormant** — `[FOUNDER: F-10]` |
| **Meta (WhatsApp Cloud API)** | Messaging between a company and its customers | Phone numbers, messages, media | USA/global | **Credentialed and flagged on; no known customer traffic** `[FOUNDER: F-19 confirm intent; DPIA before real use]` |

## C. Dormant — off unless a company turns the feature on

Each becomes a sub-processor (or independent controller) for that company only once enabled; this list is updated first.

| Provider | Feature | Data if enabled |
|---|---|---|
| Twilio; Vapi | SMS, call recording, AI voice receptionist | Phone numbers, SMS text, call audio, recordings, transcripts (DPIA first) |
| Microsoft (Entra sign-in; Graph calendar); Google Calendar | Sign-in / calendar sync | Identity; calendar events |
| Xero, QuickBooks, Sage | Accounting sync | Customers, invoices |
| Plaid, GoCardless, TrueLayer | Bank feeds | Bank transactions |
| HMRC | VAT / filing connection | VAT returns, UTRs, fraud-prevention headers (HMRC is a controller) |
| Samsara; Verizon Connect (US endpoint) | Vehicle telematics | Vehicle GPS positions (driver tracking; DPIA first) |
| JP Corry, Jewson, Travis Perkins, Haldane Fisher | Merchant purchase orders | Purchase orders |
| Browser push vendors (Google, Mozilla, Apple) | Web Push | Encrypted notification payload |
| Customer-chosen webhook URLs | Outbound webhooks / marketplace | Event payloads (the customer is controller of the destination) |
| Open-Meteo / Met Office | Weather | Postcode district only (not personal data); currently unavailable |

## D. Not sub-processors
GitHub (source code and CI only; the uptime monitor reads yes/no health flags). Vercel Analytics and Speed Insights are not installed. No remote font hosts are used.

## E. Facts to fill before publishing
Controller name/number (F-1, F-3); privacy contact (F-5); date (F-15); for each active provider — DPA signed (F-9a), account region (F-9b), transfer mechanism (F-9c); provider retention (F-10, F-16); WhatsApp intent (F-19); KV status. `[LEGAL REVIEW: whether naming each provider's regions and mechanisms publicly is required or only on request.]`

## F. Pending changes (not live) that alter this list
PR #1092 (consent: performance telemetry opt-in), the security branch (Sentry scrubbing), PR #1091 (deletion; Stripe subscription cancelled, customer kept), AI spend governance (platform ceiling).
