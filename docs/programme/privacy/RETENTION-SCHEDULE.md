# CrewFlow — retention schedule as actually implemented (verified 2026-11-13; updated 2026-11-16)

**2026-11-16 update.** (1) Founder policy: **cancelling a subscription never deletes data**. With #1090 (pending) a cancellation takes effect at the end of the paid period; afterwards the company is held — owner read-only with billing and export, other users locked out (D-17, `server/auth/session.ts`: "never auto-erases"). No post-cancellation period is set — decision PD-1 / gap G-25. (2) Deletion is a separate explicit request: #1091 (pending, `FEATURE_ACCOUNT_DELETION` default off) adds account, company (7-day cooling-off) and staff erasure, a tombstone ledger and a minimised billing archive kept to `retention_until` (PD-3, PD-8). (3) The rate-limit sweep commit on this branch is `afdbc459`. (4) Plaintext local backup copies are still kept by the script on main (G-6). Everything else below is unchanged.

This is a statement of what the **code and the production database do today**, not of what earlier documents intend. Each line says whether a period is **ENFORCED** (a scheduled job or constraint deletes the data), **AVAILABLE** (the mechanism exists but is switched off or never called), or **NONE** (nothing ever deletes it).

Evidence labels follow `AGENT-RULES.md` §5. Production figures are aggregate counts taken on 2026-11-13.

**Headline.** For tenant business data there is **no enforced retention period at all**: data is kept for as long as the organisation exists, and there is no shipped way to delete an organisation. The live privacy policy and terms both promise deletion "within 30 days" of cancellation/workspace deletion and a "90-day" roll-off of operational logs; **neither is implemented as stated** (see §5).

---

## 1. The mechanisms that exist

| Mechanism | Where | Schedule | State in production | Label |
|---|---|---|---|---|
| **Per-org retention policies** — a tenant admin picks a window (30–3,650 days) for any of 10 allow-listed operational tables | `lib/retention/policy.ts`, `server/services/retention-purge.ts`, SQL `retention_purge_run`, UI `app/(app)/settings/data-retention` | daily 03:45 (`/api/cron/retention-purge`) | **0 policies exist** (`retention_policies` = 0 rows). `FEATURE_RETENTION_PURGE` defaults OFF, in which case every run is a **dry-run** that deletes nothing. `retention_purge_log` = 0 rows, so no run — dry or real — has ever acted on a policy | AVAILABLE, not in use — VERIFIED |
| **Document-import purge** — uploaded documents (`form-imports` bucket) and their extraction drafts are removed 7 days after upload; consumed/discarded drafts immediately | `purgeExpiredFormImports()` in `server/services/document-autofill.ts` (`AUTOFILL_RETENTION_DAYS = 7`) | same daily cron; **not** behind the flag | `form_import_drafts` = 0 rows; bucket empty | ENFORCED — VERIFIED by code; nothing to observe in prod |
| **Notification-email queue clean-up** — rows with status `sent`/`skipped` older than 90 days are deleted | `cleanupOldEmailRows()` in `lib/notifications/email.ts`, called from `/api/cron/notifications-drain` | every 15 min | 14 rows, oldest 21 days | ENFORCED — VERIFIED by code. Rows with status `failed`/`queued` are never deleted |
| **Cron telemetry prune** — successful runs 14 days, failed/unfinished runs 90 days | `server/services/cron-runs-prune.ts`, SQL `prune_cron_runs` | daily | 167,809 rows, oldest 89 days — consistent with the 90-day failure horizon | ENFORCED — VERIFIED |
| **Rate-limit counter sweep** — windows closed for more than a day are deleted | SQL `rate_limit_sweep()`; called by `sweepExpiredCounters()` **added on this branch** | daily (with the cron prune) | Before this branch nothing called it: 11 rows, oldest window 115 days old | ENFORCED on branch (commit `afdbc459`), **not deployed** |
| **Activity-log purge** — `purge_activity_log(interval '24 months')` | migration `20260710000000`, runbook `docs/activity-log-retention.md` | **none** — the runbook offers pg_cron or a manual call | `pg_cron` is not installed in production (`cron.job` does not exist); no application code calls the function. 651 rows, oldest 115 days | AVAILABLE, never run — VERIFIED |
| **Organisation erasure** — storage objects removed, 38 statutory tables anonymised in place, 14 platform tables retained, everything else hard-deleted | `server/services/gdpr-erase.ts`, SQL `gdpr_erase_org`, route `POST /api/gdpr/erase` (owner or super-admin + slug confirmation) | on demand | `FEATURE_GDPR_ERASURE` defaults OFF → the route answers 503. `gdpr_erasure_log` = 0 rows | AVAILABLE, switched off — VERIFIED by code + count. It does not delete `auth.users` / `public.users` (account deletion is a separate workstream) |
| **Organisation export** — ZIP of JSON, one file per table | `GET /api/gdpr/export` (owner/admin), `server/services/gdpr-export.ts` | on demand | No flag — reachable today. `gdpr_export_log` = 0 rows (never used) | ACTIVE — VERIFIED by code |
| **HQ memory lifecycle** — expiry/consolidation of CrewFlow's internal AI memory | `/api/cron/memory-lifecycle` | scheduled; gated by a DB flag | 6 memories | CrewFlow-internal; not tenant data |

