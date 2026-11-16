# CrewFlow — privacy policy: audit of the live page + replacement draft

**Status: DRAFT — NOT PUBLISHABLE.** Written by an engineer from the code, not by a solicitor. It contains placeholders of the form **⟦FOUNDER FACT F-n: …⟧** wherever a legal or business fact is needed that nobody but the founder (or their adviser) can supply. Every placeholder maps to `FOUNDER-FACTS-NEEDED.md`. The whole document needs review by a qualified UK data-protection adviser before any of it is published — the items most in need of that review are listed in Part D.

Evidence labels follow `AGENT-RULES.md` §5. The technical facts behind every statement are in `DATA-FLOW-MAP.md` (current provider state), `PROVIDER-REGISTER.md`, `RETENTION-SCHEDULE.md`, `DATA-PROCESSING-REGISTER.md`, `DATA-MINIMISATION.md` and `DSAR-PROCEDURE.md`. Open lawful-basis and retention decisions are numbered **PD-n** in `COMPLIANCE-GAPS.md` §Decisions.

**Revision 2026-11-16** — Part E brought to product truth at main `d24295e8` plus the pending PRs it depends on: function region now Dublin; end-of-paid-period cancellation with no automatic deletion (founder policy 2026-11-16, #1090); cookie categories necessary / analytics / performance and the Sentry error-vs-performance split (#1092); AI governed by per-company spending limits; encrypted off-platform backups; account/company deletion (#1091, dark until its flag); staff pay/payroll access limited (D-17). A sentence that depends on an unmerged PR carries a ⟦PRECONDITION: …⟧ marker — it must not be published before that PR is released. Part A is the 2026-11-13 audit of the live page; its status column below records what has changed since.

### Part A status on 2026-11-16
| Rows | Change since 2026-11-13 |
|---|---|
| A7 | Free-text / path-token scrubbing moved to the SECURITY branch (`be7140af`, `a0c26962`); still undeployed |
| A13 | **Resolved for hosting:** functions run in `dub1` (Dublin) — `x-vercel-id: lhr1::dub1`, 2026-11-16. AI providers (USA) and US-parented processors still need a transfers section |
| A24, A25 | Resolved by #1092 once released: "Cookie settings" withdrawal control in every footer; `/worker-portal` and `/l` excluded from optional tracking |
| A29 | Now contradicted twice: the founder's policy is that cancelling **never** deletes data automatically; deletion is a separate request (#1091, dark). The live 30-day promise in both the policy and the terms must go (the terms draft in #1090 `docs/programme/cancellation/TERMS-UPDATE-DRAFT.md` already proposes this) |
| new | Photos can carry the phone's GPS position in EXIF metadata (`DATA-MINIMISATION.md` M-6) — the "we do not track location" sentence needs PD-4 |
| new | Every magic-link sign-in put the email address in a URL (M-7) — **fixed** on `privacy/data-minimisation` (`924774c1`) |

---

## Part A — The live page (`app/privacy/page.tsx`, "last updated 2026-05-21"), statement by statement

Verdicts: **OK** (matches the code) · **INACCURATE** (says something the code contradicts) · **OVER-CLAIM** (promises more than is implemented or provable) · **INCOMPLETE** (true as far as it goes, but omits something material) · **MISSING** (required content that is absent).

| # | Live statement (abridged) | Verdict | What the evidence shows |
|---|---|---|---|
| A1 | "CrewFlow is operated from Belfast, Northern Ireland." | **MISSING** | No legal entity name, company number, registered address or ICO registration. A privacy notice must identify the controller and give contact details (UK GDPR Art. 13(1)(a)). → F-1…F-4 |
| A2 | "'you' means anyone using the product, owners, admins, staff, and the customers our users send quotes or invoices to." | **INCOMPLETE** | Treats everyone alike. For a tenant's customers, staff records, subcontractors and site visitors CrewFlow is a **processor**; the tenant is the controller and the person's first point of contact. Also omits prospects, external workers/site visitors and subcontractors as groups |
| A3 | "Account data: your email, name, phone (optional), and the organisation you belong to." | **INCOMPLETE** | Also held: password hash; role; sign-in sessions with **IP address and browser user agent** (`auth.sessions`); MFA factors; for Google sign-in, the profile Google returns (name, email, picture URL) inside Supabase Auth |
| A4 | "Business data you enter: customers, leads, jobs, quotes, invoices, payments, time entries, payroll runs, and any notes or files you attach." | **INCOMPLETE** | Omits the most sensitive categories the product can hold: staff National Insurance number, date of birth, pay rate, tax/NI category, pension status, emergency contact; subcontractor UTR and CIS status; H&S sign-offs with signatures; site-visitor log incl. vehicle registration |
| A5 | "when an end customer opens a quote link or signs in to the customer portal, we record the fact that the link was opened (timestamp + a hashed IP for audit)." | **INACCURATE** | Opening records a **timestamp only** (`quotes.viewed_at`, `portal_token_last_used_at`). The hashed IP is recorded when the customer **accepts** a quote — together with their typed name, the **browser user agent**, and optionally a drawn signature image (`signatures`). Customers do not "sign in"; the portal is a bearer link. The portal also stores their messages, uploads, bookings and requests — unmentioned |
| A6 | "We do not sell or share this with anyone." | **OVER-CLAIM** | Not sold — no evidence of any sale. But it *is* disclosed to service providers: stored at Supabase, processed on Vercel, emailed through Resend |
| A7 | "Operational telemetry: error reports and performance traces via Sentry… contain technical diagnostics (stack traces, timings), not your business records." | **OVER-CLAIM** | A synthetic event proved the scrubber let through bearer tokens in URL paths and email addresses/phone numbers inside error messages and console breadcrumbs. Fixed on the SECURITY branch (`be7140af`, `a0c26962`), not yet deployed; free text can never be guaranteed clean |
| A8 | "We do not currently run product-analytics tracking; if we introduce it, it will be optional and stays off until you opt in." | **INACCURATE** | PostHog is configured in production (`/api/health` `analytics.clientConfigured=true`; key and `eu.i.posthog.com` in the public bundle). The second half is true: it loads only after Accept |
| A9 | *(nothing about AI)* | **MISSING** | Tenant data is sent to **Anthropic** (lead text, minimised quote context, business summaries, images/PDFs of receipts, imported documents and forms) and CrewFlow-internal notes to **OpenAI**. 580 AI calls are logged in production. The policy never mentions AI or these providers |
| A10 | "We don't sell your data. Ever." | OK | No sale path exists in the code |
| A11 | "We don't use customer-facing data … to market anything to your end customers." | OK | No code path sends CrewFlow marketing to tenants' customers |
| A12 | "We don't run third-party advertising trackers on the product." | OK | None found (see `PROVIDER-REGISTER.md` §4) |
| A13 | "Primary storage is Supabase (PostgreSQL), hosted in the European Union." | **INCOMPLETE — materially** | Storage is in Ireland (true). But every page render and server action executes on Vercel in **Washington DC, USA** (`x-vercel-id: lhr1::iad1`), AI processing happens in the USA, and Stripe is US-headquartered. There is no international-transfer section at all (Art. 13(1)(f)) |
| A14 | "Backups are encrypted at rest." | **INCOMPLETE** | The off-platform archive is AES-256 encrypted before upload. The same script keeps the last 8 **plaintext** dump directories on the operator's computer. Supabase's own backup encryption is a Supabase statement I have not verified |
| A15 | "File uploads (receipts, photos) live in Supabase Storage with the same regional scope." | OK | 13 private buckets, same project |
| A16 | "Operational telemetry (Sentry) is processed under its DPA." | **OVER-CLAIM (unverifiable)** | Whether a DPA is in place is a founder fact (F-9). Region is Germany |
| A17 | *(no list of recipients)* | **MISSING** | Vercel, Resend, Stripe, Anthropic, OpenAI, PostHog, Backblaze, Google (sign-in) are not named anywhere (Art. 13(1)(e)) |
| A18 | "Row-Level Security on every table enforces that members of one organisation can't see another's rows." | OK | RLS is enabled on 323 of 323 tables in the local catalogue; isolation is proven by the integration suites, not by me here |
| A19 | "share links (`/q/<token>` and `/customer-portal/<token>`) use long random tokens… the contractor can rotate the token to revoke access at any time." | **INCOMPLETE** | True for the customer-portal token (`rotateCustomerPortalToken`). No rotate/revoke control for a **quote** link was found by static search. The third bearer link, `/worker-portal/<token>` (external worker sign-off), is not mentioned |
| A20 | "Internally, only the on-call engineer can access production infrastructure, and access is logged." | **OVER-CLAIM (unverifiable)** | In-product support access is logged (`impersonation_sessions`: operator, reason, IP, user agent). Who can sign in to the Supabase / Vercel / Stripe dashboards, and whether that is logged, is outside the code → F-12 |
| A21 | "We don't look at your business data unless you ask us to." | **INCOMPLETE** | CrewFlow's HQ console computes health scores, onboarding progress and revenue figures per tenant organisation from tenant activity, and CrewFlow's internal AI memory can name customer organisations. That is CrewFlow using tenant-level information for its own customer-success purposes and should be stated |
| A22 | Cookies: auth session cookie; active-workspace cookie; staff support-access cookie | OK | `active_org_id`, `cf_impersonation_session`, Supabase auth cookies |
| A23 | "We do not set analytics or advertising cookies by default. If we introduce optional product analytics, we'll ask for your consent first…" | **INACCURATE (stale tense)** | It has been introduced; the banner is live |
| A24 | "You can change your mind later by clearing the consent cookie." | **OVER-CLAIM** | There is no in-product control to withdraw; withdrawing must be as easy as giving (PECR/UK GDPR). Owned by the cookie-consent workstream |
| A25 | "The customer portal and public quote pages never set analytics or tracking cookies for end customers." | OK, but **INCOMPLETE** | True for `/q/*` and `/customer-portal/*` (`isFirstPartySurface`). The external-worker page `/worker-portal/*` is **not** excluded — the banner shows there |
| A26 | *(browser storage)* | **MISSING** | The app stores tenant data on the device in IndexedDB for offline working (write queue, photo queue, read cache) and small preferences in `localStorage`. PECR covers all device storage, not just cookies |
| A27 | "You can ask us to (a) confirm what data we hold… (b) provide a copy, (c) correct… (d) delete it." | **INCOMPLETE** | Omits restriction, objection, portability, withdrawal of consent, and the automated-decision statement. Does not tell a tenant's customer or employee to go to the tenant first. Does not say how each right is actually met (most are manual) |
| A28 | "we aim to respond within 14 days." | **OVER-CLAIM (operational)** | The statutory limit is one month. There is no per-person export or erasure tool, so each request is manual database work by the founder. Keep the promise only if it can be met → F-13 |
| A29 | "When you delete a workspace, we delete the business data within 30 days." | **INACCURATE** | No workspace-deletion feature exists; the erasure route is switched off (`FEATURE_GDPR_ERASURE`); no scheduled job. Nothing has ever been erased (`gdpr_erasure_log` = 0). The same promise is in `app/terms/page.tsx` |
| A30 | "Operational logs (Sentry, Supabase audit) roll off on a 90-day window." | **INACCURATE** | Cron telemetry: 14/90 days (true). `activity_log`, `admin_activity_log`, `impersonation_sessions`, the event spine: never deleted. Sentry/Vercel: plan-dependent, unconfirmed |
| A31 | "Where UK tax law requires us to retain certain records… we'll do so for the statutory period and no longer." | **OVER-CLAIM** | Nothing deletes them when any period ends |
| A32 | "Material changes are emailed to account owners ahead of taking effect." | **OVER-CLAIM (process)** | No mechanism exists in the product; it would be a manual email. Keep only if the founder commits to it → F-14 |
| A33 | "Email hello@crewflow.uk for anything." | **INCOMPLETE** | No postal address; no statement on whether a Data Protection Officer is appointed → F-2, F-5 |
| A34 | *(lawful bases)* | **MISSING** | No lawful basis is stated for any purpose (Art. 13(1)(c)), nor the legitimate interests relied on (Art. 13(1)(d)) → F-6 |
| A35 | *(prospect / marketing data)* | **MISSING** | CrewFlow holds demo requests and a sales CRM, and contacts construction firms by email. Where the data did not come from the person (Companies House, public websites) Art. 14 requires saying so; PECR governs the emails → F-7 |
| A36 | *(children)* | **MISSING** | No statement |
| A37 | *(security measures)* | **INCOMPLETE** | Only RLS is mentioned. MFA, private storage with signed links, transport security, hashed IPs, encrypted off-platform backup, support-access logging are evidenced and unmentioned |

**Count (37 rows):** 5 INACCURATE · 8 OVER-CLAIM · 11 INCOMPLETE · 7 MISSING · 7 OK (one OK row is also marked INCOMPLETE).

---

## Part B — Decisions taken in the draft

1. **Dormant providers are not listed as recipients.** Twilio, Vapi, the accounting/banking/HMRC/calendar/telematics connectors, merchants, outbound webhooks, web push and Microsoft sign-in are built but switched off; naming them as current recipients would be untrue. The draft has one short section, "Optional features that are switched off today", describing them by *type* and promising an update before any is switched on. **WhatsApp** (armed, no traffic) is handled the same way — it is described as available only where a company connects it. **OpenAI** is named, because it does receive CrewFlow-internal text today.
2. **Processor/controller is explained up front**, because the single most useful thing a tenant's customer can learn from this page is "ask the company you hired".
3. **No retention promise is made that the code does not keep.** The draft states what happens today and marks the decision the founder has to make (build the 30-day teardown, or stop promising it).
4. **The 14-day response aim and the "we email you about changes" promise are placeholders**, not carried over.
5. **Plain English is kept** — the audience is tradespeople, as the live page says.

## Part C — Was the page changed in code?

**No. `app/privacy/page.tsx` is untouched on this branch.** Reasons:

- The replacement cannot be completed without at least the controller's legal identity, address, ICO registration and lawful bases (F-1…F-6). The brief forbids inventing them.
- A page with visible placeholders would still be **published** the moment the branch is merged and deployed — "visibly marked" does not stop a deploy. The only real safeguard would be a build-time test that fails while placeholders remain, which would then block the branch that carries the minimisation fixes.
- Changing a published legal notice changes what CrewFlow has promised people; that is the founder's decision, on advice.

What is ready instead: Part E below is written so it can be transcribed into `LegalShell` JSX section by section once the placeholders are filled. Two changes do **not** need new facts and could be made immediately if the founder agrees, because they only remove untrue statements: (i) replace the analytics sentence (A8/A23) with "we use optional product analytics (PostHog, EU) only if you accept"; (ii) delete the two deletion-period promises (A29–A31) or build the mechanism. They are listed as G-1 in `COMPLIANCE-GAPS.md`.

## Part D — What needs qualified legal review

1. Controller/processor allocation, especially staff accounts, AI features and CrewFlow's use of tenant-level health metrics.
2. Lawful basis for each purpose; the legitimate-interests assessments behind monitoring, prospecting and support access.
3. International transfers: the mechanism for each US-based provider (UK–US data bridge participation vs. IDTA/Addendum) and transfer risk assessments.
4. Whether CrewFlow must register with the ICO and pay the data-protection fee (almost certainly yes), and whether a DPO is required (probably not, but it is a legal judgement).
5. PECR position on B2B email outreach to sole traders/partnerships, and the soft-opt-in wording.
6. The tenant DPA and sub-processor terms this notice refers to.
7. Retention periods to promise.
8. Whether a DPIA is needed before switching on call recording, AI voice, telematics, or tenant-wide AI on uploaded documents.
9. The wording on AI: no automated decision-making, human review, provider training use.

---

## Part E — DRAFT POLICY TEXT

> **⟦DRAFT — DO NOT PUBLISH. Contains unfilled founder facts and has not had legal review.⟧**

# Privacy policy

*Last updated: ⟦FOUNDER FACT F-15: publication date⟧*

This page explains what personal information CrewFlow handles, why, who else is involved, and what you can do about it. We have tried to write it the way we would explain it across a van bonnet.

## 1. Who we are

CrewFlow is software that construction and trades companies use to run their business: leads, quotes, jobs, staff, health and safety, invoices and payments.

CrewFlow is provided by **⟦FOUNDER FACT F-1: full legal name of the company or sole trader that operates CrewFlow⟧**, ⟦FOUNDER FACT F-3: company number and where registered, or "a sole trader"⟧, of **⟦FOUNDER FACT F-2: registered / postal address⟧** ("CrewFlow", "we").

We are registered with the Information Commissioner's Office: **⟦FOUNDER FACT F-4: ICO registration number — or register first⟧**.

Contact for anything on this page: **⟦FOUNDER FACT F-5: privacy contact email (currently hello@crewflow.uk) and whether a Data Protection Officer has been appointed⟧**.

## 2. Two different situations — please read this bit

**If you are a customer, employee, subcontractor or site visitor of a company that uses CrewFlow**, that company decides what information about you goes into CrewFlow and why. In data-protection terms they are the "controller" and we are their "processor": we store and handle the information on their instructions. If you want to see, correct or delete that information, **ask that company first** — they are the ones who can decide. We will help them respond, and if you contact us we will pass your request to them.

**If you have a CrewFlow login, asked us for a demo, were contacted by us about CrewFlow, or simply visited our website**, we decide how that information is used, and this policy is our explanation to you.

## 3. What we handle

### 3.1 If you have a CrewFlow login
- **Account details:** email address, name, phone number if you add one, your role, and the company workspace(s) you belong to.
- **Sign-in information:** a scrambled (hashed) version of your password; if you sign in with Google, the name, email address and profile-picture link Google sends us (we do not use the picture); your multi-factor settings if you turn them on; and for each sign-in session the IP address and the type of browser used.
- **What you do in the product:** records you create or change are stamped with your user ID, and a log of actions is kept for your company to see.

### 3.2 Information a company keeps in CrewFlow (we are the processor)
Depending on which parts of CrewFlow the company uses, this can include:
- **Their customers and enquirers:** name, email, phone, home or site address, what was asked for, quotes, invoices, payments, job history, messages, photos and documents about the job.
- **Quote acceptance:** when a customer accepts a quote online we record the name they typed, the time, the type of browser, and a scrambled version of their IP address that cannot be turned back into the address — and their drawn signature if they add one. Opening a quote or portal link records only the time.
- **Their staff:** working hours, rota, leave, pay rate, payroll estimates, and — only if the company chooses to enter them — National Insurance number, date of birth, tax and pension details, an emergency contact, and qualification cards or certificates.
- **Health and safety records:** risk assessments, permits, toolbox-talk attendance, site inductions and sign-offs (with a typed or drawn signature), and a site-visitor log (name, employer, vehicle registration, time in and out).
- **Their suppliers and subcontractors:** contact details, payments and, for the Construction Industry Scheme, tax reference (UTR), verification details and deduction rate.

We do **not** collect fingerprints, face scans or any other biometric data. We do **not** track anyone's location: clocking in does not record where you are. ⟦DECISION PD-4: photos uploaded from a phone can contain the place they were taken (camera "EXIF" data), which CrewFlow currently stores unchanged. Either strip it on upload (then this sentence can stay as is) or keep it as site evidence and add: "Photos taken on a phone may include where and when they were taken, if the phone records that."⟧ We never see or store card numbers.

### 3.3 If you ask for a demo or we contact you about CrewFlow
Your name, company, email, phone, company size and anything you tell us. If we found your business ourselves, the details came from public sources such as Companies House and your own website. ⟦FOUNDER FACT F-7: confirm the sources used for prospecting and the opt-out wording used in outreach emails⟧

### 3.4 If you visit our website or use the app
- **Essential cookies and storage** that make the site work (see section 8).
- **Hosting logs:** our hosting provider records the IP address, browser type and the page requested, as every website does.
- **Error reports (always on):** if something breaks, a technical report is sent to our monitoring provider (Sentry, Germany) so we can fix it. This happens whatever you choose about optional cookies, because we cannot keep the service working without it ⟦DECISION PD-5: lawful basis for consent-free error reporting — legitimate interests / strictly necessary — for the adviser⟧. We strip out passwords, cookies, access links, email addresses and phone numbers before it is sent, and we do not record your screen. Error reports may still incidentally contain other text that was on the page. ⟦PRECONDITION: the SECURITY branch's scrubbing (`be7140af`, `a0c26962`) is deployed.⟧
- **Performance monitoring — only if you switch it on:** page-speed and session-health measurements, sent to Sentry. No cookies. ⟦PRECONDITION: #1092 released — on the current site these measurements are sent without asking.⟧
- **Product analytics — only if you switch it on:** anonymous page-view statistics (PostHog, EU), with a random visitor ID in a cookie. No session recording, no advertising. Nothing is collected if you choose "Reject all" or ignore the banner.

## 4. Why we use it, and our legal basis

> ⟦FOUNDER FACT F-6: the lawful basis for each purpose must be confirmed by a qualified adviser. The table below is an engineer's proposal of what is *commonly* relied on, shown so the adviser has something to mark up. It must not be published as-is.⟧

| What we do | Proposed basis — for legal review |
|---|---|
| Give you a login and keep it secure | performing our contract with you / your company |
| Bill the company that subscribes | contract; legal obligation to keep accounts |
| Handle a company's records on its instructions | we act as processor — the company chooses the basis |
| Reply to a demo request | steps you asked us to take before a contract |
| Contact businesses about CrewFlow | legitimate interests, within the email-marketing rules (PECR) |
| Keep the service secure and working (logs, error reports, rate limits, support-access records) | legitimate interests ⟦PD-5⟧ |
| Product analytics; performance monitoring | your consent (PECR + UK GDPR) |
| Record a subscription cancellation and any refund review | contract; legal obligation to keep accounts ⟦PD-2⟧ |
| Keep a minimal record of a deletion (who asked, when, what was removed — no names) so it can be re-applied after a restore | legal obligation / legitimate interests ⟦PD-8⟧ |
| Keep a deleted company's CrewFlow invoices in minimised form | legal obligation to keep accounts ⟦PD-3: period⟧ |
| AI features on a company's records | we act as processor — the company's instructions ⟦PD-6⟧ |
| AI on CrewFlow's own business notes (internal) | legitimate interests ⟦PD-6⟧ |
| Keep company data after a subscription ends | ⟦PD-1: basis and period — decided by the founder with the adviser⟧ |
| Backups | legitimate interests / our duty to keep data secure |

## 5. Artificial intelligence

Some features use AI to save typing — for example summarising a new enquiry, drafting a quote, reading a receipt or an uploaded document, or answering a question about a job.

- The text or file needed for that task is sent to our AI provider, **Anthropic**, to be processed. For quote drafting we deliberately leave out the customer's name, email, phone and full address.
- AI only **drafts and suggests**. A person at the company reviews it before anything is saved or sent. CrewFlow makes no automated decisions about people.
- We keep a record of which AI feature was used, by whom and what it cost — not what was said.
- AI use is capped: every company has a monthly AI spending limit that is checked before each request, and requests that would go over it are refused. ⟦PRECONDITION for "and CrewFlow has an overall monthly limit": the AI workstream's platform budget is released.⟧
- ⟦DECISION PD-6: there is currently no switch for a company to turn AI features off. Either build one before publishing, or say: "AI features run only when someone at the company uses them; a company that does not want them can ask us to disable them."⟧
- Our own internal notes are also processed by **OpenAI** to make them searchable.
- ⟦FOUNDER FACT F-10: confirm from the Anthropic and OpenAI agreements (a) that customer data is not used to train models, (b) how long each retains requests, (c) the international-transfer mechanism. Do not publish a "not used for training" sentence until confirmed.⟧

## 6. Who else is involved

We use other companies to run CrewFlow. They only handle information to provide their service to us.

| Provider | What for | Where |
|---|---|---|
| Supabase | Database, sign-in, file storage | Ireland (EU) |
| Vercel | Runs the website and app; request logs | Ireland (EU) — application code runs in Dublin; the network edge that first receives your request may be in the UK. Vercel is a US company ⟦F-9: transfer safeguard for its support/log access⟧ |
| Vercel KV (Upstash) | Short-term cache of AI-generated business summaries | ⟦FOUNDER FACT F-9⟧ |
| Resend | Sends emails (quotes, invoices, notifications, sign-in links) | ⟦FOUNDER FACT F-9⟧ |
| Stripe | Takes payment for CrewFlow subscriptions | ⟦FOUNDER FACT F-9⟧ |
| Anthropic | AI features | United States |
| OpenAI | Search over our own internal notes | United States |
| Sentry | Error reports (always); performance measurements (only if you switch them on) | Germany (EU) |
| PostHog | Product analytics, only if you switch it on | EU |
| Backblaze | Encrypted off-site backup — they hold a scrambled copy and cannot read it | ⟦FOUNDER FACT F-9⟧ |
| Google | "Continue with Google" sign-in, if you choose it | Google's own terms apply |

⟦FOUNDER FACT F-9: for every row confirm (a) a data processing agreement is in place, (b) the region on the account, (c) the transfer mechanism where outside the UK.⟧

We do not sell personal information. We do not share it with advertisers. We may have to disclose information if the law requires it.

### Optional features that are switched off today
CrewFlow includes features that are **not switched on**: phone and text-message handling; WhatsApp ⟦FOUNDER FACT F-19: WhatsApp is credentialed and flagged on in production with no traffic — confirm it is meant to be on; if it stays on, move it into the table above (Meta, USA)⟧; an AI phone receptionist; incoming email; push notifications; and connections to accounting packages, banks, HMRC, calendars, vehicle trackers and builders' merchants. None of these receives anyone's information at present. If a company turns one on in future, the provider behind it will handle the information needed for that feature, and we will update this page first.

## 7. Information leaving the UK

Our database and files are stored in Ireland, and the application runs in Ireland. Some of the providers above process information in the United States (our AI providers in particular), and several are US-owned companies. ⟦FOUNDER FACT F-8 / F-9: state the safeguard actually relied on for each — for example the UK–US data bridge for certified providers, or the UK International Data Transfer Agreement/Addendum. This sentence must be written by the adviser.⟧

## 8. Cookies and storage on your device

⟦PRECONDITION: this section describes the consent banner in #1092; publish it with or after that release. The authoritative list is `docs/programme/consent/COOKIE-REGISTER.md` on that branch.⟧

When you first visit, a banner lets you **Reject all**, **Accept all** or **Customise**. You can change or withdraw your choice at any time from **Cookie settings** at the bottom of every page; withdrawing stops that category straight away and deletes its cookies from your device.

**Strictly necessary — always on:**
- a sign-in cookie that keeps you logged in ⟦F-17: its lifetime — the software default is 400 days, rolling⟧;
- short-lived security cookies used while you sign in or connect another service (minutes);
- a cookie that remembers which company workspace you have open;
- a cookie that records your cookie choice (which categories, when), for one year — it contains no identifier;
- for our own support staff only, a short-lived support-access cookie;
- storage inside your browser that lets the app keep working with poor signal on site (unsent changes, queued photos, a recent copy of your jobs, drawings you chose to keep offline), cleared when you sign out, and small interface preferences such as which menu groups are open;
- the company that hosts our files may set a short-lived security cookie when your browser opens a file.

**Product analytics — off unless you switch it on:** PostHog (EU) sets a cookie with a random visitor ID and records anonymous page views. No session recording, no advertising.

**Performance monitoring — off unless you switch it on:** Sentry measures page speed and session health. It sets no cookies.

Error reports are not part of the banner: see section 3.4.

We never show the banner or run optional tracking on a customer's quote or portal page, the external-worker sign-off page or a public enquiry form — even if you accepted elsewhere on the site.

There are no advertising cookies.

## 9. How long we keep it

> ⟦DECISIONS PD-1, PD-2, PD-3, PD-7, PD-9, PD-10: periods must be decided, and the product made to keep them, before this section is published. What follows describes what the software does **today** plus the released-with-#1090/#1091 behaviour marked as preconditions.⟧

- **Company records** stay for as long as the company keeps its CrewFlow account. A company can delete individual records and download a full export at any time.
- **Cancelling your subscription** ⟦PRECONDITION: #1090 released⟧: you can cancel from Settings → Billing. Cancellation takes effect at the end of the period you have already paid for, and you keep full access until then. **Cancelling does not delete your data.** After the subscription ends, the account owner can still sign in to download an export and invoices; other users lose access. ⟦DECISION PD-1: how long company data is kept after a subscription ends, and what happens at the end of that period. Until decided, say: "We keep it until you ask us to delete it, subject to the retention periods below."⟧
- **Deleting your company or your account** ⟦PRECONDITION: #1091 released and its flag switched on; until then: "email us"⟧: the owner can ask for the company to be deleted from Settings; there is a 7-day cooling-off period during which it can be cancelled, and we offer an export first. A user can delete their own login at any time; records their employer keeps about their work stay with that employer, no longer linked to a readable name. We keep a minimal record that a deletion happened (no names), and we keep CrewFlow's own invoices to the company in minimised form for ⟦PD-3: period, proposed 6 years after the year end⟧.
- **Records the law requires a company to keep** (for example tax, payroll, Construction Industry Scheme and health-and-safety records) are the company's responsibility; when a company deletes its account those records are deleted with it unless ⟦PD-9: confirm with the adviser that CrewFlow, as processor, deletes rather than retains them — #1091 implements deletion after an export is offered⟧.
- **Uploaded documents used to fill in a form automatically** are deleted after 7 days.
- **Technical run logs** are deleted after 14 days (90 days for failures). Sent-email queue entries after 90 days. Abuse-prevention counters a day after they expire, stored only in scrambled form ⟦PRECONDITION: `privacy/data-minimisation` released⟧.
- **Backups:** we keep encrypted copies of the database and files away from our main provider. A deleted record can remain in backups for up to ⟦PD-7: currently about 8 weeks in the encrypted off-site archive and 7 days at the database provider⟧ until they are replaced; if we ever restore a backup, we re-apply deletions made since it was taken ⟦PRECONDITION: #1091 tombstone export wired into the backup job⟧.
- **Our providers' logs** (email, hosting, error reports) are kept for the periods in their terms ⟦F-16: list each⟧.
- **Demo requests and sales contacts:** ⟦PD-10: period to be decided⟧.

## 10. Keeping it safe

- Each company's information is separated from every other company's inside the database, and that separation is tested automatically.
- Within a company, staff cannot see company financial reports, payroll or administrative functions; pay and payroll details are limited to owners and administrators who hold the pay permission; a colleague's phone number, employment type and start date are visible only to that person and to owners/administrators. These limits are enforced in the database, not just by hiding menus.
- Files are private and opened through short-lived links.
- Connections are encrypted (HTTPS), and you can turn on multi-factor sign-in.
- IP addresses recorded with a signature are stored only in scrambled form.
- Off-site backups are encrypted before they leave our systems.
- When our own staff need to open a company's workspace to help, the session is recorded with who, when and why.
- ⟦FOUNDER FACT F-12: who has administrator access to the hosting, database and payment dashboards, and that multi-factor sign-in is enforced on each — needed before making any claim about internal access.⟧

No system is perfectly secure. If something goes wrong that puts your information at risk we will tell the people affected and the ICO as the law requires.

## 11. Your rights

Under UK data-protection law you can ask to: see the information held about you; have it corrected; have it deleted; have its use restricted; object to its use; receive it in a portable format; and withdraw consent you have given (for example to analytics). CrewFlow makes no automated decisions about people.

**How this works in practice**
- **If a company put your information into CrewFlow** — ask that company. They can edit and delete records and download a full export.
- **If you have a CrewFlow login** — you can correct your name and phone in the product. To get a copy of your account data, or to change your login email, email us. You can delete your own account in Settings ⟦PRECONDITION: #1091 released and enabled; until then "email us"⟧.
- **If you asked for a demo or we contacted you** — email us and we will show you what we hold, correct it, delete it, or stop contacting you. ⟦FOUNDER FACT F-7: confirm every outreach email identifies CrewFlow and offers an opt-out before publishing a sentence saying so.⟧
- **Analytics and performance monitoring** — change or withdraw your choice at any time from **Cookie settings** at the bottom of every page ⟦PRECONDITION: #1092 released⟧.

We will reply within ⟦DECISION PD-11 / F-13: the response time you can actually meet — the legal maximum is one month⟧. It is free. How each right is met today is set out in `DSAR-PROCEDURE.md` (internal).

You can also complain to the Information Commissioner's Office at ico.org.uk, though we would like the chance to put it right first.

## 12. Children

CrewFlow is a business tool and is not aimed at children. A company may record a young worker (for example an apprentice) as a member of staff; that company is responsible for doing so lawfully.

## 13. Changes to this policy

We will update this page when the product or the law changes and change the date at the top. ⟦FOUNDER FACT F-14: whether and how account owners will be notified of material changes.⟧

## 14. Contact

⟦FOUNDER FACT F-5: privacy contact email⟧ · ⟦FOUNDER FACT F-2: postal address⟧
