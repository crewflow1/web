# CrewFlow — Data Processing Agreement (DRAFT, 2026-11-16)

**Status: draft for founder and legal review. Not published, not signed, not legal advice.** Written by an engineer from the code, the database catalogue and the existing privacy register. Every fact only the founder can supply is `[FOUNDER: …]`; every legal judgement is `[LEGAL REVIEW: …]`. Nothing here may be offered to a customer until both kinds of marker are resolved.

Evidence base: `DATA-PROCESSING-REGISTER.md`, `DATA-FLOW-MAP.md` (main `d24295e8`), `PROVIDER-REGISTER.md`, `RETENTION-SCHEDULE.md`, `COMPLIANCE-GAPS.md`. Controls are labelled **[LIVE]** (on production main), **[PENDING: PR]** (built, in an unreleased PR) or **[FOUNDER/OPS]** (a setting or practice that code cannot show).

---

## 0. Parties and structure

- **Processor:** `[FOUNDER: F-1 full legal name]`, `[FOUNDER: F-3 legal form, company number, place of registration]`, registered office `[FOUNDER: F-2]`, trading as CrewFlow ("**CrewFlow**"). ICO registration `[FOUNDER: F-4]`. Contact for data protection matters: `[FOUNDER: F-5 privacy contact; DPO yes/no]`.
- **Controller:** the company that holds the CrewFlow workspace and accepted the CrewFlow terms (the "**Customer**"), identified in the order or onboarding record `[FOUNDER: how the Customer is named — onboarding record / order form / signature block]`.
- This agreement forms part of the CrewFlow terms of service (the "**Terms**"). `[LEGAL REVIEW: how it is incorporated and accepted — click-through alongside `organizations.tos_*` acceptance, or signed; order of precedence between the Terms and this DPA.]`
- "UK GDPR", "personal data", "controller", "processor", "data subject", "personal data breach" have the meaning in the UK GDPR and the Data Protection Act 2018.

### 0.1 Two roles — what this agreement does and does not cover

| | CrewFlow as **processor** (this DPA applies) | CrewFlow as **controller** (this DPA does not apply) |
|---|---|---|
| Data | Everything the Customer and its users enter or upload into the workspace about the Customer's own customers, leads, staff, subcontractors, suppliers and site visitors; files; H&S records; payroll estimates | The Customer's account holders' login identity and sessions; CrewFlow's billing of the Customer (name, email, invoices, Stripe records, cancellation ledger); demo requests and sales prospects; support-access and security logs; service telemetry (error monitoring, AI usage ledger); website analytics |
| Notice | The Customer's own privacy notice | CrewFlow's privacy notice (`PRIVACY-POLICY-DRAFT.md`) |

`[LEGAL REVIEW: one person (a Customer's staff member) can fall in both columns — their account is CrewFlow-controlled, their employment record is Customer-controlled. Confirm the split, and the position on telemetry about tenant users (register §1).]`

---

## 1. Subject matter, duration, nature and purpose (Art. 28(3))

1. **Subject matter.** CrewFlow provides a cloud construction-business management service (customers and leads, quotes and e-signature, jobs and scheduling, site records, invoicing, timesheets and payroll estimates, CIS and supplier records, health and safety records, file storage, staff access and notifications, AI-assisted drafting, data import and export). CrewFlow processes the Customer's personal data only to provide that service.
2. **Duration.** From the Customer's acceptance of the Terms until the service ends **and** CrewFlow has deleted or returned the Customer's personal data under clause 10. `[LEGAL REVIEW: PD-1 — see clause 10; the end date of processing depends on it.]`
3. **Nature of processing.** Hosting and storage; retrieval and display to authorised users; generation of documents (PDF, CSV, ZIP export); transmission of emails and, where enabled by the Customer, other messages on the Customer's behalf; AI-assisted drafting and extraction (clause 7.4); backup and restoration; support access when the Customer asks for help (clause 6.5).
4. **Purpose.** Providing, securing, supporting and backing up the service to the Customer, on the Customer's documented instructions (clause 3).
5. **Types of personal data and data subjects** — Annex 1.

---

## 2. Roles and the Customer's responsibilities