The 10 tables a retention policy may target: `notifications`, `webhook_deliveries`, `push_deliveries`, `notification_email_queue`, `automation_runs`, `maintenance_reminder_log`, `api_request_log`, `health_score_events`, `telematics_readings`, `calendar_pulled_events`. Everything else is un-purgeable by construction (default-deny), and financial/payroll/audit tables are additionally on an explicit exclusion list.

---

## 2. Schedule by data class

"Legal note" flags a retention duty or limit that someone qualified must confirm; the statutory periods are quoted as commonly understood and are **not** legal advice. For tenant data the tenant is the controller and decides the period — CrewFlow's job is to give them a mechanism, which today it largely does not.

### 2.1 Tenant business data (CrewFlow = processor)

| Data class | Tables (examples) | Implemented period | Mechanism | Gap | Legal note |
|---|---|---|---|---|---|
| Customers, contacts, properties | `customers`, `customer_contacts`, `properties` | Until a tenant admin deletes the record or the org is erased | Manual delete in UI (`deleteCustomer`) — **blocked** while quotes/jobs/invoices reference the customer (FK restrict) | No way to erase a single customer who has history; no age-based rule; 602 rows in prod | Individual erasure requests must be weighed against the tenant's 6-year records duty |
| Leads / enquiries | `leads`, `lead_followup_state`, `inbound_enquiries` | Until manually deleted | `deleteLead` | No rule for stale, unconverted leads | Unconverted enquiries have no statutory retention — the hardest to justify keeping |
| Quotes, invoices, payments, valuations, retentions, purchase orders | `quotes`, `invoices`, `invoice_payments`, `payments`, `job_valuations`, `purchase_orders`, … | Indefinite | None. On org erasure these rows are **kept and anonymised** | No "delete after N years" | HMRC / Companies Act: commonly 6 years |
| Jobs, site diaries, snags, reports, certificates, warranties | `jobs`, `site_diary_entries`, `snags`, `site_reports`, `completion_certificates`, `job_warranties` | Indefinite | None | — | Contract limitation periods (6 or 12 years) usually drive this; warranties longer |
| Files: photos, receipts, drawings, documents, portal uploads | buckets `job-photos`, `receipts`, `blueprints`, `job-docs`, `job-docs-private`, `tenant-attachments`, `portal-uploads`, `compliance-docs` | Indefinite | Removed only by org erasure (Storage API) | Deleting a row does not always delete its file — not audited here | — |
| E-signature evidence | `signatures`, `quotes.accept_signature` | Indefinite | None | Hashed IP + user agent kept as long as the quote | Evidence of contract formation — keep with the quote |
| Customer-portal access | `customers.portal_token*`, `customer_contacts.portal_token*` | Until rotated; optional expiry column | `rotateCustomerPortalToken` | Tokens are stored in plaintext | — |
| Suppliers / subcontractors / CIS | `suppliers`, `cis_subcontractors` (UTR), `cis_statements`, `cis_monthly_returns` | Indefinite | None; anonymised on org erasure | — | CIS records: commonly at least 3 years after the tax year |
| Data-import staging | `imports`, `import_files`, `import_rows` (the raw imported rows), bucket `imports` | **Indefinite** | **None** | 1,803 raw rows and 7 source files sit in prod after the import finished. This is a second, unmanaged copy of whatever was imported | No reason to keep once the import is committed and the rollback window has passed |
| Search index | `tenant_search_documents` | Follows the source row (rebuildable) | Queue-driven | — | — |

