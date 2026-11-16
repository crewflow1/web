# Legal retention exceptions: decision table for legal review

Workstream `privacy/account-deletion` (PR #1091). Migrations `20261359000000`–`20261362000000`. Status: **built, DARK**
(`FEATURE_ACCOUNT_DELETION` is off by default).

This table is for **counsel to confirm or correct**. Every statutory reference below is an engineering summary to be
checked. None of it is legal advice. Every row says what the code does today. Each one can be changed by editing one
registry entry or one constant, and the "Where" column names it. The code keeps **exactly** what this table lists and
nothing more. The tests named in the last section enforce that.

Who is the controller of which data is set out in [DELETION-DESIGN.md §2](./DELETION-DESIGN.md). In short:

- The **tenant company** is the controller of its business and employment records, and CrewFlow is its processor.
- **CrewFlow** is the controller of a person's login identity, of its own billing of the company, and of its security
  logs.

The three cases:

- **A**: a person deletes their own login (`user_account`).
- **A′**: an employer erases one staff member (`staff_erasure`).
- **B**: an owner deletes the whole company (`org`). This needs owner authorisation, re-authentication within the last
  10 minutes, a 7-day cooling-off, and a typed company name.
- **C**: the subscription is cancelled. **This never deletes anything** (founder policy, 2026-11-16).

## 1. Records the tenant company keeps (CrewFlow is processor)

| Record class | Tables | Statutory basis claimed (to confirm) | A / A′ (one person) | B (company deleted) | C (cancelled) |
|---|---|---|---|---|---|
| Sales invoices, payments, credit notes, quotes | `invoices`, `invoice_line_items`, `invoice_payments`, `payments`, `quotes`, `quote_versions`, `finances` | Companies Act 2006 s.386–388; Corporation Tax records kept 6 years from the end of the accounting period (FA 1998 Sch 18 para 21); VAT records kept 6 years (VATA 1994 Sch 11 para 6) | **Untouched.** The rows belong to the company. Any reference to the person stays and points at a "Deleted user" placeholder or a profile no longer readable | **Deleted** after the owner is offered `GET /api/gdpr/export`. The duty to keep them is the **company's**, not CrewFlow's (Art. 28(3)(g): delete or return at the end of the service) | **Kept**, read-only (D-17 hold) |
| CIS deductions, verifications, returns | `cis_*` | Income Tax (Construction Industry Scheme) Regulations 2005 reg. 51: at least 3 years after the end of the tax year | Untouched | Deleted after export is offered | Kept |
| Payroll: lines, runs, pay data | `payroll_lines`, `payroll_runs` | Income Tax (PAYE) Regulations 2003 reg. 97: 3 years after the end of the tax year. National Minimum Wage records: 6 years | **Retained** (class `retain`). Row kept, still linked to the person's id | Deleted after export is offered | Kept |
| NI number, date of birth, tax profile | `staff_secrets`, `payroll_tax_profiles` | As payroll, while they support a payroll line | **Conditional**: kept only if a payroll line for the person exists in that company, otherwise deleted | Deleted | Kept |
| Pension auto-enrolment | `pension_enrolments` | Employers' Duties (Registration and Compliance) Regulations 2010: 6 years | Retained | Deleted after export is offered | Kept |
| Working time and holiday | `time_entries`, `holiday_entitlements`, `leave_requests` | Working Time Regulations 1998 reg. 9: 2 years. Leave reasons may be health data | `time_entries` and `leave_requests` are **scrubbed**: the row stays, notes, GPS and reasons are blanked. `holiday_entitlements` retained | Deleted | Kept |
| Signed H&S and quality evidence | `safety_acknowledgements`, `site_inductions`, `inspection_signoffs`, `non_conformance_reports` | HSWA 1974 / CDM 2015 evidence. Limitation Act 1980 (6 / 12 years; latent damage up to 15). RIDDOR reg. 12: 3 years | Retained, including the signed-name snapshot (Art. 17(3)(b)/(e)) | Deleted after export is offered | Kept |
| Authored business records ("who did this") | ~226 `*_by` references: diaries, messages, photos, voice notes, notes | None. These are the company's records | **Pseudonymised**: the reference stays and the identity behind it is destroyed or unreadable. The content is untouched | Deleted | Kept |
| Purely personal operational data | memberships, assignments, rota, notifications, push/SMS deliveries, AI drafts, import drafts and their files | None | **Deleted** | Deleted | Kept |
| Pay rate and emergency contact (no `org_id`) | `staff_compensation` | None. The emergency contact is a third party's data | Deleted with the account. For A′, deleted only if the person is in no other company | Deleted with each member who has no other company | Kept |

## 2. Records CrewFlow keeps about itself (CrewFlow is controller)

These rows are what survives a company deletion (case B). The code keeps these, and nothing else:

| What survives | Exactly which fields | Basis claimed (to confirm) | Kept until | Where |
|---|---|---|---|---|
| `privacy_retained_billing_records`, kind `org_account` (one per company) | `former_org_id`, `request_id`, `plan`, `stripe_customer_id`, `stripe_subscription_id`, `source_created_at`, `retention_until` | CrewFlow's own Corporation Tax and VAT records (6 years) | 31 December, 6 years after the year of deletion (`BILLING_RETENTION_YEARS`) | `privacy_org_teardown` §c |
| `privacy_retained_billing_records`, kind `billing_invoice` (one per CrewFlow invoice) | `stripe_invoice_id`, `stripe_payment_intent_id`, `invoice_kind`, `invoice_status`, `amount_gbp`, `currency`, `period_start`, `period_end`, `due_date`, `paid_at`, `source_created_at`, `retention_until` (plus ids as above) | As above | As above | As above |
| **Stripe customer, subscription and invoices** (at Stripe) | Stripe's own objects. The subscription is **cancelled** (`invoice_now:false, prorate:false`), and the customer and invoices are **not deleted** | As above. Deleting a Stripe customer does not delete its invoices, and it cannot be undone | Retention end. Then redaction through Stripe's data-redaction tooling (manual, staged) | Processor ledger row `stripe` = `retained_legal` |
| `demo_requests` row (if the customer came through the demo funnel) | Funnel status, timestamps and Stripe session. Name, company, email, phone and notes are erased | CrewFlow sales record (legitimate interest) | No purge today ([LEGAL] L12) | `privacy_org_teardown` §d |
| Tombstone (`privacy_deletion_requests`, sealed) | Kind, opaque ids, timestamps, per-table **counts**, actor **role**, symbolic error codes | Evidence that the erasure happened. Needed so a restore can re-apply it (Art. 5(2) accountability) | Indefinitely. It holds no personal data | Ledger |
| Processor ledger (`privacy_processor_requests`) | Processor, disposition, status, counts, opaque provider handles, deadline, symbolic resolution | Accountability, and evidence for answering a data subject | Indefinitely. It holds no personal data | §3 below |
| Security logs (`admin_activity_log`, impersonation sessions, Supabase Auth platform logs) | As written. `actor_id` detached where the schema allows | Security and fraud prevention ([LEGAL] L11) | Plan or log retention | Design §2 |

Both kinds also carry bookkeeping columns: `id`, `record_kind`, `source_id` (the archived row's former id, which
stops a re-run archiving a row twice) and `created_at`. No other column exists. The test pins the column set.

**Not kept:** `subscription_cancellations` (billing, #1090) cascades away with the company. That includes the free-text
cancellation reason and the refund-review state. **[LEGAL/FOUNDER] L15:** if finance needs the cancellation record
after a deletion, add it to the `org_account` archive as a date and a symbolic state. Never keep the free-text reason.

## 3. Third-party processors (per deletion request)

The engine records one row per processor in `privacy_processor_requests` before anything is torn down. **No provider
API is called** except Stripe subscription cancellation. When a provider holds data and CrewFlow has no API path it may
use, the row is an **open manual request** with a 30-day deadline. The operator works it from
[PROCESSOR-DELETION-RUNBOOK.md](./PROCESSOR-DELETION-RUNBOOK.md).

| Processor | Company deletion (B) | Person (A / A′) | Why |
|---|---|---|---|
| Stripe | `retained_legal` if the company had a Stripe customer | `not_held` | §2. A person has no Stripe object |
| PostHog | `manual_request` (person = one-way **hash** of the org id) if analytics is configured, otherwise `not_held` | `not_held` | The browser SDK never identifies a person, and the server keys events by org hash |
| Twilio | `manual_request` if the company has numbers, call logs or SMS logs (dark integration) | `manual_request` if texts were sent to the person | Message and call logs and recordings live at Twilio |
| Vapi | `manual_request` if the company has numbers or calls | `not_held` | Call recordings and transcripts live at Vapi |
| WhatsApp (Meta) | `manual_request` if number routes exist | `not_held` | Meta offers no message deletion. Deregister the number |
| Resend, Anthropic, Supabase platform logs, Vercel | `ages_out` | `ages_out` | No per-record deletion. The provider's retention applies. Disclose it in the privacy notice ([LEGAL] L13) |
| Sentry | `not_held` | `not_held` | `sendDefaultPii:false`, `scrubEvent`, no `setUser` |

## 4. Decisions needed from counsel or the founder

| # | Question | Implemented as (conservative) |
|---|---|---|
| L1 | On company deletion, may CrewFlow delete the tenant's statutory ledgers (invoices, CIS, payroll), as a processor whose controller has been offered an export? | Yes: full teardown after the export offer. **Alternative:** hold B for N years. That would turn CrewFlow into a controller of those ledgers |
| L2 | CrewFlow's own billing: 6 years measured from the **deletion** date (implemented, which keeps older invoices longer than needed), or from each invoice's accounting period? | From the deletion year: 31 December of year + 6 |
| L4 | Payroll retention: 3 years (PAYE) or 6 years (NMW / auto-enrolment)? | Kept by the tenant with no CrewFlow purge. On B, deleted after the export offer |
| L5 | Keep the NI number only while a payroll line exists? | Yes |
| L6 | Signed H&S evidence kept against an erasure request (Art. 17(3)(b)/(e))? | Yes |
| L8 | Is a 7-day cooling-off acceptable, with billing continuing until execution? | Yes |
| L13 | Sub-processor log retention that CrewFlow cannot shorten: disclosed? | Documented here. Notice edit pending |
| L15 | Keep a minimal cancellation record after deletion? | No. It cascades (§2) |
| L16 | Processor manual-request deadline: is 30 days right (inside Art. 12(3)'s one month)? | 30 days (`PROCESSOR_MANUAL_DEADLINE_DAYS`) |
| L17 | Stripe: also detach saved payment methods at deletion (stops any future charge, keeps invoices)? | Not done. The subscription is cancelled, which stops billing |

L3, L7, L9–L12 and L14 are unchanged from [DELETION-DESIGN.md §8](./DELETION-DESIGN.md).

## 5. How "exactly this and nothing more" is enforced

- `company-deletion.test.ts` › "deletes the whole company…":
  - the retained-record **column set** equals §2 exactly, so a new column fails the test;
  - the record kinds are exactly `org_account` and `billing_invoice`;
  - the catalogue-driven residue scan finds no marker anywhere else;
  - the Stripe row is `retained_legal` with the same `retention_until`.
- `company-deletion.test.ts` › "processors: …" checks:
  - the full processor manifest;
  - that open requests carry a deadline;
  - that the database refuses a non-opaque ref (email, phone, free text);
  - the operator resolution flow.
- `account-deletion.test.ts` › "CASE A…" checks that no company row that does not mention the person changes or
  disappears. Nobody else's personal data moves, and the shared job and invoice stay byte-for-byte identical.
- `cancellation-never-deletes.test.ts` and `__tests__/privacy/no-silent-company-deletion.test.ts` cover case C:
  - nothing deletes a company without an explicit request: no application code, no migration, no cron, no billing
    path;
  - a cancelled company with the drain switched on stays byte-for-byte unchanged.
