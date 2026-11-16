# CrewFlow — data-subject rights procedure (DSAR), engineering draft 2026-11-16

How a request from a person exercising a UK GDPR right is handled **with the mechanisms that exist in the code
today**, and where there is no mechanism. Written by an engineer from the code at `origin/main` (`d24295e8`) and
the pending PRs; **not legal advice** — every ⚖ needs a qualified adviser, every F-n is a founder fact
(`FOUNDER-FACTS-NEEDED.md`), every D-n an open decision (`COMPLIANCE-GAPS.md` §Decisions).

## 1. First question: is CrewFlow the controller or the processor for this data?

| The data is… | Controller | What CrewFlow does with the request |
|---|---|---|
| A person's **CrewFlow login and profile** (email, name, phone, password/MFA, sessions), CrewFlow's **billing** of a company, **prospect / demo / sales** records, **support-access and HQ audit** logs, the **AI usage ledger**, rate-limit and security telemetry | CrewFlow | Handles it under this procedure. |
| Anything a **tenant company** keeps in CrewFlow about its customers, leads, suppliers, site visitors or its own staff (jobs, quotes, invoices, timesheets, payroll, H&S records, photos, messages) | The **tenant company** | Does **not** answer the person directly about the substance. Tells the person the company is the controller and passes the request to that company's owner without undue delay; assists the company (Art. 28(3)(e)) with the tools below. ⚖ the DPA must say this (G-3). |

