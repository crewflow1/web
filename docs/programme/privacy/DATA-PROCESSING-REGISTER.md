# CrewFlow — data processing register (code-verified 2026-11-13)

**What this is.** A map of the personal data CrewFlow's software holds, who it is about, where it comes from, who can see it and where it goes — built from the database catalogue, the code at `origin/main` (`8cec66a7`) and aggregate production counts, not from earlier documents. The full column-level register is `data-register.csv` (1,077 columns, 288 tables/views); this file is the readable layer on top of it.

**What this is not.** It is not a legal "record of processing activities" (UK GDPR Art. 30) — that needs the controller's legal identity, lawful bases and a named contact, none of which an engineer may invent. Those gaps are listed in `FOUNDER-FACTS-NEEDED.md`. The lawful-basis column below is deliberately left as a **proposal for legal review**.

**Evidence labels** follow `AGENT-RULES.md` §5. Production figures are exact `COUNT(*)` aggregates (`prod-row-counts.json`); no row values were read.

---

## 1. Controller or processor? — the distinction this whole register rests on

CrewFlow plays two different roles, and almost every question about rights, retention and disclosure has a different answer depending on which one applies.

| | **CrewFlow as PROCESSOR** | **CrewFlow as CONTROLLER** |
|---|---|---|
| Whose purposes | The tenant's (the construction company running its business) | CrewFlow's own (running and selling the SaaS) |
| Data | Everything a tenant enters about **its** customers, leads, staff, subcontractors, suppliers, site visitors; files; H&S records; payroll estimates | Login identity and sessions; the tenant's billing relationship with CrewFlow; demo requests and sales prospects; support-access and security logs; product telemetry; website analytics |
| Who answers a data-subject request | The **tenant**. CrewFlow must help (Art. 28(3)(e)) and must not answer on the tenant's behalf | CrewFlow |
| Who decides retention | The tenant, within what the product lets them do | CrewFlow |
| Contract needed | A data processing agreement with each tenant, plus a sub-processor list | A privacy notice |

Three places where the line is not clean — each needs a legal view:

1. **A tenant's staff member.** Their *account* (email, password hash, sessions, MFA) is CrewFlow-controller data: CrewFlow decides how authentication works. Their *employment record* (pay, NI number, timesheets, leave) is tenant-controller data. One person, one `users` row, two roles. The same account can also belong to more than one tenant.
2. **AI features.** CrewFlow chose the AI providers and designed the prompts. For features a tenant invokes on its own data CrewFlow is still acting on the tenant's instruction (processor, with Anthropic as sub-processor) — but the tenant must be told, and the DPA must cover it.
3. **Telemetry about tenant users** (Sentry events, AI usage ledger, cron logs). CrewFlow collects this for its own purposes → controller, even though the people are the tenant's staff.

**Sole traders and partnerships.** Many construction "businesses" are individuals. For them an "organisation" record (name, address, VAT number, bank details) and a supplier or subcontractor record **is** personal data. The register marks these "business; personal if sole trader".

---

## 2. Who the data is about

| Data subject | Typical data | Role | Tables (count in register) |
|---|---|---|---|
| **Tenant owner / account holder** | name, email, business details, VAT no., bank details shown on invoices, billing state | Controller | `organizations`, `org_subscriptions`, `billing_*` |
| **Tenant staff / workspace users** | email, name, phone, role, working time, rota, leave, pay rate, payroll estimates, NI number, date of birth, tax/NI category, pension status, emergency contact, qualifications + card scans, H&S acknowledgements with signature | Controller for the account; processor for the employment record | `users`, `memberships`, `time_entries`, `payroll_*`, `staff_*`, … |
| **Tenant's customers** (often private householders) | name, email, phone, home/site address, quotes, invoices, payments, job history, photos of their property, messages, e-signature, portal uploads | Processor | `customers`, `quotes`, `invoices`, `jobs`, `signatures`, … |
| **Tenant's leads / enquirers** | name, contact details, postcode, what they asked for, a rule-based lead score | Processor | `leads`, `inbound_enquiries` |
| **Tenant's suppliers / subcontractors** | name, contact, UTR, CIS status and deduction rate, HMRC verification reference, payments | Processor | `suppliers`, `cis_*`, `supplier_payments` |
| **External workers, site visitors, witnesses** | name, employer, vehicle registration, time on site, signed inductions/acknowledgements (typed + drawn signature, hashed IP, user agent) | Processor | `site_visitors`, `site_inductions`, `worker_*`, `inspection_*` |
| **Members of the public who phone/message a tenant** | phone number, message text, call recording, transcript | Processor — **all dormant** | `calls`, `messages`, `conversations`, `whatsapp_*`, `receptionist_*` |
| **CrewFlow prospects** | name, company, email, phone, company size, notes; sales CRM entries | Controller | `demo_requests`, `hq_sales_*` |
| **CrewFlow operators** | email, actions taken, support-access sessions (raw IP, user agent) | Controller | `admin_activity_log`, `impersonation_sessions`, `hq_*` |
| **Website visitors** | IP and user agent in hosting logs; consent choice; analytics page views **only after Accept** | Controller | not in the database (Vercel, PostHog) |

Children: the product is a business tool with no age gate and no field that asks for age other than an optional staff date of birth. Apprentices under 18 could be recorded as staff by a tenant.

---

## 3. Special-category and high-risk data — what is and is not there

Checked column by column and by tracing the code (details in `DATA-MINIMISATION.md`).