### 2.2 Tenant staff data (CrewFlow = processor)

| Data class | Tables | Implemented period | Mechanism | Gap | Legal note |
|---|---|---|---|---|---|
| Account identity | `auth.users`, `public.users`, `memberships` | Until the membership is removed; the **user account itself is never deleted** | `removeStaff` deletes the membership row only | No account deletion (separate workstream) | — |
| Pay, tax profile, NI number, date of birth, pension, holiday | `staff_compensation`, `staff_secrets`, `payroll_tax_profiles`, `pension_enrolments`, `holiday_entitlements`, `payroll_lines` | **Indefinite, including after the person leaves** | None. These rows reference `users`, not `memberships`, so removing a staff member does **not** cascade (VERIFIED from the foreign keys). Only `staff_qualifications` cascades | Ex-staff NI number, DOB, pay rate and emergency contact stay with no end date and no screen to reach them | PAYE records: commonly 3 years after the tax year; an emergency contact has no retention basis once employment ends |
| Timesheets, rota, leave | `time_entries`, `rota_entries`, `leave_requests` | Indefinite | None | — | Working-time records: commonly 2 years; leave "type" can reveal sickness |
| Qualifications and card scans | `staff_qualifications` + document file | Until deleted or the membership is removed | Cascade on membership delete (row); file removal not verified | — | — |
| H&S acknowledgements, inductions, toolbox-talk attendance | `safety_acknowledgements`, `site_inductions`, `toolbox_talks`, `worker_acknowledgements` | Indefinite | None. `safety_acknowledgements.user_id` and `site_inductions.user_id` are `ON DELETE RESTRICT` → they will **block** deleting a user | Relevant to the account-deletion workstream | H&S evidence is often kept for many years; legal review |
| Notifications | `notifications` | Indefinite unless the tenant sets a policy | Retention policy (available, unused) | 89 rows | — |

### 2.3 CrewFlow's own data (CrewFlow = controller)

| Data class | Tables / place | Implemented period | Mechanism | Gap |
|---|---|---|---|---|
| Demo requests (prospects) | `demo_requests` | Indefinite | None | 3 rows; no rule for prospects who never became customers |
| Sales CRM / outreach | `hq_sales_*`, `hq_communications`, `hq_comms_suppressions` | Indefinite | None | 0 company/contact rows in prod; suppression list must be kept (correct) |
| Billing | `billing_invoices`, `billing_events`, `org_subscriptions`; Stripe | Indefinite | None; retained on org erasure | Legal note: CrewFlow's own 6-year accounting duty |
| Support-access audit | `impersonation_sessions` (operator email, raw IP, user agent) | Indefinite | None | 25 rows |
| HQ admin audit | `admin_activity_log` | Indefinite (append-only by trigger) | None | 129 rows |
| Tenant activity feed | `activity_log` (copies customer name/email/phone into `metadata`) | Indefinite | Purge function exists, never scheduled | See §1; append-only, so a single person's data cannot be removed from it short of org erasure |
| AI usage ledger | `ai_invocations`, `ai_cost_reservations` | Indefinite | None; `user_id` nulled on erasure | No prompt text stored |
| HQ event spine | `hq_events` (monthly partitions), `hq_timeline` | Indefinite | Partitions are created ahead; none are dropped | 90,335 rows; payloads are internal business events |
| Email delivery events | `comm_events` (recipient address + provider payload) | Indefinite | None | 16 rows |
| Webhook inboxes | `whatsapp_webhook_events`, `email_webhook_events`, `billing_events`, `call_events` (raw provider payloads) | Indefinite | None | Raw payloads are the least-minimised form of the data |
| Rate-limit counters | `rate_limit_counters` | 1 day after the window closes | Sweep (this branch) | See §1 |
| Cron telemetry | `cron_runs` | 14 / 90 days | ENFORCED | — |
| Consent choice | cookie `cf_cookie_consent` | 365 days | `CONSENT_MAX_AGE_SEC` | — |