Mixed requests (e.g. an employee asking "everything you hold about me") are split: CrewFlow answers for its own
data and forwards the rest to the employer. The role split is the one `docs/programme/deletion/DELETION-DESIGN.md`
§2 implements (#1091).

## 2. Intake, identity, clock

1. **Channel:** the privacy contact published in the policy (today `hello@crewflow.uk`; F-5). Requests arriving
   anywhere else (support ticket, sales email, a tenant's message) are forwarded to it the same day.
2. **Log it** (date received, requester, right, controller/processor split, deadline) — there is no DSAR register
   table in the product; keep the log outside production data (NOT-IMPLEMENTED in code; a spreadsheet is enough at
   this volume). Do not paste the request content into the AI features.
3. **Verify identity proportionately:** a request from the email address on the account, made while signed in or
   answered from that mailbox, is normally enough; never send data to a new address on the strength of an email
   alone. For a tenant's customer, the tenant verifies.
4. **Deadline:** one month from receipt (or from receiving what is needed to verify identity), extendable by two
   further months for complex or numerous requests with notice inside the first month; free of charge unless
   manifestly unfounded or excessive ⚖. Confirm with the adviser how the Data (Use and Access) Act 2025 changes
   (e.g. "reasonable and proportionate" searches, pausing the clock for clarification) apply as commenced ⚖.
   The live policy promises 14 days — decision **D-11**.
5. **Who does the work** (F-13): today every CrewFlow-controller request involves a person with production
   access running service-role reads. Two-person rule recommended for any erasure until #1091 is live.

## 3. Right by right

Label per row: **EXISTS** (shipped on main), **PENDING** (built on an open PR, dark until released/flagged),
**MANUAL** (possible only with production database access), **GAP** (no mechanism).

### 3.1 Access — Art. 15
| Who asks | Mechanism | State | Notes |
|---|---|---|---|
| A tenant **owner/admin** for the whole company | Settings → Data retention → "Download data export (ZIP)" → `GET /api/gdpr/export` (`server/services/gdpr-export.ts`): owner/admin only, org-pinned, user-JWT client under RLS, secrets / NI numbers / tokens excluded by table and column, one `gdpr_export_log` row per export | **EXISTS** (no flag) | This is a **company** export, not a per-person one. Never forward the ZIP to an individual: it contains everyone. |
| A **tenant's customer / staff member** (tenant = controller) | The tenant compiles it: record pages, Cmd+K search, the staff profile, `/me` (a worker's own timesheets), CSV exports | **EXISTS** (manual for the tenant) | **GAP:** no per-person "everything about this person" export (G-5 item 2). The register (`data-register.csv`: filter `data_subject` + columns categorised `subject link` / `user identifier`) is the map of where to look. |
| A **CrewFlow user** about their own account | Profile is visible in Settings; there is no self-service download of one's own account data | **GAP** → **MANUAL** | Service-role read of `auth.users`, `auth.identities`, `auth.sessions` (IP/UA), `public.users`, `memberships`, `notification_preferences`, `push_subscriptions`, `mfa_*`, `impersonation_sessions` (as target), `ai_invocations` (by user id: feature, model, tokens, cost — no prompt), `activity_log` / `admin_activity_log` entries naming them. Filter the register for `crewflow_role = controller`. |
| A **prospect** | `demo_requests`, `hq_sales_*`, `hq_communications`, `hq_comms_suppressions`, mailbox outside the product | **MANUAL** | Art. 14 source information must be included (G-12). |
| Everyone | Copies at processors: Resend message logs, Sentry events, Vercel logs, AI provider retention (`DATA-FLOW-MAP.md`) | **MANUAL** / not retrievable by CrewFlow | Describe them (recipients, retention) rather than retrieve. |

The response must also give the Art. 15(1) information (purposes, categories, recipients, retention, source,
rights, transfers) — taken from the policy once published (G-1).

### 3.2 Rectification — Art. 16
| Data | Mechanism | State |
|---|---|---|
| Own name / phone | Settings → profile → `updateProfile` (`app/(app)/settings/actions.ts`) | **EXISTS**. Fixed on this branch: a password / magic-link sign-in no longer overwrites them with blanks (`DATA-MINIMISATION.md` M-5). |
| Login email | No in-app email change (no `auth.updateUser({email})` caller); the callback accepts an `email_change` link | **GAP** → **MANUAL** (Supabase Auth admin) |
| Staff details (employer-held) | Staff profile (admin), payroll tax profile, compensation (behind the compensation permission; D-17 keeps payroll/pay away from staff) | **EXISTS** (tenant) |
| Company details | Settings → company (`updateOrganization`) | **EXISTS** |
| Customer / lead / supplier records | The tenant edits the record | **EXISTS** (tenant) |
| Signed evidence (quote acceptance, H&S sign-offs) | Immutable by design — correct by adding a note, not by editing the signature | by design ⚖ |

### 3.3 Erasure — Art. 17
| Request | Mechanism | State |
|---|---|---|
| Delete **my account** | #1091: Settings → Account → self-service deletion with re-authentication + typed email confirmation; employer-held records stay with the employer, no longer tied to a readable identity | **PENDING**, flag `FEATURE_ACCOUNT_DELETION` default off. Until then **MANUAL** (Supabase Auth admin + `public.users`), and blocked in many cases by FK guards (`DELETION-DESIGN.md` §1 item 5). |
| Delete **a staff member's data** (employer = controller) | #1091 staff erasure by an admin (scrub / conditional / retain / pseudonymise classes, `lib/gdpr/user-erasure.json`). On main, `removeStaff` deletes only the membership | **PENDING**; today **GAP** (G-7) |
| Delete **the company** | #1091 company deletion: owner, re-auth, typed confirmation, 7-day cancellable cooling-off, Stripe subscription cancelled first, export offered, minimised billing archive kept 6 y ⚖ | **PENDING** (dark). The older `POST /api/gdpr/erase` (`FEATURE_GDPR_ERASURE`, off) **must not be used**: #1091 proved it fails and rolls back after deleting files. |
| **Cancelling the subscription** | #1090: end of the paid period; afterwards owner read-only (billing + export), staff locked out | **Cancelling never deletes data** (founder policy 2026-11-16). Erasure is a separate request. Retention after cancellation is undecided — **D-1**. |
| Delete **one customer** (tenant = controller) | `deleteCustomer` — refused once quotes/jobs/invoices reference the customer | **EXISTS** for customers without history; **GAP** for anonymising one with history (G-5 item 3). |
| Delete **a lead** | `deleteLead` | **EXISTS** (tenant) |
| Prospect / demo request | `demo_requests` scrubbed by #1091 company deletion; otherwise manual delete; **keep the address on the suppression list** if they objected to contact | **MANUAL** |
| Backups | Not rewritten; deleted data ages out (~7 days Supabase, ~8 weeks B2); #1091 tombstones re-apply deletions after a restore (upload beside the backup is staged) | by design ⚖ (D-7) |
| Processor copies | Resend logs, Sentry events, Vercel logs, AI provider retention age out; Sentry events can be deleted manually | `DELETION-DESIGN.md` §6 |

Exemptions to weigh before erasing (⚖, not decided here): the tenant's statutory records (tax, payroll, CIS,
working time, H&S — `DATA-MINIMISATION.md` §4), signed evidence, CrewFlow's own billing records, security logs
(`admin_activity_log` is immutable). #1091 implements the conservative choice for each (its §8, L1–L14).