| Kind | Present? | Evidence |
|---|---|---|
| Biometric data (face/fingerprint templates, liveness, voiceprints) | **No.** No biometric processing anywhere | No such columns; no face/voice-matching library in `package.json` |
| Identity-document photos (passport, driving licence) | **Not requested by any form.** A tenant *can* upload any file as a staff qualification scan or a form-import document | `staff_qualifications.document_path`; `form-imports` bucket (7-day purge) |
| Selfies / profile photos | **No longer collected.** A Google profile-picture URL was copied into `users.avatar_url` on sign-in and never used; stopped on this branch | commit `015c53fb`; 2 values remain in prod |
| Precise location / location history | **No longer accepted** at clock-in (was reachable only by a hand-crafted request; 0 values in prod). Vehicle telematics positions exist as a **dormant** feature | commit `671ee57a`; `telematics_readings` 0 rows |
| Health data | **Not asked for**, but can appear: leave `type` (sickness), free-text leave `reason`, H&S records, RIDDOR-style notes in site diaries | `leave_requests.type/reason` |
| Date of birth | Optional, payroll tax profile only; 0 values in prod | `payroll_tax_profiles.date_of_birth` |
| National Insurance number | Yes, optional, isolated in an admin-only table; 0 values in prod | `staff_secrets.ni_number` |
| UTR (subcontractor tax reference) | Yes — needed for CIS; masked in statements; 0 values in prod | `cis_subcontractors.utr` |
| Bank details | The tenant's own, printed on its invoices. No staff or customer bank details are collected. Card numbers never reach CrewFlow (Stripe Checkout) | `organizations.bank_details` |
| Emergency contact (a third party's data) | Yes, optional free text; 0 values in prod | `staff_compensation.emergency_contact` |
| IP addresses | Raw: Supabase Auth sessions, CrewFlow support-access sessions, hosting logs. Keyed hash: e-signatures and H&S acknowledgements. Rate-limit keys were raw; now a keyed digest (this branch) | `auth.sessions.ip`, `impersonation_sessions.ip_address`, `signatures.ip_address` (hash), commit `afdbc459` |
| Call recordings / voice | Dormant features only; 0 rows | `calls.recording_url`, `voice_notes.audio_url` |
| Trade-union, religion, ethnicity, sexual orientation, criminal records | **No fields.** Could only appear in free text | — |
| Automated decisions with legal/significant effect | **None.** A rule-based lead score and AI *drafts* exist; nothing is decided or sent without a person | `leads.lead_score*`; `docs/ai-cost-governor.md` |

---

## 4. Processing activities

Lawful basis is a **proposal for legal review**, never a finding. "R/W path" names the main code entry point; the CSV lists more.

### 4.1 As processor (on the tenant's instructions)

| # | Activity | Data subjects | Main tables | Written by | Read / shown | Leaves the system to | Status |
|---|---|---|---|---|---|---|---|
| P1 | CRM: customers, contacts, properties | customers | `customers`, `customer_contacts`, `properties` | `app/(app)/customers/actions.ts`; data import; public lead form | customer pages; quotes/invoices; customer portal | Resend (emails to the customer); PDFs; export ZIP | ACTIVE — 602 customers in prod |
| P2 | Lead capture and follow-up | enquirers | `leads`, `lead_followup_state` | `app/(app)/leads/actions.ts`; public form `app/l/[slug]` (consent box required); demo intake into the internal org | leads pages; dashboard | Anthropic (lead summary); Resend (staff notifications) | ACTIVE |
| P3 | Quoting and e-signature | customers | `quotes`, `quote_*`, `signatures` | `app/(app)/quotes/actions.ts`; public accept on `app/q/[token]` (typed name, optional drawn signature, **hashed** IP, user agent) | quote pages; public quote link | Resend (quote email + PDF); Anthropic (quote writer — name/contact/address excluded by contract) | ACTIVE |
| P4 | Invoicing, payments, reminders, statements | customers | `invoices`, `invoice_*`, `payments` | `app/(app)/invoices/…`; cron reminders | invoice pages; customer portal | Resend; accounting CSV export | ACTIVE; portal card payments DORMANT |
| P5 | Jobs, scheduling, site records | customers, staff | `jobs`, `job_*`, `site_diary_entries`, `snags`, `site_reports`, `rota_entries` | job/site actions; offline queue | job pages; customer portal (published items) | Anthropic (site manager, insights — aggregates + free text) | ACTIVE |
| P6 | Files | mixed | 13 private buckets + metadata tables | upload actions; portal uploads | signed URLs | Anthropic vision for receipts / imports / form autofill | ACTIVE — only `imports` holds files in prod (7) |
| P7 | Customer portal | customers | portal tokens on `customers` / `customer_contacts`; `portal_uploads`; `support_*`; `service_bookings` | `app/customer-portal/*` actions | the customer, by bearer link | Resend | ACTIVE |
| P8 | Staff directory, invites, roles | staff | `users`, `memberships`, `membership_permissions` | `app/(app)/staff/actions.ts`; `server/services/staff-invite.ts`; `app/onboarding/join` | staff pages | Resend (invite) | ACTIVE |
| P9 | Time, leave, rota | staff | `time_entries`, `leave_requests`, `holiday_entitlements` | `app/(app)/me/actions.ts`; staff actions | `/me`; timesheets; payroll | — | ACTIVE — 0 time entries in prod |
| P10 | Payroll **estimates**, payslip PDF, payroll CSV | staff | `payroll_*`, `staff_compensation`, `staff_secrets`, `pension_enrolments` | `app/(app)/payroll/actions.ts`; staff profile forms | payroll pages (admin); own payslip | downloaded PDF/CSV (includes NI number) | ACTIVE — no filing to HMRC; 0 staff pay rows in prod |
| P11 | Qualifications and compliance documents | staff | `staff_qualifications`, `compliance_documents` | staff actions | staff profile; expiry reminders | Resend (reminders) | ACTIVE — 0 rows |
| P12 | Health & safety: RAMS, permits, toolbox talks, inductions, sign-offs, visitor log | staff, external workers, visitors | `risk_assessments`, `permits_to_work`, `toolbox_talks`, `safety_acknowledgements`, `site_inductions`, `site_visitors`, `worker_*`, `inspection_*` | `app/(app)/health-safety/*`, `site-compliance/*`; external worker link `app/worker-portal/[token]` | H&S pages | — | ACTIVE |
| P13 | Suppliers, purchasing, CIS | suppliers, subcontractors | `suppliers`, `purchase_orders`, `cis_*`, `supplier_payments` | supplier / CIS actions | CIS pages; statements (masked UTR) | Resend (statements); CSV/PDF | ACTIVE — prepared/exported only, no HMRC submission |
| P14 | Notifications and email | staff, customers | `notifications`, `notification_email_queue`, `comm_events` | triggers, crons | bell; email | Resend | ACTIVE |
| P15 | AI assistance on tenant data | customers, leads, staff (as they appear in text/files) | `ai_quote_drafts`, `expense_drafts`, `form_import_drafts`, `leads.ai_summary` | governed AI calls (`lib/ai/governor`) | drafts shown to staff for approval | **Anthropic** | ACTIVE |
| P16 | Search | mixed | `tenant_search_documents` | queue from source tables | search palette | OpenAI embeddings — DORMANT | lexical ACTIVE (503 docs) |
| P17 | Data import | mixed | `imports`, `import_files`, `import_rows`, bucket `imports` | `app/(app)/imports/*` | import review | Anthropic vision (OCR) | ACTIVE — 1,803 staged rows retained |
| P18 | Export and erasure tooling | all tenant data | `gdpr_export_log`, `gdpr_erasure_log` | `/api/gdpr/export`, `/api/gdpr/erase` | owner/admin | the downloaded ZIP | export ACTIVE; erasure DORMANT |
| P19 | Phone, SMS, WhatsApp, inbound email, AI receptionist | members of the public | `calls`, `messages`, `conversations`, `inbound_enquiries`, `whatsapp_*`, `receptionist_*` | provider webhooks | inbox | Twilio / Meta / Vapi | **DORMANT** (WhatsApp ARMED, no traffic) |
| P20 | Integrations: accounting, banking, HMRC, calendar, telematics, merchants, webhooks, public API | mixed | `*_connections`, `telematics_readings`, `api_keys`, `webhook_*` | OAuth callbacks, sync crons | settings | the connected provider | **DORMANT** |

### 4.2 As controller (CrewFlow's own purposes)

| # | Activity | Data subjects | Where | Leaves to | Proposed basis (legal review) | Status |
|---|---|---|---|---|---|---|
| C1 | Account creation and authentication (email+password, magic link, Google) | all users | `auth.*` (incl. sessions with raw IP + user agent), `users` | Supabase; Google; Resend (auth emails) | contract | ACTIVE — 4 users |
| C2 | Billing the tenant | account holders | `organizations`, `org_subscriptions`, `billing_*` | Stripe | contract; legal obligation (accounts) | ACTIVE (founder-provisioned) |
| C3 | Demo requests and onboarding | prospects | `demo_requests` (+ a lead in CrewFlow's internal org) | Resend; Stripe (setup-fee link) | legitimate interests / steps prior to contract | ACTIVE — 3 rows |
| C4 | Sales prospecting and outreach | prospects (companies and named contacts) | `hq_sales_*`, `hq_communications`, `hq_comms_suppressions`; and, outside the product, the founder's own outreach tooling | Anthropic (research); Resend (approval-gated sends); Companies House (source) | legitimate interests — **PECR applies to email marketing; sole traders are "individual subscribers"** | HQ surface ACTIVE; 0 company/contact rows in prod |
| C5 | Support access ("view as tenant") | operators; tenant users | `impersonation_sessions`, cookie `cf_impersonation_session` | — | legitimate interests (support, security) | ACTIVE — 25 sessions |
| C6 | Security and abuse prevention | everyone | `rate_limit_counters`; e-signature IP hashes; Supabase Auth | — | legitimate interests | ACTIVE |
| C7 | Error and performance monitoring | everyone using the site | not in DB | Sentry (Germany) | legitimate interests | ACTIVE |
| C8 | Product analytics | consenting visitors/users | cookie `cf_cookie_consent` | PostHog (EU) | consent (PECR + UK GDPR) | ACTIVE after Accept |
| C9 | Hosting, request logs | everyone | not in DB | Vercel (functions in `dub1` Dublin since 2026-11-15 — VERIFIED `x-vercel-id: lhr1::dub1` on 2026-11-16) | legitimate interests ⚖ | ACTIVE |
| C10 | Operations audit and AI usage accounting | tenant users, operators | `activity_log`, `admin_activity_log`, `ai_invocations`, `cron_runs`, `hq_events` | — | legitimate interests | ACTIVE |
| C11 | Backups and disaster recovery | everyone in the DB | Supabase backups; encrypted archive | Backblaze B2 | legitimate interests / security obligation | ACTIVE |
| C12 | Terms-of-service acceptance record | account holders | `organizations.tos_*` | — | contract | ACTIVE |

---

## 5. Who can see what (access model, as implemented)

- **Tenant isolation:** every tenant table carries `org_id` and row-level security. The register's `access` column summarises each table's policies; the integration RLS suites are the proof.
- **Within a tenant** there are four patterns: *all members* (e.g. `signatures`); *owner/admin only* (e.g. `staff_secrets`, `payroll_tax_profiles`, `customers` writes); *the person themself + admin* (e.g. `time_entries`, own tax profile); *staff on assigned jobs* (customers, jobs and their documents — the R5 staff-isolation model). Pay and emergency contact are behind a separate compensation permission.
- **Service-role only** (no client access at all): `demo_requests`, `hq_*`, `waitlist`, `rate_limit_counters`, webhook inboxes, `job_assignments`, and the `auth` schema.
- **Bearer links** (no login): `/q/<token>` quote, `/customer-portal/<token>`, `/worker-portal/<token>`. Anyone holding the link sees that record. Customer-portal tokens can be rotated and can carry an expiry; they are stored in plaintext. Worker sign-off tokens are stored hashed.
- **CrewFlow staff:** super-admins (an email allow-list) reach the HQ console and can open a tenant workspace through a logged support-access session. Production infrastructure access (Supabase, Vercel, Stripe dashboards) is outside the codebase — NEEDS-FOUNDER (who holds it, is MFA on).
- **Storage:** all 13 buckets are private; objects are org-prefixed and served by signed URL.

---

## 6. Where personal data lands in logs and telemetry

| Sink | What lands there | Evidence | Note |
|---|---|---|---|
| Vercel function logs | `console.*` output (1,264 call sites). Mostly error objects; structured events include user ids. Postgres error text can embed a value (e.g. a duplicate email) | grep of `console.(log|info|warn|error)` | Retention is plan-dependent |
| Vercel request logs | IP, user agent, full URL — including bearer-token paths and `/login?email=…` on a failed sign-in | `app/auth/callback/route.ts` `bounceToLogin` | See G-10 |
| Sentry | errors + 10% traces; scrubbed by key name; path tokens and identifiers in free text are masked by the SECURITY workstream (`security/injection-secrets-hardening`, commits `be7140af` + `a0c26962`) — not on this branch | `lib/monitoring/scrub.ts` | Not yet deployed |
| `activity_log` | actor id + name; trigger metadata copies customer **name, email, phone** on create and name on delete | `supabase/migrations/20260518120000_customers_activity_trigger.sql` | Append-only; never purged |
| `admin_activity_log` | operator email, action, target, metadata | — | Append-only; never purged |
| `impersonation_sessions` | operator email, target user, reason, **raw IP**, user agent | `server/services/impersonation.ts` | Never purged |
| `ai_invocations` | user id, feature, model, tokens, cost, prompt **hash** | `lib/ai/governor` | No prompt/response text |
| `cron_runs` | route, timings, summary counts, error text | `lib/ops/cron-telemetry.ts` | 14/90-day prune |
| `hq_events` / `hq_timeline` | CrewFlow's internal event spine (actor ids, object ids, payload) | 90,335 rows | Internal; never purged |
| `comm_events` | email delivery events: recipient address + provider payload | 16 rows | Never purged |
| Webhook inboxes | raw provider payloads (`billing_events`, `whatsapp_webhook_events`, `email_webhook_events`, `call_events`) | — | Never purged |
| `rate_limit_counters` | was raw IP / email / portal token; now a keyed digest | commit `afdbc459` | Swept daily (branch) |
| `auth.audit_log_entries` | **0 rows** in prod | count | Supabase auth audit is not being written to the DB |

---

## 7. Browser storage and cookies (for the consent workstream)

| Item | Purpose | Type |
|---|---|---|
| Supabase auth cookies (`sb-…-auth-token`) | session | strictly necessary |
| `active_org_id` | which workspace is open | strictly necessary |
| `cf_impersonation_session` | CrewFlow support access | strictly necessary (operators only) |
| `cf_cookie_consent` | remembers Accept/Reject for 365 days | strictly necessary |
| OAuth `state` / PKCE verifier cookies | integration connect flows | strictly necessary; dormant features |
| PostHog cookie / local storage | analytics | **consent** — set only after Accept |
| `localStorage`: sidebar state, recent searches, blueprint offline identity | UI preferences | functional, first-party |
| IndexedDB: offline write queue, photo queue, read cache, blueprint store | offline working on site — **holds tenant data on the device** | functional; cleared how/when is not audited here |

---

## 8. Appendix — every table that holds personal data

Generated from `data-register.csv`. "Personal columns (direct)" are designed to hold personal data; "Other PD columns" counts user-id links, subject links, free text and blobs that *can* hold it. "Export" = included in the organisation export ZIP; "Erasure" = disposition under the (dormant) organisation erasure.
<!-- generated by tools/build_register.py output; 1077 columns, 288 tables/views, 402 'direct' columns -->


### CrewFlow lead / prospect — controller (CrewFlow's own purposes)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `demo_requests` | ACTIVE | 3 | `name`, `company`, `email`, `phone`, `user_agent` | 9 | n/a | n/a |
| `hq_comms_suppressions` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `address` | 2 | n/a | n/a |
| `hq_communications` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `to_address` | 0 | n/a | n/a |
| `hq_sales_ai_tasks` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `created_by_email` | 3 | n/a | n/a |
| `hq_sales_call_scripts` | ACTIVE (CrewFlow-internal HQ surface) | 5 | `created_by_email` | 0 | n/a | n/a |
| `hq_sales_calls` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `recording_url`, `transcript`, `created_by_email` | 7 | n/a | n/a |
| `hq_sales_channels` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `value`, `created_by_email` | 2 | n/a | n/a |
| `hq_sales_companies` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `name`, `county`, `primary_email`, `primary_phone`, `linkedin_url`, `assigned_to_email`, `created_by_email` | 5 | n/a | n/a |
| `hq_sales_contacts` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `full_name`, `title`, `seniority`, `email`, `phone`, `linkedin_url`, `created_by_email` | 2 | n/a | n/a |
| `hq_sales_external_records` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `created_by_email` | 2 | n/a | n/a |
| `hq_sales_learnings` | ACTIVE (CrewFlow-internal HQ surface) | 6 | `created_by_email` | 0 | n/a | n/a |
| `hq_sales_locations` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `address_line1`, `address_line2`, `city`, `county`, `postcode`, `phone`, `created_by_email` | 4 | n/a | n/a |
| `hq_sales_objections` | ACTIVE (CrewFlow-internal HQ surface) | 8 | `created_by_email` | 0 | n/a | n/a |
| `hq_sales_recommendations` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `authored_by_email` | 0 | n/a | n/a |
| `hq_sales_research_reports` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `authored_by_email` | 2 | n/a | n/a |
| `hq_sales_sourcing_pool` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `postcode` | 2 | n/a | n/a |
| `hq_sales_timeline_events` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `subject`, `body`, `actor_email` | 2 | n/a | n/a |
| `waitlist` | ORPHAN (no route writes it; 0 rows in prod) | 0 | `email`, `company_name`, `phone`, `user_agent`, `ip_hash` | 2 | n/a | n/a |

### CrewFlow operator (HQ staff) — controller (CrewFlow's own purposes)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `admin_activity_log` | ACTIVE (CrewFlow-internal HQ surface) | 129 | `actor_email` | 2 | n/a | n/a |
| `admin_alert_state` | ACTIVE (CrewFlow-internal HQ surface) | 12 | — | 3 | **no** | retain |
| `ai_employee_tasks` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `created_by_email` | 3 | n/a | n/a |
| `hq_ai_executor_shadow_observations` | ACTIVE (CrewFlow-internal HQ surface) | 0 | — | 2 | n/a | n/a |
| `hq_ai_schedule_runs` | ACTIVE (CrewFlow-internal HQ surface) | 0 | — | 1 | n/a | n/a |
| `hq_ai_schedules` | ACTIVE (CrewFlow-internal HQ surface) | 5 | — | 1 | n/a | n/a |
| `hq_ai_tasks` | ACTIVE (CrewFlow-internal HQ surface) | 29589 | — | 2 | n/a | n/a |
| `hq_application_records` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `approver_email` | 1 | n/a | n/a |
| `hq_apply_audit` | ACTIVE (CrewFlow-internal HQ surface) | 0 | — | 1 | n/a | n/a |
| `hq_approvals` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `reviewer_email` | 4 | n/a | n/a |
| `hq_capabilities` | ACTIVE (CrewFlow-internal HQ surface) | 71 | `created_by_email` | 2 | n/a | n/a |
| `hq_capability_grants` | ACTIVE (CrewFlow-internal HQ surface) | 44 | `created_by_email` | 1 | n/a | n/a |
| `hq_competitor_notes` | ACTIVE (CrewFlow-internal HQ surface) | 0 | — | 1 | n/a | n/a |
| `hq_decision_events` | ACTIVE (CrewFlow-internal HQ surface) | 1 | `actor_email` | 3 | n/a | n/a |
| `hq_decisions` | ACTIVE (CrewFlow-internal HQ surface) | 1 | — | 4 | n/a | n/a |
| `hq_drafts` | ACTIVE (CrewFlow-internal HQ surface) | 0 | — | 1 | n/a | n/a |
| `hq_events` | ACTIVE (CrewFlow-internal HQ surface) | 90335 | — | 1 | n/a | n/a |
| `hq_memories` | ACTIVE (CrewFlow-internal HQ surface) | 6 | `body`, `created_by_email` | 4 | n/a | n/a |
| `hq_memory_access_grants` | ACTIVE (CrewFlow-internal HQ surface) | 2 | `created_by_email` | 0 | n/a | n/a |
| `hq_memory_employee_links` | ACTIVE (CrewFlow-internal HQ surface) | 8 | `created_by_email` | 0 | n/a | n/a |
| `hq_memory_events` | ACTIVE (CrewFlow-internal HQ surface) | 8 | `actor_email` | 1 | n/a | n/a |
| `hq_memory_relationships` | ACTIVE (CrewFlow-internal HQ surface) | 3 | `created_by_email` | 0 | n/a | n/a |
| `hq_memory_versions` | ACTIVE (CrewFlow-internal HQ surface) | 8 | `body`, `edited_by_email` | 1 | n/a | n/a |
| `hq_saga_events` | ACTIVE (CrewFlow-internal HQ surface) | 41 | `actor_email` | 2 | n/a | n/a |
| `hq_settings` | ACTIVE (CrewFlow-internal HQ surface) | 1 | — | 1 | n/a | n/a |
| `hq_timeline` | ACTIVE (CrewFlow-internal HQ surface) | 90335 | — | 1 | n/a | n/a |
| `hq_workflow_sagas` | ACTIVE (CrewFlow-internal HQ surface) | 1 | — | 1 | n/a | n/a |
| `impersonation_sessions` | ACTIVE | 25 | `admin_email`, `ip_address`, `user_agent` | 3 | n/a | n/a |
| `internal_notes` | ACTIVE (CrewFlow-internal HQ surface) | 0 | `author_email`, `body` | 1 | yes | delete |

### mixed (whoever the tenant writes about) — controller (CrewFlow's own purposes)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `dead_events` | ACTIVE | 0 | — | 1 | n/a | n/a |
| `rate_limit_counters` | ACTIVE | 11 | `key` | 0 | n/a | n/a |

### tenant owner / account holder — controller (CrewFlow's own purposes)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `billing_events` | ACTIVE | 0 | — | 1 | **no** | retain |
| `billing_invoices` | ACTIVE | 0 | — | 4 | **no** | retain |
| `org_subscriptions` | ACTIVE | 0 | — | 1 | **no** | retain |
| `organizations` | ACTIVE | 2 | `name`, `vat_number`, `address`, `phone`, `email`, `bank_details`, `billing_email` | 11 | n/a | n/a |

### tenant staff / workspace user — controller (CrewFlow's own purposes)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `auth.audit_log_entries` | ACTIVE | 0 | `payload`, `ip_address` | 0 | n/a | n/a |
| `auth.flow_state` | ACTIVE | 24 | `provider_access_token`, `provider_refresh_token` | 1 | n/a | n/a |
| `auth.identities` | ACTIVE | 5 | `provider_id`, `identity_data`, `email` | 3 | n/a | n/a |
| `auth.mfa_challenges` | ACTIVE | 0 | `ip_address` | 0 | n/a | n/a |
| `auth.mfa_factors` | ACTIVE | 0 | `secret`, `phone` | 2 | n/a | n/a |
| `auth.one_time_tokens` | ACTIVE | 4 | `relates_to` | 2 | n/a | n/a |
| `auth.refresh_tokens` | ACTIVE | 24 | `token` | 1 | n/a | n/a |
| `auth.saml_relay_states` | ACTIVE | 0 | `for_email` | 0 | n/a | n/a |
| `auth.sessions` | ACTIVE | 9 | `user_agent`, `ip` | 2 | n/a | n/a |
| `auth.users` | ACTIVE | 4 | `email`, `encrypted_password`, `email_change`, `raw_user_meta_data`, `phone`, `phone_change` | 6 | n/a | n/a |
| `auth.webauthn_credentials` | ACTIVE | 0 | — | 2 | n/a | n/a |
| `ai_budget_control_audit` | ACTIVE | 0 | `changed_by_email` | 3 | **no** | retain |
| `ai_cost_reservations` | ACTIVE | 613 | — | 1 | **no** | retain |
| `ai_employee_budget_limits` | ACTIVE | 0 | — | 3 | **no** | retain |
| `ai_invocations` | ACTIVE | 580 | — | 2 | **no** | anonymise |
| `ai_org_budget_ceilings` | ACTIVE | 0 | — | 2 | **no** | retain |
| `mfa_recovery_codes` | ACTIVE | 0 | — | 2 | n/a | n/a |

### tenant staff / workspace user — controller for account/auth; processor for tenant-entered staff data

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `memberships` | ACTIVE | 2 | `role` | 1 | yes | delete |
| `users` | ACTIVE | 4 | `email`, `full_name`, `phone`, `avatar_url`, `employment_type`, `start_date` | 0 | n/a | n/a |

### external worker / site visitor / witness — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `inspection_signoffs` | ACTIVE | 0 | `signed_name`, `witness_name`, `witness_organisation` | 4 | yes | delete |
| `inspection_witness_invitations` | ACTIVE | 0 | `witness_name`, `witness_organisation`, `witness_email` | 2 | yes | delete |
| `site_inductions` | ACTIVE | 0 | `person_name`, `person_company`, `inducted_at`, `signed_name`, `signature_image_path`, `ip_hash`, `user_agent` | 3 | yes | delete |
| `site_visitors` | ACTIVE | 0 | `visitor_name`, `company`, `vehicle_registration`, `signed_in_at`, `signed_out_at` | 4 | yes | delete |
| `worker_acknowledgements` | ACTIVE | 0 | `acknowledged_at`, `signed_name`, `signature_image_path`, `ip_hash`, `user_agent` | 1 | yes | delete |
| `worker_signoff_tokens` | ACTIVE | 0 | `worker_name`, `worker_company` | 3 | **no** | delete |

### member of the public contacting a tenant — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `ai_reply_audits` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `draft`, `safe_text` | 3 | **no** | anonymise |
| `ai_reply_delivery_receipts` | DORMANT (no inbound channel live) | 0 | — | 1 | **no** | delete |
| `ai_reply_lifecycle *(view)*` | DORMANT (no inbound channel live) |  | `customer_ref`, `draft`, `safe_text`, `to_ref` | 1 | n/a | n/a |
| `ai_reply_transports` | DORMANT (no inbound channel live) | 0 | `to_ref` | 1 | **no** | delete |
| `call_events` | DORMANT (NEXT_PUBLIC_FEATURE_VOICE_INBOUND + Twilio/voice provider … | 0 | — | 1 | yes | delete |
| `calls` | DORMANT (NEXT_PUBLIC_FEATURE_VOICE_INBOUND + Twilio/voice provider … | 0 | `caller_number`, `receiver_number`, `recording_url`, `transcript`, `transcript_json`, `ai_extracted` | 2 | yes | delete |
| `conversations` | DORMANT (no inbound channel live: voice/SMS/inbound-email dormant; … | 0 | `contact_ref`, `contact_name` | 3 | yes | delete |
| `email_webhook_events` | DORMANT (NEXT_PUBLIC_FEATURE_INBOUND_EMAIL + INBOUND_EMAIL_WEBHOOK_… | 0 | `from_address`, `to_address` | 1 | **no** | delete |
| `inbound_enquiries` | DORMANT (no inbound channel live: voice/SMS/inbound-email dormant; … | 0 | `raw_text`, `caller`, `postcode` | 4 | yes | delete |
| `messages` | DORMANT (no inbound channel live: voice/SMS/inbound-email dormant; … | 0 | `from_addr`, `to_addr`, `body`, `media_urls` | 1 | yes | delete |
| `missed_call_textbacks` | DORMANT (NEXT_PUBLIC_FEATURE_VOICE_INBOUND + Twilio/voice provider … | 0 | `caller_number` | 0 | yes | delete |
| `phone_numbers` | DORMANT (NEXT_PUBLIC_FEATURE_VOICE_INBOUND + Twilio/voice provider … | 0 | — | 4 | **no** | delete |
| `receptionist_conversation_actions` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_authorisations` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_claim_reassignments` | DORMANT (no inbound channel live) | 0 | `from_operator_email`, `to_operator_email` | 3 | yes | delete |
| `receptionist_conversation_claim_releases` | DORMANT (no inbound channel live) | 0 | `operator_email` | 2 | yes | delete |
| `receptionist_conversation_claims` | DORMANT (no inbound channel live) | 0 | `operator_email` | 2 | yes | delete |
| `receptionist_conversation_coordinations` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_executions` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_fulfilments` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_lifecycles` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_list *(view)*` | DORMANT (no inbound channel live) |  | `contact_ref`, `contact_name` | 1 | n/a | n/a |
| `receptionist_conversation_orchestrations` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_outcomes` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_recoveries` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_resolutions` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversation_timeline *(view)*` | DORMANT (no inbound channel live) |  | `inbound_text`, `outbound_draft` | 0 | n/a | n/a |
| `receptionist_conversation_verifications` | DORMANT (no inbound channel live) | 0 | `customer_ref`, `postcode`, `phone_number` | 2 | yes | delete |
| `receptionist_conversations` | DORMANT (no inbound channel live) | 0 | `contact_ref`, `contact_name` | 3 | yes | delete |
| `receptionist_coordination_read_model *(view)*` | DORMANT (no inbound channel live) |  | `customer_ref`, `postcode`, `phone_number` | 1 | n/a | n/a |
| `receptionist_review_queue *(view)*` | DORMANT (no inbound channel live) |  | `customer_ref`, `draft`, `safe_text`, `contact_ref`, `contact_name`, `resolved_by_email` | 7 | n/a | n/a |
| `receptionist_review_resolutions` | DORMANT (no inbound channel live) | 0 | `resolved_by_email` | 2 | yes | delete |
| `whatsapp_assistant_actions` | ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present… | 0 | — | 3 | yes | delete |
| `whatsapp_inbound_media` | ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present… | 0 | `caption`, `transcript` | 2 | yes | delete |
| `whatsapp_number_routes` | ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present… | 1 | — | 1 | **no** | delete |
| `whatsapp_optouts` | ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present… | 0 | `wa_id` | 0 | yes | delete |
| `whatsapp_webhook_events` | ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present… | 1 | — | 1 | **no** | delete |

### mixed (whoever the tenant writes about) — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `activity_log` | ACTIVE | 651 | `actor_name` | 2 | yes | anonymise |
| `automation_approvals` | ACTIVE | 0 | — | 5 | **no** | delete |
| `automation_custom_rules` | ACTIVE | 0 | — | 2 | yes | delete |
| `automation_runs` | ACTIVE | 2 | — | 1 | **no** | delete |
| `bank_statement_lines` | ACTIVE | 0 | `description`, `reference` | 0 | yes | anonymise |
| `bank_statements` | ACTIVE | 0 | — | 3 | yes | anonymise |
| `blueprint_markup` | ACTIVE | 0 | — | 3 | yes | delete |
| `blueprint_pin_comments` | ACTIVE | 0 | `body` | 1 | yes | delete |
| `blueprint_pins` | ACTIVE | 0 | — | 3 | yes | delete |
| `blueprint_versions` | ACTIVE | 0 | — | 4 | yes | delete |
| `blueprints` | ACTIVE | 0 | — | 2 | yes | delete |
| `comm_events` | ACTIVE | 16 | `recipient` | 1 | yes | delete |
| `compliance_documents` | ACTIVE | 0 | — | 4 | yes | delete |
| `form_import_drafts` | ACTIVE | 0 | — | 5 | yes | delete |
| `import_files` | ACTIVE | 7 | — | 2 | yes | delete |
| `import_rows` | ACTIVE | 1803 | `raw`, `mapped` | 0 | **no** | delete |
| `imports` | ACTIVE | 5 | — | 1 | yes | delete |
| `portal_uploads` | ACTIVE | 0 | — | 4 | yes | delete |
| `tenant_attachments` | ACTIVE | 0 | — | 3 | yes | delete |
| `tenant_search_documents` | ACTIVE | 503 | `content` | 1 | **no** | delete |
| `storage.objects` | ACTIVE | 7 | `name` | 4 | n/a | n/a |

### tenant owner / account holder — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `accounting_connections` | DORMANT (FEATURE_ACCOUNTING_CONNECT; CSV export is active) | 0 | — | 4 | **no** | delete |
| `accounting_export_log` | DORMANT (FEATURE_ACCOUNTING_CONNECT; CSV export is active) | 0 | — | 2 | yes | retain |
| `accounting_pushed_entities` | DORMANT (FEATURE_ACCOUNTING_CONNECT; CSV export is active) | 0 | — | 1 | **no** | retain |
| `ai_receptionist_setups` | ACTIVE | 2 | `business_phone`, `whatsapp_number`, `staff_numbers`, `fallback_number`, `urgent_escalation_number`, `notify_email`, `notify_sms` | 4 | yes | delete |
| `api_keys` | DORMANT (public API: 0 keys issued in prod) | 0 | — | 2 | **no** | delete |
| `bank_connections` | DORMANT (NEXT_PUBLIC_FEATURE_BANKING_CONNECT) | 0 | — | 3 | **no** | delete |
| `gdpr_erasure_log` | ACTIVE | 0 | — | 2 | yes | retain |
| `gdpr_export_log` | ACTIVE | 0 | — | 2 | yes | retain |
| `hmrc_connections` | DORMANT (NEXT_PUBLIC_FEATURE_HMRC_CONNECT) | 0 | `hmrc_vrn`, `gov_client_ids` | 3 | **no** | delete |
| `hmrc_submissions` | DORMANT (NEXT_PUBLIC_FEATURE_HMRC_CONNECT) | 0 | — | 3 | yes | anonymise |
| `marketplace_installs` | DORMANT (FEATURE_MARKETPLACE) | 0 | — | 1 | yes | delete |
| `marketplace_listings` | DORMANT (FEATURE_MARKETPLACE) | 0 | — | 3 | n/a | n/a |
| `marketplace_partners` | DORMANT (FEATURE_MARKETPLACE) | 0 | `contact_email` | 1 | yes | delete |
| `merchant_connections` | DORMANT (NEXT_PUBLIC_FEATURE_MERCHANTS) | 0 | — | 2 | **no** | delete |
| `merchant_po_submissions` | DORMANT (NEXT_PUBLIC_FEATURE_MERCHANTS) | 0 | — | 1 | yes | delete |
| `retention_policies` | ACTIVE | 0 | — | 1 | **no** | delete |
| `retention_purge_log` | ACTIVE | 0 | — | 1 | **no** | retain |
| `webhook_deliveries` | DORMANT (NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS) | 0 | — | 1 | **no** | delete |
| `webhook_endpoints` | DORMANT (NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS) | 0 | — | 2 | **no** | delete |

### tenant staff / workspace user — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `asset_assignments` | ACTIVE | 0 | — | 5 | yes | delete |
| `asset_calibration_certificates` | ACTIVE | 0 | — | 2 | yes | delete |
| `asset_depreciation_settings` | ACTIVE | 0 | — | 2 | yes | delete |
| `asset_fuel_logs` | ACTIVE | 0 | — | 5 | yes | delete |
| `asset_inspection_overrides` | ACTIVE | 0 | — | 4 | yes | delete |
| `asset_inspection_schedules` | ACTIVE | 0 | — | 1 | yes | delete |
| `asset_inspection_templates` | ACTIVE | 0 | — | 2 | yes | delete |
| `asset_inspections` | ACTIVE | 0 | — | 4 | yes | delete |
| `asset_maintenance_case_costs` | ACTIVE | 0 | — | 2 | yes | delete |
| `asset_maintenance_cases` | ACTIVE | 0 | — | 7 | yes | delete |
| `asset_qr_identities` | ACTIVE | 0 | — | 4 | **no** | delete |
| `asset_service_schedules` | ACTIVE | 0 | — | 2 | yes | delete |
| `assets` | ACTIVE | 1 | — | 4 | yes | delete |
| `automation_rules` | ACTIVE | 0 | — | 1 | yes | delete |
| `automation_schedules` | ACTIVE | 0 | — | 1 | yes | delete |
| `automation_workflow_versions` | ACTIVE | 0 | — | 2 | yes | delete |
| `briefing_dismissals` | ACTIVE | 0 | — | 1 | yes | delete |
| `calendar_connections` | DORMANT (FEATURE_CALENDAR_CONNECT) | 0 | `external_account_id` | 3 | **no** | delete |
| `calendar_pulled_events` | DORMANT (FEATURE_CALENDAR_CONNECT) | 0 | `summary`, `location`, `starts_at`, `ends_at` | 0 | **no** | delete |
| `calendar_watch_channels` | DORMANT (FEATURE_CALENDAR_CONNECT) | 0 | — | 1 | **no** | delete |
| `fleet_vehicles` | ACTIVE | 0 | — | 2 | yes | delete |
| `holiday_entitlements` | ACTIVE | 0 | `annual_allowance_days` | 2 | yes | anonymise |
| `inspection_plan_templates` | ACTIVE | 0 | — | 2 | yes | delete |
| `inspection_test_plans` | ACTIVE | 0 | — | 4 | yes | delete |
| `job_assignments` | ACTIVE | 1 | — | 2 | yes (svc) | delete |
| `job_templates` | ACTIVE | 0 | — | 1 | yes | delete |
| `leave_requests` | ACTIVE | 0 | `type`, `starts_at`, `ends_at` | 5 | yes | delete |
| `membership_permissions` | ACTIVE | 0 | — | 2 | **no** | delete |
| `ncr_corrective_actions` | ACTIVE | 0 | — | 6 | yes | delete |
| `non_conformance_reports` | ACTIVE | 0 | `responsible_subcontractor` | 5 | yes | delete |
| `notification_digest_cursors` | ACTIVE | 0 | — | 1 | **no** | delete |
| `notification_email_queue` | ACTIVE | 14 | `to_email`, `reply_to_email`, `body_text`, `body_html` | 1 | **no** | delete |
| `notification_preferences` | ACTIVE | 0 | — | 1 | yes | delete |
| `notifications` | ACTIVE | 89 | `body` | 2 | yes | delete |
| `org_scim_config` | DORMANT (FEATURE_ENTERPRISE_SSO) | 0 | — | 2 | **no** | delete |
| `org_sso_config` | DORMANT (FEATURE_ENTERPRISE_SSO) | 0 | — | 2 | **no** | delete |
| `payroll_line_adjustments` | ACTIVE | 0 | `old_overtime_hours`, `new_overtime_hours`, `old_gross_pay`, `new_gross_pay` | 1 | yes | anonymise |
| `payroll_lines` | ACTIVE | 0 | `hours`, `hourly_pay`, `gross_pay`, `paye_estimate`, `ni_estimate`, `net_pay`, `overtime_hours`, `overtime_multiplier`, `overtime_pay`, `leave_hours`, `leave_pay` | 2 | yes | anonymise |
| `payroll_runs` | ACTIVE | 1 | — | 1 | yes | anonymise |
| `payroll_tax_profiles` | ACTIVE | 0 | `tax_region`, `student_loan_plan`, `salary_sacrifice_annual_pence`, `ni_category`, `date_of_birth`, `standard_hours_per_day` | 1 | yes | anonymise |
| `pension_enrolments` | ACTIVE | 0 | `status`, `employee_contribution_rate`, `employer_contribution_rate`, `scheme_name`, `assessment_date`, `enrolment_date`, `opt_out_date`, `postponement_end_date` | 1 | yes | anonymise |
| `permission_audit` | ACTIVE | 0 | — | 2 | **no** | delete |
| `permit_conditions` | ACTIVE | 0 | — | 2 | yes | delete |
| `permits_to_work` | ACTIVE | 0 | `responsible_person` | 3 | yes | delete |
| `price_book_items` | ACTIVE | 0 | — | 1 | yes | delete |
| `push_deliveries` | DORMANT (Web Push: VAPID keys; 0 subscriptions in prod) | 0 | — | 1 | **no** | delete |
| `push_subscriptions` | DORMANT (Web Push: VAPID keys; 0 subscriptions in prod) | 0 | `endpoint`, `user_agent` | 3 | **no** | delete |
| `quote_templates` | ACTIVE | 0 | — | 2 | yes | delete |
| `report_subscriptions` | ACTIVE | 0 | `recipients` | 1 | yes | delete |
| `risk_assessment_hazards` | ACTIVE | 8 | — | 1 | yes | delete |
| `risk_assessments` | ACTIVE | 2 | — | 3 | yes | delete |
| `rota_entries` | ACTIVE | 1 | `starts_at`, `ends_at` | 3 | yes | delete |
| `safety_acknowledgements` | ACTIVE | 0 | `acknowledged_at`, `signed_name`, `signature_image_path`, `ip_hash`, `user_agent` | 2 | yes | delete |
| `sites` | ACTIVE | 0 | `address_line1`, `address_line2`, `city`, `county`, `postcode` | 2 | yes | delete |
| `sms_deliveries` | DORMANT (Twilio credentials absent) | 0 | `to_phone` | 1 | **no** | delete |
| `sso_provisioning_audit` | DORMANT (FEATURE_ENTERPRISE_SSO) | 0 | `subject` | 1 | **no** | delete |
| `staff_compensation` | ACTIVE | 0 | `hourly_pay`, `emergency_contact` | 2 | n/a | n/a |
| `staff_qualifications` | ACTIVE | 0 | `qualification_type`, `title`, `reference_no`, `issued_on`, `expires_on`, `document_path` | 4 | yes | delete |
| `staff_secrets` | ACTIVE | 0 | `ni_number` | 2 | **no** | delete |
| `stock_items` | ACTIVE | 0 | — | 2 | yes | delete |
| `stock_movements` | ACTIVE | 0 | — | 2 | yes | delete |
| `stock_movements_operational *(view)*` | ACTIVE |  | — | 2 | n/a | n/a |
| `stocktake_lines` | ACTIVE | 0 | — | 1 | yes | delete |
| `stocktake_sessions` | ACTIVE | 0 | — | 4 | yes | delete |
| `telematics_connections` | DORMANT (NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT) | 0 | — | 3 | **no** | delete |
| `telematics_readings` | DORMANT (NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT) | 0 | `recorded_at`, `latitude`, `longitude` | 0 | yes | delete |
| `time_entries` | ACTIVE | 0 | `started_at`, `ended_at`, `breaks`, `gps_lat`, `gps_lng` | 2 | yes | delete |
| `toolbox_talks` | ACTIVE | 0 | `presenter`, `attendees` | 5 | yes | delete |
| `voice_notes` | DORMANT (no capture surface: microphone denied by Permissions-Polic… | 0 | `audio_url`, `transcript` | 3 | yes | delete |
| `weather_watches` | ACTIVE | 2 | — | 1 | yes | delete |

### tenant's customer (end-customer) — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `ai_quote_drafts` | ACTIVE | 0 | — | 5 | yes | delete |
| `completion_certificates` | ACTIVE | 0 | `content`, `snapshot` | 4 | yes | delete |
| `customer_contacts` | ACTIVE | 0 | `name`, `email`, `phone`, `role` | 5 | yes | delete |
| `customer_portal_preferences` | ACTIVE | 0 | `preferred_channel`, `contact_notes` | 1 | yes | delete |
| `customers` | ACTIVE | 602 | `name`, `email`, `phone`, `address_line1`, `address_line2`, `city`, `county`, `postcode`, `country`, `company_number`, `vat_number`, `phone_normalized` +1 | 6 | yes | delete |
| `delay_events` | ACTIVE | 0 | — | 4 | yes | delete |
| `invoice_line_items` | ACTIVE | 2 | — | 1 | yes | anonymise |
| `invoice_payment_intents` | DORMANT (NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS + Stripe Connect) | 0 | — | 1 | yes | anonymise |
| `invoice_payments` | ACTIVE | 0 | — | 2 | yes | anonymise |
| `invoice_reminders` | ACTIVE | 4 | `recipient` | 0 | yes | delete |
| `invoices` | ACTIVE | 1 | — | 4 | yes | anonymise |
| `job_billing_plans` | ACTIVE | 0 | — | 2 | yes | anonymise |
| `job_billing_stages` | ACTIVE | 0 | — | 1 | yes | anonymise |
| `job_budgets` | ACTIVE | 1 | — | 2 | yes | delete |
| `job_checklists` | ACTIVE | 0 | — | 3 | yes | delete |
| `job_document_versions` | ACTIVE | 0 | `form_data` | 3 | yes | delete |
| `job_documents` | ACTIVE | 0 | — | 4 | yes | delete |
| `job_milestone_dependencies` | ACTIVE | 0 | — | 1 | yes | delete |
| `job_programme_baselines` | ACTIVE | 0 | — | 2 | yes | delete |
| `job_progress_observations` | ACTIVE | 0 | — | 2 | yes | delete |
| `job_valuation_variations` | ACTIVE | 0 | — | 1 | yes | anonymise |
| `job_valuations` | ACTIVE | 0 | — | 3 | yes | anonymise |
| `job_warranties` | ACTIVE | 0 | — | 5 | yes | delete |
| `jobs` | ACTIVE | 4 | `site_address_line1`, `site_address_line2`, `site_city`, `site_county`, `site_postcode`, `site_country` | 7 | yes | delete |
| `org_payment_connections` | DORMANT (NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS + Stripe Connect) | 0 | — | 3 | **no** | delete |
| `payments` | ACTIVE | 0 | — | 5 | yes | anonymise |
| `properties` | ACTIVE | 0 | `address` | 2 | yes | delete |
| `quote_line_items` | ACTIVE | 13 | — | 1 | yes | delete |
| `quote_versions` | ACTIVE | 3 | — | 1 | yes | delete |
| `quotes` | ACTIVE | 5 | `accept_signature`, `customer_comment` | 9 | yes | delete |
| `retention_releases` | ACTIVE | 0 | — | 2 | yes | anonymise |
| `review_requests` | ACTIVE | 0 | — | 3 | yes | delete |
| `service_booking_slots` | ACTIVE | 0 | — | 1 | yes | delete |
| `service_bookings` | ACTIVE | 0 | `contact_name`, `contact_email`, `contact_phone` | 2 | yes | delete |
| `signatures` | ACTIVE | 1 | `signer_name`, `signer_email`, `signature_text`, `ip_address`, `user_agent`, `signature_image_path` | 1 | yes | delete |
| `site_diary_entries` | ACTIVE | 0 | — | 4 | yes | delete |
| `site_reports` | ACTIVE | 0 | `content`, `snapshot` | 5 | yes | delete |
| `snags` | ACTIVE | 0 | — | 3 | yes | delete |
| `support_messages` | ACTIVE | 0 | `body` | 1 | yes | delete |
| `support_tickets` | ACTIVE | 0 | — | 3 | yes | delete |
| `variation_requests` | ACTIVE | 0 | `requester_name` | 5 | yes | delete |

### tenant's lead / enquirer — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `lead_followup_state` | ACTIVE | 1 | — | 2 | yes | delete |
| `leads` | ACTIVE | 1 | `service`, `postcode`, `preferred_callback_at`, `contact_name`, `contact_email`, `contact_phone` | 11 | yes | delete |

### tenant's supplier / subcontractor — processor (tenant is controller)

| Table | Status | Prod rows | Personal columns (direct) | Other PD columns | Export | Erasure |
|---|---|---|---|---|---|---|
| `cis_bill_details` | ACTIVE | 0 | — | 4 | yes | anonymise |
| `cis_contractor_profiles` | ACTIVE | 0 | `legal_name`, `employer_paye_reference`, `accounts_office_reference`, `contractor_utr` | 2 | yes | anonymise |
| `cis_monthly_return_lines` | ACTIVE | 0 | `subcontractor_name`, `subcontractor_utr_masked`, `verification_number`, `gross_amount`, `deduction_amount` | 1 | yes | anonymise |
| `cis_monthly_returns` | ACTIVE | 0 | `contractor_name`, `contractor_paye_reference`, `accounts_office_reference` | 3 | yes | anonymise |
| `cis_payment_snapshots` | ACTIVE | 0 | `verification_reference`, `legal_name`, `utr_masked`, `cis_gross_payment`, `cis_deduction` | 1 | yes | anonymise |
| `cis_statement_payments` | ACTIVE | 0 | — | 1 | yes | anonymise |
| `cis_statements` | ACTIVE | 0 | `contractor_name`, `contractor_paye_reference`, `subcontractor_name`, `subcontractor_utr_masked`, `verification_number`, `gross_amount`, `deduction_amount` | 5 | yes | anonymise |
| `cis_subcontractors` | ACTIVE | 0 | `legal_name`, `trading_name`, `company_number`, `utr`, `subcontractor_type`, `vat_number`, `cis_status`, `deduction_rate`, `verification_reference` | 5 | yes | anonymise |
| `expense_budgets` | ACTIVE | 0 | — | 2 | yes | delete |
| `expense_drafts` | ACTIVE | 0 | — | 4 | yes | delete |
| `finances` | ACTIVE | 0 | — | 3 | yes | anonymise |
| `goods_received_lines` | ACTIVE | 0 | — | 1 | yes | anonymise |
| `goods_received_notes` | ACTIVE | 0 | — | 6 | yes | anonymise |
| `material_request_lines` | ACTIVE | 0 | — | 1 | yes | delete |
| `material_requests` | ACTIVE | 0 | — | 5 | yes | delete |
| `purchase_order_line_items` | ACTIVE | 0 | — | 1 | yes | anonymise |
| `purchase_orders` | ACTIVE | 0 | — | 3 | yes | anonymise |
| `supplier_payment_allocations` | ACTIVE | 0 | — | 2 | yes | anonymise |
| `supplier_payments` | ACTIVE | 0 | — | 8 | yes | anonymise |
| `suppliers` | ACTIVE | 0 | `name`, `phone`, `email` | 2 | yes | anonymise |