1. For the personal data in clause 0.1 (left column), the Customer is the controller and CrewFlow is the processor.
2. The Customer is responsible for having a lawful basis and giving any required notices to its own data subjects (including its employees and its customers) for the data it puts into the service, and for the accuracy of that data.
3. The Customer decides what it enters. The service is **not designed** for special-category data or criminal-offence data and has no field that asks for it, but free-text fields (site diaries, leave reasons, notes) and uploaded files can contain it. The Customer must not upload special-category data it has no need to hold. `[LEGAL REVIEW: acceptable-use wording; Art. 9 / Art. 10 conditions are the Customer's.]`
4. The Customer must not enter or upload personal data of children as customers. A Customer that records workers under 18 (apprentices) does so as controller. `[FOUNDER: F-23 expected under-18 workers.]`

---

## 3. Processor obligations (Art. 28(3)(a)–(h))

| Art. 28(3) | Obligation | Where met |
|---|---|---|
| **(a)** | Process only on the Customer's documented instructions, including on transfers; tell the Customer if an instruction would infringe data-protection law | Clause 3.1–3.3 |
| **(b)** | Persons authorised to process are under confidentiality | Clause 4 |
| **(c)** | Appropriate security (Art. 32) | Clause 5 and Annex 2 |
| **(d)** | Conditions for sub-processors | Clause 6 and `SUBPROCESSORS.md` |
| **(e)** | Assist with data-subject requests | Clause 8 |
| **(f)** | Assist with security, breach notification, DPIAs and prior consultation | Clauses 9 and 11 |
| **(g)** | Delete or return all personal data at the end of the service, at the Customer's choice | Clause 10 |
| **(h)** | Make available information to show compliance; allow audits | Clause 12 |

### Clause 3 — Instructions
3.1 The Terms, this DPA, the Customer's configuration of the service and the actions of its authorised users are the Customer's documented instructions. CrewFlow will not process the personal data for its own purposes, except where UK law requires it (in which case CrewFlow tells the Customer first unless the law forbids it).
3.2 CrewFlow will tell the Customer without undue delay if, in its opinion, an instruction infringes data-protection law.
3.3 Further instructions must be given in writing to `[FOUNDER: privacy contact address]` and may be refused if they cannot be met within the service as built.
3.4 CrewFlow does not sell personal data, and does not use customer content to train its own models. `[FOUNDER: confirm — and F-10: confirm the same is contractually true for Anthropic/OpenAI before keeping this sentence about providers; see clause 7.4.]`

### Clause 4 — Confidentiality
CrewFlow's personnel who can access the personal data `[FOUNDER: F-12 — who holds administrator access to the Supabase, Vercel, Stripe, Resend, Sentry, PostHog, Backblaze and DNS accounts; is MFA enforced on each]` are bound by a duty of confidentiality `[FOUNDER: contract/NDA position for the founder and any contractors]`. Access to a Customer's workspace by CrewFlow operators is by a logged support-access session only (clause 6.5).

### Clause 5 — Security
5.1 CrewFlow implements the technical and organisational measures in Annex 2, appropriate to the risk, and will not materially reduce them during the term.
5.2 `[LEGAL REVIEW: whether to commit to named certifications — none is held or claimed (F-22).]`

---

## 6. Sub-processors and transfers