### 2.4 Copies outside the live database

| Copy | Period | Evidence | Consequence |
|---|---|---|---|
| Supabase managed daily backups | 7 days (as stated in the programme brief) | NEEDS-FOUNDER to confirm on the dashboard | Deleted data persists up to 7 days |
| Off-platform encrypted backup (Backblaze B2) | newest **8** weekly archives ≈ 8 weeks | `scripts/ops/off-platform-backup.sh` (`CF_BACKUP_RETENTION` default 8) — VERIFIED by code | Deleted/erased data persists up to ~8 weeks in ciphertext |
| **Local plaintext dump directories on the operator's Mac** | newest 8 | `docs/ops/off-platform-backup-automation.md` "Retention / rotation" | A plaintext copy of the full production database, auth data and all files, on a laptop. See `COMPLIANCE-GAPS.md` G-6 |
| Vercel request/function logs | plan-dependent | NEEDS-FOUNDER | — |
| Sentry events | plan-dependent | NEEDS-FOUNDER | — |
| PostHog events | project setting | NEEDS-FOUNDER | — |
| Resend message logs | plan-dependent | NEEDS-FOUNDER | Email bodies (quotes, invoices) may be viewable in the Resend dashboard for that period |
| Anthropic / OpenAI request retention | provider terms | NEEDS-FOUNDER | — |
| Supabase Auth sessions (`auth.sessions`: raw IP, user agent) | Supabase project setting (session lifetime / inactivity timeout) | NEEDS-FOUNDER; 9 rows in prod | — |

---

## 3. What happens on each "end of life" event today

| Event | What the code does | What is left behind |
|---|---|---|
| Tenant removes a staff member | Deletes the `memberships` row; cascades `staff_qualifications`, `membership_permissions` | `users` + `auth.users` account; NI number, DOB, pay, emergency contact, timesheets, payroll lines, H&S acknowledgements, notifications |
| Tenant deletes a customer | Hard delete if nothing references it; otherwise refused | The `activity_log` "customer created" entry with name, email, phone; search index row until the queue catches up; backups |
| Tenant cancels the subscription | Today: billing state changes (Stripe webhook). With #1090: end-of-paid-period cancellation, then held (owner read-only + export) | **Everything — by founder policy** (2026-11-16). Retention period after cancellation undecided (PD-1) |
| Org erasure is run (if the flag were on) | Storage emptied; statutory tables anonymised; the rest deleted; an audit row written | Anonymised financial/payroll rows; CrewFlow billing; user accounts; backups for up to ~8 weeks |
| A user asks CrewFlow to delete their account | Nothing self-service | Handled manually; separate workstream |

## 4. What a retention *policy* would have to add (proposals, not built)

1. A scheduled org-teardown N days after cancellation (so the "30 days" promise is true), driven by the existing erasure primitive.
2. A per-tenant default for stale leads and for ex-staff sensitive fields (NI number, DOB, emergency contact, pay).
3. A purge of import staging (`import_rows`, `imports` bucket) a fixed period after commit.
4. Scheduling `purge_activity_log` (the function and index already exist).
5. An age rule for raw webhook payloads and `comm_events`.
6. Decide and document periods for CrewFlow's own prospect data.

Each is costed in `COMPLIANCE-GAPS.md`.

## 5. The live pages versus this schedule

| Live statement | Source | Reality |
|---|---|---|
| "When you delete a workspace, we delete the business data within 30 days." | `app/privacy/page.tsx` | There is no workspace-deletion feature, no scheduled job, and the erasure route is switched off. NOT-IMPLEMENTED |
| "When you cancel, we delete it within 30 days, except where tax law (HMRC) obliges us to retain it." | `app/terms/page.tsx` | Same |
| "Operational logs (Sentry, Supabase audit) roll off on a 90-day window." | privacy | `cron_runs` failures: 90 days (true). `activity_log`, `admin_activity_log`, `impersonation_sessions`, `hq_events`: never. Sentry/Vercel: plan-dependent, unconfirmed |
| "Where UK tax law requires us to retain certain records … we'll do so for the statutory period and no longer." | privacy | Nothing deletes them at the end of any period |
| "Backups are encrypted at rest." | privacy | True for the off-platform archive; the same script keeps plaintext copies locally |