### 3.4 Restriction — Art. 18
**GAP.** There is no per-person "restrict processing" state. Available blunt tools: the company `status`
(`org_is_writable` makes a non-active company read-only at the data layer, D-17); removing a staff member's
membership; suspending a user in Supabase Auth (MANUAL). Interim procedure: record the restriction in the DSAR log,
stop using the data operationally (no emails, no AI, no exports including it), and do not delete it. A product
mechanism is decision **D-12**.

### 3.5 Objection — Art. 21 (and PECR)
| Processing | Mechanism | State |
|---|---|---|
| Analytics / performance telemetry | Cookie banner + "Cookie settings" withdrawal (#1092); nothing optional before consent | main: banner with accept/reject; **PENDING** #1092 for per-category choice and withdrawal control |
| CrewFlow prospecting / outreach email | `hq_comms_suppressions` (honoured by the in-product sender, fed by Resend bounces/complaints); outreach done outside the product needs the same list | **EXISTS** in product; **MANUAL** elsewhere (G-12) |
| Staff notification emails | Notification preferences in Settings | **EXISTS** |
| Emails a tenant sends its customers (reminders, review requests) | The tenant (controller) decides; no CrewFlow-level unsubscribe | tenant matter ⚖ |
| Legitimate-interest processing by CrewFlow (security logs, error monitoring, support access) | Case-by-case assessment against the LIA (F-6) | **MANUAL** ⚖ |
| AI processing of a company's data | No per-org off switch | **GAP** (G-13, D-6) |

### 3.6 Portability — Art. 20
Company level: the export ZIP is structured JSON, one file per table, with a manifest — machine-readable
(**EXISTS**). Individual level: no per-person export (**GAP**, as 3.1). Payroll CSV and invoice/PDF downloads exist
for the tenant. Portability applies only to data provided by the person and processed by consent or contract ⚖.

### 3.7 Automated decisions — Art. 22
No decision with legal or similarly significant effect is automated: AI output is a draft or summary a person acts
on; the lead score is rule-based prioritisation with its factors stored (`leads.lead_score_factors`); no
autonomous customer-facing AI action is enabled (CLAUDE.md prohibition). State this in the policy ⚖.

## 4. Closing a request
1. Reply inside the deadline with what was done, what was not and why (exemption, controller is the tenant), and
   the right to complain to the ICO.
2. For an erasure, keep only the evidence the procedure needs (date, requester, outcome, tombstone id — #1091's
   ledger stores ids and counts, never names).
3. If the request revealed a defect (data where it should not be), raise it as an engineering finding.

## 5. Gaps this procedure depends on (tracked in `COMPLIANCE-GAPS.md`)
G-5 (per-person export / anonymise), G-7 (ex-staff data), G-13 (AI off switch), D-1 (retention after
cancellation), D-11 (response time), D-12 (restriction mechanism), #1091 activation (founder: §9 of its design),
F-5 / F-13 (who staffs the inbox), and a self-service "download my account data" for CrewFlow users (proposed,
small: the account-level tables in 3.1 are few).