6.1 **General authorisation.** The Customer gives CrewFlow general written authorisation to use the sub-processors listed in `SUBPROCESSORS.md` (the "**Sub-processor List**") on the date the Customer accepts this DPA.
6.2 **Notice of changes.** CrewFlow will tell the Customer of any intended addition or replacement of a sub-processor, at least `[FOUNDER: notice period — suggest 30 days]` before it starts processing the Customer's personal data, by email to the account owner(s) and by updating the Sub-processor List. The Customer may object on reasonable data-protection grounds within `[FOUNDER: objection period]`; if the parties cannot resolve it, the Customer may terminate the affected service without penalty `[LEGAL REVIEW: remedy for an unresolved objection; the existing Terms refund clause "Changes to these terms" must stay consistent]`. `[PENDING: no notification mechanism is built; the owner-email queue exists. A guard that fails the build when a provider SDK is added without a register entry is proposed in COMPLIANCE-GAPS G-3.]`
6.3 **Flow-down.** CrewFlow imposes on each sub-processor data-protection terms no less protective than this DPA in all material respects `[FOUNDER: F-9(a) — is a DPA signed or accepted with each provider; not established]`, and remains liable to the Customer for its sub-processors' performance `[LEGAL REVIEW: liability wording and cap]`.
6.4 **International transfers.**
- Application code runs in Vercel **Dublin (`dub1`)** and the database and file storage are in Supabase **Ireland (`eu-west-1`)**; the edge network serves from London. **[LIVE]** — verified from response headers on 2026-11-16 (before 2026-11-15 functions ran in the USA; that has been corrected).
- **Processing in the United States** (per `DATA-FLOW-MAP.md`): **Anthropic** (AI prompts that may include lead text, receipt/document images and imported files — active); **OpenAI** (embeddings of CrewFlow's own HQ memory only today; tenant search embeddings and transcription are dormant); **Meta WhatsApp Cloud API** (armed, no known traffic; USA/global); **Twilio / Vapi** (dormant). Several EU/UK-region sub-processors are owned by US companies (Supabase Inc., Vercel Inc., Functional Software Inc. (Sentry)) whose support or operations staff may access data from outside the UK `[LEGAL REVIEW]`. Regions of **Resend, Stripe, Backblaze B2 and Vercel KV/Upstash** are not established `[FOUNDER: F-9(b)]`.
- Mechanism for each restricted transfer: `[FOUNDER: F-9(c) per provider — UK Addendum to the EU SCCs / IDTA / UK–US Data Bridge participation]` `[LEGAL REVIEW: confirm the mechanism and complete a transfer risk assessment where one is required.]`
- CrewFlow will not transfer the personal data outside the UK except to the countries and under the mechanisms recorded in the Sub-processor List or as the Customer instructs.

6.5 **CrewFlow operator access.** CrewFlow operators can open a Customer's workspace only through a logged support-access session (`impersonation_sessions`; raw IP and user agent recorded). **[LIVE]** `[FOUNDER: F-6 basis/LIA; PD-13 log retention.]`

---

## 7. Specific processing the Customer should know about

7.1 **Telemetry about the Customer's users** (error reports, AI usage ledger, cron logs) is controller processing by CrewFlow (clause 0.1).
7.2 **Email.** Quotes, invoices, statements, reminders and notifications are sent through Resend, including recipient address, subject, body and PDF attachments. Resend logs expire on the provider plan's retention `[FOUNDER: F-16]`. No API exists to delete a sent message. **[LIVE]**
7.3 **Backups.** Supabase daily managed backups (stated ~7 days `[FOUNDER: F-16 confirm]`; point-in-time recovery is off) and a weekly encrypted off-platform archive of the whole database, auth data and files, AES-256 encrypted before upload to Backblaze B2 (last 8 archives, ~8 weeks). **[LIVE]** Data deleted from live systems therefore persists in backups until they age out (clause 10.5). The backup operator's machine also keeps plaintext dated copies (COMPLIANCE-GAPS G-6) `[FOUNDER: F-18 / PD-7 — this must be resolved or disclosed before this DPA is offered]`.
7.4 **AI features.** Where the Customer's users invoke AI features (lead summary, quote-writer draft, site-manager answers, insights narratives, receipt extraction, import OCR, document form-autofill), the relevant content is sent to **Anthropic** (USA) to generate a draft for a person to review. Nothing is sent or decided automatically; CrewFlow stores a hash and a cost record, not the prompt. **[LIVE]** The provider's retention period, training-use position and zero-data-retention availability are `[FOUNDER: F-10 — from the terms actually accepted]`. There is **no per-company switch to turn AI off today** (G-13) `[FOUNDER: PD-6 — build the switch before publishing, or disclose]`. `[LEGAL REVIEW: confirm AI processing of tenant data is covered as processor-on-instruction, and whether the document-autofill feature (CVs, vehicle logbooks) needs a DPIA.]`
7.5 **Dormant integrations.** Call recording and voice AI, SMS, vehicle telematics, banking/accounting/HMRC connections, outbound webhooks and similar features are off by default. If the Customer switches one on, the provider becomes a sub-processor (or an independent controller, e.g. HMRC) as stated in the Sub-processor List; CrewFlow will first update that list and, for recording, tracking or voice, the Customer should complete a DPIA (G-21) `[LEGAL REVIEW]`.
7.6 **Anonymous or bearer-link pages.** Quote links, customer-portal links and external-worker links give access to whoever holds the link. The Customer controls to whom it sends links.

---

## 8. Data-subject requests (Art. 28(3)(e))

8.1 CrewFlow will not respond to a data subject about the Customer's data except to tell them to contact the Customer, and will forward a request it receives to the Customer within `[FOUNDER: suggest 5 working days]`.
8.2 CrewFlow will assist the Customer, taking into account the nature of the processing, with access, rectification, erasure, restriction, portability and objection. What exists today:
- **Company export:** `GET /api/gdpr/export` produces a ZIP of the Customer's data for the owner/admin. **[LIVE]**
- **Rectification and most deletion:** the Customer's authorised users edit and delete records in the product. A customer with financial history cannot be deleted by the product (there is no per-person anonymise yet — G-5).
- **Per-person access / erasure of a customer or staff member:** performed by CrewFlow on written request, manually, against `DSAR-PROCEDURE.md`, within `[FOUNDER: PD-11 / F-13 response time to promise; legal maximum one month overall]`. Account / staff / company erasure is built **[PENDING: PR #1091, flag `FEATURE_ACCOUNT_DELETION` off]**.
- **Restriction (Art. 18):** manual `[FOUNDER: PD-12]`.
8.3 `[LEGAL REVIEW: whether CrewFlow may charge for assistance beyond a reasonable level, and the wording of "taking into account the nature of the processing".]`

---

## 9. Personal data breaches and assistance (Art. 28(3)(f), Arts. 33–36)

9.1 CrewFlow will notify the Customer **without undue delay and in any event within `[FOUNDER/LEGAL: suggest 48 hours; the statutory outer limit for the Customer's own ICO report is 72 hours from the Customer becoming aware]`** after becoming aware of a personal data breach affecting the Customer's personal data, by email to the account owner(s).
9.2 The notice will describe, as far as known: the nature of the breach and categories and approximate numbers of data subjects and records; the likely consequences; the measures taken or proposed; and a contact point. Information may be provided in phases.
9.3 CrewFlow will take reasonable steps to contain and remediate, and will help the Customer with its Art. 33/34 duties and any DPIA or prior consultation relating to the service.
9.4 **Internal procedure:** none exists yet — who decides, who files, who reaches the Customer out of hours `[FOUNDER: F-21 / G-22]`. **This clause must not be offered until that procedure exists.**

---

## 10. End of service: deletion or return (Art. 28(3)(g))

10.1 **Return.** On cancellation or expiry the account owner can still sign in read-only to export the Customer's data and invoices (D-17 cancelled-company rules). **[LIVE]** A full export is available via `GET /api/gdpr/export`.
10.2 **Cancellation does not delete.** Under CrewFlow's current policy (founder, 2026-11-16; PR #1090) cancelling a subscription **never automatically deletes** the Customer's data. After the paid period ends, the Customer's data remains in the system, read-only, until the Customer asks for deletion.
10.3 **Deletion on request.** The Customer may instruct CrewFlow to delete all personal data at any time. Company deletion requires the owner's authorisation, recent re-authentication, a typed confirmation and a `[FOUNDER/LEGAL: L8 — 7-day]` cooling-off, then removes tenant data (with a prior offer of export) and leaves only CrewFlow's own minimised billing archive and an opaque deletion record (`LEGAL-RETENTION-DECISIONS.md` §2). **[PENDING: PR #1091, flag off — until it is enabled deletion is performed manually by CrewFlow and cannot yet be evidenced by the same tests.]**
10.4 **`[LEGAL REVIEW: CONFLICT PD-1 / G-25.]`** Art. 28(3)(g) obliges the processor to delete or return at the end of the services, at the controller's choice, unless law requires storage. "Never auto-delete, delete on request" leaves personal data held indefinitely after the service ends unless the controller's choice is documented. Options for the adviser and founder:
- (a) Keep the current policy and record, in this DPA, that the Customer **elects** retention until it requests deletion, accepting that CrewFlow will send a reminder at `[FOUNDER: interval]`.
- (b) Set a period after expiry `[FOUNDER: PD-1 period — e.g. N months]` after which CrewFlow gives notice and then deletes (or returns) unless the Customer extends in writing.
- (c) A hybrid: personal data of the Customer's data subjects deleted after a period; the owner's export access remains.
Engineering default: **(b) with notice**, because it satisfies Art. 28(3)(g) and Art. 5(1)(e) without breaching the "cancelling never deletes" promise, which is about timing not permanence. Until PD-1 is decided this clause is incomplete.
10.5 **Backups and provider logs.** After deletion, residual copies age out of Supabase backups (~7 days, `[FOUNDER: F-16]`), the Backblaze archive set (~8 weeks) and sub-processor logs (Resend, Anthropic, Vercel, Sentry) that CrewFlow cannot shorten. CrewFlow will not restore deleted data into live systems except for disaster recovery, and will re-apply deletions after a restore **[PENDING: PR #1091 tombstones; the upload beside the backup is staged]**. `[LEGAL REVIEW: PD-7 — is "beyond use until aged out" acceptable, and is it disclosed.]`
10.6 **Records the Customer is obliged to keep.** The statutory-retention duty for invoices, payroll, CIS and similar records is the Customer's, not CrewFlow's; CrewFlow, as processor, deletes them after offering the export. `[LEGAL REVIEW: L1 / PD-9 — confirm; the alternative (CrewFlow holds them for N years) would make CrewFlow a controller of those ledgers.]`

---

## 11. Assistance, records and impact assessments
11.1 CrewFlow keeps a record of the categories of processing it carries out for the Customer (Art. 30(2)) `[FOUNDER: record not yet formalised; DATA-PROCESSING-REGISTER.md supplies the content]`.
11.2 CrewFlow will, on reasonable request, give the Customer information that it needs for a DPIA about the service.

## 12. Information and audits (Art. 28(3)(h))
12.1 CrewFlow will make available on request the information needed to show compliance with Art. 28, in the first instance by this DPA, the Sub-processor List and written answers to a reasonable security questionnaire (not more than once a year unless a breach has occurred).
12.2 If that is insufficient, the Customer (or an independent auditor bound by confidentiality) may audit CrewFlow's compliance on `[FOUNDER: notice — suggest 30 days]` written notice, during business hours, no more than `[once a year]`, at the Customer's cost, without access to other customers' data or to the infrastructure of sub-processors. `[LEGAL REVIEW: scope, cost, reliance on provider audit reports.]`

## 13. Liability, term and law
`[LEGAL REVIEW: liability under this DPA — whether inside the Terms' cap, and indemnities.]` This DPA lasts as long as CrewFlow processes the Customer's personal data. It is governed by the law that governs the Terms `[LEGAL REVIEW: England & Wales / Northern Ireland; the product is based in Belfast]`.

---

## Annex 1 — Processing details

| Data subjects | Categories of personal data | Source in product (examples) |
|---|---|---|
| **Customer's customers** (often private householders) | Name, email, phone, home or site address, quotes, invoices, payments, job history, property photos, messages, e-signature (typed name, optional drawn signature, **hashed** IP, user agent), portal uploads | `customers`, `quotes`, `invoices`, `jobs`, `signatures`, `portal_uploads` |
| **Customer's leads / enquirers** | Name, contact details, postcode, enquiry text, rule-based lead score, AI summary | `leads`, `inbound_enquiries` |
| **Customer's staff and workspace users** | Name, email, phone, role and permissions, rota, **timesheets and leave** (leave type and free-text reason may reveal health), qualifications and card scans, H&S acknowledgements with signature, **payroll estimates, pay rate, NI number, date of birth and tax category (optional), pension status, emergency contact (a third party)** | `memberships`, `time_entries`, `leave_requests`, `payroll_*`, `staff_compensation`, `staff_secrets`, `staff_qualifications` |
| **Suppliers and subcontractors** (sole traders: individuals) | Name, contact, UTR, CIS status/rate, verification reference, payments | `suppliers`, `cis_*` |
| **External workers, site visitors, witnesses** | Name, employer, vehicle registration, time on site, signed inductions (typed/drawn signature, hashed IP, user agent) | `site_visitors`, `site_inductions`, `worker_*` |
| **Site photographs and files** | Photos (may show people, vehicles, premises; **may carry EXIF location until PD-4 is decided — G-24**), documents, imports (customer/staff lists), receipts | 13 private storage buckets |
| **Members of the public who call/message the Customer** | Phone number, message text, recordings, transcripts — **all dormant** unless switched on | `calls`, `messages`, `whatsapp_*` |

No fields exist for biometric data, trade-union membership, religion, ethnicity, sexual orientation or criminal records (they could only appear in free text); no identity-document photos are requested (a Customer *can* upload any file). No automated decision with legal or similarly significant effect is taken. Frequency: continuous. `[LEGAL REVIEW: complete the Annex against the final data-flow scope.]`

## Annex 2 — Technical and organisational measures

| Area | Measure | State |
|---|---|---|
| Tenant isolation | Every tenant table carries `org_id` and Postgres row-level security; integration suites prove cross-tenant reads/writes are denied | **[LIVE]** |
| Least privilege inside a tenant | Role-based permissions; owner/admin-only tables for NI number and tax profile; separate compensation permission for pay and emergency contact; staff see only assigned jobs and their documents (R5); D-17 least-privilege and company lifecycle (cancelled companies locked to read-only owner access; never auto-erased) | **[LIVE]** (D-17 released 2026-11-15, PR #1097) |
| Data-access grants | Database API grants reduced to least privilege (grant census 103 → 20, #892); route tables (phone numbers, inbound-email routes) service-role-write only | **[LIVE]**; route-table change **[PENDING: migration 20261364000000]** |
| File access | 13 storage buckets, all private; objects org-prefixed; short-lived signed URLs; cross-tenant file-access P1 fixed (#1107, 2026-11-16) | **[LIVE]** |
| Browser security | Content-Security-Policy and security headers on every page (script/connect/form-action allow-lists); no Supabase client in the browser | **[LIVE]** (CSP tightening: **[PENDING]** CSP workstream) |
| Authentication | Email+password, magic link, Google OAuth; MFA and SSO/SCIM available to tenants; session cookies | **[LIVE]**; session lifetime `[FOUNDER: F-17 / PD-17]` |
| Encryption in transit | HTTPS everywhere (Vercel, Supabase) | **[LIVE]** |
| Encryption at rest | Provider-managed encryption at rest (Supabase/AWS) `[FOUNDER: F-9 confirm]`; backup archives AES-256 (PBKDF2) before leaving the operator machine | **[LIVE]** |
| Backups and recovery | Supabase daily backups; weekly encrypted off-platform archive; restore proven against production data; backup-failure alerting | **[LIVE]**; alerting **[PENDING: PR #1099]** |
| Logging and monitoring | Error monitoring with PII scrubbing by key name; support-access sessions logged; immutable admin activity log; AI usage ledger | **[LIVE]**; free-text/path-token scrubbing **[PENDING: security branch]** |
| Secrets and tokens | Server-only secrets; worker sign-off tokens hashed; customer-portal tokens plaintext, rotatable (G-19) | **[LIVE]**; hardening **[PENDING]** |
| Data minimisation | Stops collection of avatar URL and clock-in GPS; keyed-digest rate-limit keys; no email address in auth URLs; no password-sign-in overwrite of name/phone | **[PENDING: PR #1108 `privacy/data-minimisation`]** |
| Consent and tracking | Analytics only after consent; none on bearer-link pages | **[PENDING: PR #1092]** |
| AI spend and abuse | Per-organisation monthly AI ceiling; platform ceiling; closed disclosure contract for the quote writer | **[LIVE]** per-org; platform ceiling **[PENDING]** |
| Deletion tooling | Account, staff and company erasure with processor manifest | **[PENDING: PR #1091]** |
| Organisational | Admin account MFA, access list, incident procedure, personnel confidentiality, FileVault/key escrow on the backup machine, security certifications | `[FOUNDER: F-12, F-18, F-21, F-22]` |
