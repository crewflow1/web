# Account & data deletion — design

Workstream: `privacy/account-deletion` · worktree `cf-wt/deletion` · migrations `20261311000000`–`20261314000000`.
Evidence for every claim marked VERIFIED is in [`DELETION-EVIDENCE.md`](./DELETION-EVIDENCE.md).

> **Status of the capability: built DARK.** Everything here sits behind the server-only flag
> `FEATURE_ACCOUNT_DELETION` (default off). While it is off the UI shows a "contact us" panel, the server
> actions refuse before any auth or DB work, and the cron drain is inert. Turning it on is a founder
> decision (§9). Nothing in this workstream has run, or may run, against production.

Items needing a **legal judgement** are tagged **[LEGAL]** inline and collected in §8.

---

## 1. What existed before, and what it actually does

Prior work: `POST /api/gdpr/erase` → `server/services/gdpr-erase.ts` → `public.gdpr_erase_org` (migration
`20261169000000`), classification in `lib/gdpr/org-tables.json`, UI in `settings/data-retention`.

| Question | Answer (from the code) |
|---|---|
| Scope | One whole organisation. There is no per-person erasure, no account deletion, no staff erasure. |
| Who may invoke | Org **owner** or CrewFlow super-admin, with `FEATURE_GDPR_ERASURE=true` and body `confirm` = org slug. |
| Anonymises (38 tables) | "Statutory" ledgers (invoices, payments, payroll, CIS, bank, POs, `activity_log`, `ai_invocations`…): row kept, columns whose **name** matches a PII regex set to `'[erased]'` / JSON null. |
| Hard-deletes (185 tables) | Everything else org-scoped, by `delete … where org_id = $1`, in an FK-retry loop. |
| Retains untouched (14 tables) | CrewFlow-side billing / AI-budget / ops state and the export / erasure / purge logs. |
| Storage | Removes every object under `<org_id>/` in 13 buckets through the Storage API — **before** the DB step. |
| Does **not** touch | The `organizations` row, `public.users`, `auth.users`, sessions, MFA codes, `staff_compensation` (no `org_id`), Stripe, any provider. No re-authentication. No cooling-off. No job ledger. |

**What happens when it is run** (VERIFIED, evidence §1): against a populated synthetic org it **fails and
rolls back** — and has already deleted the org's files by then.

1. **It cannot complete.** The name-based scrub writes `'[erased]'` into columns governed by CHECK constraints
   (`cis_subcontractors_outcome_dated` — reproduced with a *default, unverified* subcontractor row — and
   `supplier_payments_void_evidenced`). One transaction ⇒ the whole erasure rolls back.
2. **Its deletes are refused by the schema's own evidence guards** (`comm_events`, `job_milestones`,
   `job_programme_baselines`, `asset_inspections.template_id`, …). ~55 delete guards exist; most permit exactly
   one delete path — the tenant-teardown cascade, recognised by "the organisation row is already gone".
   `gdpr_erase_org` keeps the organisation row, so it can never use that path.
3. **Storage-first is not atomic with the DB.** After the failed run the org's 17 stored objects were gone and
   its database rows were intact: files destroyed, nothing erased, dangling references left behind.
4. **`delete from organizations` was itself impossible** for any org with one `comm_events` (or
   receptionist / AI-reply) row: 19 guard functions raised unconditionally, with no teardown escape.
5. **A user cannot be removed from `auth.users` while they have any footprint**: the `ON DELETE SET NULL`
   on `blueprint_versions.uploaded_by` (and similar) hits an immutability trigger and aborts the delete.
   Five references are `ON DELETE RESTRICT` (signed H&S / quality evidence) and block it outright; thirteen are
   `ON DELETE CASCADE` into **statutory** tables (`payroll_lines`, `pension_enrolments`, …), so where a delete
   *did* succeed it would destroy payroll records.
6. The only test that executes `gdpr_erase_org` (`audit-log-immutability.test.ts`) does so on an org holding a
   single `activity_log` row. The "erase" suites in `__tests__/security/` assert on the **source text** of the
   migration and service, not on behaviour.

Because the flag is off in production these are **latent**, not live. But the existing path is not a base to
build on: it is left in place, untouched and dark, and should be retired once this workstream is accepted
(§10). What *is* reused: the storage cleanup (`cleanupOrgStorage`, now exported), the bucket census
(`ERASE_STORAGE_BUCKETS`), the registry pattern (classification in JSON, passed to SQL as arrays, drift-guarded
against the live catalogue), and the FK-retry delete loop.

---

## 2. Roles: who is the controller of what

This decides what each person may erase, so it comes first. **[LEGAL]**

| Data | Controller | CrewFlow's role | Consequence |
|---|---|---|---|
| A person's **login identity and profile** (email, name, phone, credentials, sessions, devices, notification settings) | CrewFlow | Controller | The person can delete it themselves, at once. |
| **Employment and business records** a company keeps in CrewFlow (timesheets, payroll, rota, RAMS sign-offs, diaries, messages, photos, authored documents) | The **tenant company** | Processor | An employee **cannot** self-erase these. They can delete their account; the records stay with the company, no longer tied to a readable identity. To have the records themselves erased they ask their employer (the controller), who uses staff erasure — and CrewFlow assists (Art. 28(3)(e)). |
| A **company's own data** (customers, jobs, ledgers, files) | The tenant company | Processor | On termination CrewFlow deletes or returns it (Art. 28(3)(g)). CrewFlow has no statutory duty of its own to keep a former customer's ledgers; the customer does, and is offered an export first. |
| **CrewFlow's billing of the company** (Stripe invoices, subscription, `billing_invoices`) | CrewFlow | Controller | Kept in minimised form for the tax retention period. |
| **Security logs** (`admin_activity_log`, `impersonation_sessions`, Supabase Auth logs) | CrewFlow | Controller | Kept; identity detached where the schema allows. |

"An employee deleting their profile is **not** a company deletion" is therefore structural, not just UI
wording: the two are different request kinds with different authority checks, different primitives and
different blast radius, and `privacy_request_create` refuses a `user_account` request whose actor ≠ target.

---

## 3. The three flows

All three are rows in **one ledger**, `privacy_deletion_requests`, executed by **one engine**,
`server/services/privacy-deletion.ts → runDeletionRequest(requestId)`.

### 3.1 Self-service account deletion (`user_account`) — runs immediately

Settings → Account → "Delete my account".

1. Flag on → session → **re-authentication** (§5) → typed confirmation = the account **email**.
2. `privacy_request_create` (service-role, row-locked): actor must equal target; email must match; **refused
   while the user is the sole owner of any company** (`sole_owner`) — they must delete that company first, or
   have another owner. (There is no ownership-transfer feature today: `updateStaffRole` refuses
   `role = owner`. That is a product gap, recorded in §10, not something this workstream invents.)
3. `privacy_user_lockout`: **re-checks the sole-owner rule at run time** under row locks (a co-owner may have
   been demoted since) and freezes the list of every org holding any row linked to the person —
   catalogue-driven, so former memberships are covered too.
4. Per org, `privacy_user_erase_in_org` applies the class table (§4) in one transaction.
5. `privacy_user_identity_scrub` blanks `public.users`, deletes user-keyed personal rows
   (`staff_compensation`, `mfa_recovery_codes`), and measures the **footprint** — rows that still reference
   the user.
6. Supabase Auth: **hard delete** when the footprint is zero; otherwise **soft delete** — email and phone
   replaced by a hash, password, metadata and identity data destroyed, `deleted_at` set — leaving an anonymous
   placeholder for retained records to point at. Either way all sessions and refresh tokens are revoked; the
   old access token is rejected by `GET /auth/v1/user` at once (VERIFIED).
7. Seal the tombstone.

| Situation | Handling |
|---|---|
| Sole owner of a company | Refused at create **and** re-checked at run. |
| Co-owner | Allowed; the company keeps its other owner. |
| Member of several companies | Erased from each, in turn; each is its own recorded step, so a crash resumes mid-list. |
| Pending invite *to* the user | An invite is an `auth.users` row with no membership; deleting the identity removes it. |
| Invites the user *sent* | Unaffected (they belong to the company). |
| Active sessions | Revoked by the Auth delete. Tenant access ends earlier, when the membership row goes. |
| Signs up again later with the same email | Gets a brand-new user id; nothing links to the placeholder. |

### 3.2 Company deletion (`org`) — owner only, 7-day cooling-off

Settings → Account → "Delete company" (rendered for owners only; enforced server-side regardless).

Request time: flag → session → `role === 'owner'` → **re-authentication** → typed confirmation = the exact
**company name** → consequences acknowledged → `privacy_request_create`, which **re-proves ownership and the
name against the database** under `FOR UPDATE` locks. The request is recorded `scheduled` for now + 7 days.
Nothing is destroyed. Any owner can cancel until it starts.

Run time (daily cron once due, or operator), in this order — each step recorded, none repeated:

| # | Step | What | Idempotent because |
|---|---|---|---|
| 0 | claim | Atomic leased claim. **Re-verifies the requester is still an owner**; if not, the request is cancelled (`requester_not_owner`), not run. | Row lock + lease. |
| 1 | `stripe_cancel` | Cancel every subscription id on `organizations` / `org_subscriptions` (`invoice_now:false, prorate:false`). Fails **closed** if a subscription exists and Stripe is unconfigured. Customer object kept (§6). | Already-cancelled / missing = done; Stripe idempotency key per request+subscription. |
| 2 | `lockout` | One transaction: capture member ids, set `status='cancelled'`, delete memberships (+ permissions, qualifications) and API keys. | Step recorded in the same transaction. |
| 3 | `storage` | Remove every object under `<org_id>/` across the bucket census via the Storage API. | Re-listing an empty prefix removes 0. |
| 4 | `teardown` | One transaction: refuse unless Storage is verifiably empty → count rows per table → archive minimised billing → clear non-cascading references → `delete from organizations` → **verify from the catalogue that no table still holds the org id**, else roll back. | Step recorded in the same transaction; org-absent is a no-op. |
| 5 | `identities` | Each captured member with no remaining company: identity scrub + Auth delete (as §3.1 steps 5–6). Members who belong to another company are left alone. | Already-gone = done. |
| 6 | complete | `privacy_request_complete` refuses to seal unless all five steps are recorded; clears the working set. | — |

**Why teardown, not "anonymise and keep".** The schema's evidence guards allow exactly one delete path, and
it is this one. And it matches the processor position in §2: the company's ledgers are the company's to keep,
and it is offered `GET /api/gdpr/export` first (export-before-delete is tested). What CrewFlow keeps is its
**own** record, copied to `privacy_retained_billing_records` immediately before the row is removed: plan,
Stripe customer / subscription / invoice ids, invoice kind, status, amount, currency, period and dates.
No name, address, email or notes. Retention: to 31 December, six years after the year of deletion. **[LEGAL]**

**Cooling-off — the trade-off, and the choice.**

| | Immediate | Cooling-off with cancel (**chosen**: 7 days) |
|---|---|---|
| A hijacked or shared owner session | Company destroyed, irrecoverably. | The other owner/admins see the pending deletion and an owner cancels it. |
| A rash or mistaken decision | Irreversible. | Reversible for 7 days. |
| A disgruntled departing owner | Irreversible. | The company can remove their ownership; the claim-time re-check then cancels the request. |
| Erasure "without undue delay" (Art. 12(3): one month) | Fastest. | 7 days — well inside the limit. |
| Billing during the window | n/a | The subscription keeps running until the deletion executes (≤ 7 days). Accepted; stated on the consequences screen. |
| Complexity | None. | A due-date, a cancel action, a cron drain. |

Company deletion is the only action in the product that irreversibly destroys *other people's* working data,
so the safest design is the one where a single compromised or mistaken click is not final. Account deletion
and staff erasure run **immediately**: their blast radius is one person, the company's records survive, and a
delay there only postpones a data-subject right. **[LEGAL]** (the 7-day figure is a product choice; anything
up to ~3 weeks stays inside one month.)

### 3.3 Staff erasure (`staff_erasure`) — owner/admin, runs immediately

Staff → person → "Remove and erase personal data". Distinct from the existing "Remove from team"
(`removeStaff`), which deletes only the membership row and is unchanged.

Authority (`privacy_request_create`, row-locked): actor is owner or admin of the org; target is a member and
not an owner; erasing an admin needs the owner; target ≠ actor; typed confirmation = the staff member's email.
Then `privacy_user_erase_in_org` for that one org, and seal.

It **never touches the person's login** — `privacy_user_identity_scrub` raises for this kind. An employer can
erase what *it* holds; it cannot delete someone's account. `staff_compensation` (pay rate + emergency
contact, keyed by user with no org) is removed only when the person belongs to no other company; otherwise it
is left and reported, because it cannot be attributed to this employer.

---

## 4. Decision table per data class (per-person flows)

Registry: `lib/gdpr/user-erasure.json` → passed as arrays → validated against the live catalogue by the SQL
primitive, which **raises on any unclassified hard link** (NOT NULL, or `ON DELETE CASCADE/RESTRICT`) to a
user on an org-scoped table. 255 foreign keys reference a user; 27 are hard links and are all classified.

| Class | Tables (`table.column`) | Action | Reasoning |
|---|---|---|---|
| **Delete** — exists only *for* the person | `memberships`, `job_assignments`, `rota_entries`, `notifications`, `notification_preferences`, `notification_digest_cursors`, `notification_email_queue`, `push_subscriptions`, `push_deliveries`, `sms_deliveries`, `briefing_dismissals`, `ai_employee_budget_limits`, `form_import_drafts` (+ the stored file), `ai_quote_drafts` | Rows removed | No retention duty; personal by nature. `ai_quote_drafts` is the AI drafting history the person generated. |
| **Scrub** — company must keep the row | `time_entries` (note, GPS), `leave_requests` (reason, review note), `activity_log` (actor name, metadata) | Row kept, PII-named columns blanked | Working-time records: WTR 1998 reg. 9, 2 years. Leave reasons can hold health data. `activity_log` accepts exactly one update shape (the 20261214 guard) — that shape is used. **[LEGAL]** periods. |
| **Conditional** | `staff_secrets` (NI number) | Deleted unless a payroll line for the person exists in that company | PAYE records: 3 years after the tax year end (SI 2003/2682 reg. 97). **[LEGAL]** |
| **Retain** — statutory / evidential | `payroll_lines`, `payroll_tax_profiles`, `pension_enrolments`, `holiday_entitlements`, `safety_acknowledgements`, `site_inductions`, `inspection_signoffs`, `non_conformance_reports` | Untouched, counted in the tombstone | Payroll 3–6 y; auto-enrolment 6 y; signed H&S and quality evidence the company relies on (HSWA 1974 / CDM 2015; limitation periods to 15 y). These rows carry a **signed-name snapshot** that stays. **[LEGAL]** |
| **Pseudonymise** (derived default — the other 228 nullable "who did this" references) | `created_by`, `approved_by`, `uploaded_by`, `messages.created_by`, `voice_notes.recorded_by`, `site_diary_entries.created_by`, photos / attachments `uploaded_by`, … | Reference kept | The record is the company's. It stops identifying the person because the identity behind the id is destroyed or replaced by "Deleted user" (account deletion), or is no longer readable by that company (staff erasure: RLS shows a profile only to co-members). **[LEGAL]** — in particular voice notes and photos, whose *content* may identify the person. |
| **User-keyed, no org** | `staff_compensation`, `mfa_recovery_codes` | Removed with the account; `staff_compensation` on staff erasure only if no other membership | Emergency contact is a third party's personal data. |
| **Identity** | `public.users`, `auth.users`, `auth.identities`, `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_factors` | Hard-deleted, or anonymised placeholder when retained rows still reference it | §3.1. |

What an erasure **cannot** reach, stated plainly: free text written *by other people* that happens to name
the person (a diary entry saying "Dave was late"), and the content of files. Neither is addressable by
structure; both remain the tenant's responsibility as controller. **[LEGAL]**

Company deletion needs no class table: every org-scoped row goes, verified against the catalogue.

---

## 5. Security properties

| Property | How it is enforced |
|---|---|
| **Owner-only, server-side** | Three layers: the action checks `ctx.membership.role`; `privacy_request_create` re-reads the membership `FOR UPDATE` and raises `42501`; the claim re-verifies at run time. The UI hides the control from non-owners but is not relied on. |
| **Re-authentication** | `server/auth/reauth.ts`: either the account password is verified now against Supabase Auth with a throw-away, non-persisting client, **or** — for magic-link / Google accounts with no password — the session's most recent authentication (`amr` timestamp in the validated access token) must be ≤ 10 minutes old. A stale session cannot delete anything. |
| **CSRF** | Mutations are Next.js **server actions** (Origin/Host checked by the framework; not reachable as a simple cross-site form post) and additionally require the password or a just-established session plus a typed confirmation an attacker cannot know. No deletion is reachable by GET. |
| **Cross-tenant** | The org id is taken from the caller's own session context, never from a form field; `privacy_request_create` requires the actor to be a member of that org; the engine takes only a **request id** and every primitive reads its target **from the ledger row**. |
| **Not reachable with the anon / user key** | Every function is `SECURITY DEFINER`, `revoke`d from `public, anon, authenticated`, granted to `service_role`, and re-checks `auth.role() = 'service_role'` in the body. None takes an org id from an untrusted caller, so the `current_org_ids()` rule for client-reachable RPCs is not engaged — and they are deliberately *not* client-reachable. |
| **New tables** | `privacy_deletion_requests`, `privacy_retained_billing_records`: RLS on, no policy, no client grant, `data-api:exempt:` markers. |
| **Idempotent / resumable** | Steps recorded in the ledger; SQL steps record themselves in the same transaction as their work; external steps are idempotent by construction (§3.2 table). |
| **Double submit** | Partial unique indexes allow one live request per target; the create primitive returns the existing row (`created:false`), including when it loses an insert race. |
| **Deletion racing a role change** | Ownership re-verified under row locks at create, at every claim, and (accounts) at lockout. |
| **Deletion racing an in-flight write** | Lockout commits the removal of memberships and API keys first, so nothing is still authorised to write; teardown then removes the org row (a straggler fails its FK) and verifies the catalogue is clean before committing. |
| **Two runners** | Leased claim; the loser gets nothing. A dead runner's lease expires and the next claim resumes. |
| **Evidence without the data** | The sealed row holds kind, opaque ids, timestamps, per-table **counts**, actor **role**. A CHECK forbids a sealed row from carrying the working set; a trigger makes sealed rows immutable and undeletable; error codes are symbolic (`step:sqlstate`), never raw messages. |

---

## 6. External providers

| Provider | Holds | Done by code | Not possible via API | Manual / founder step |
|---|---|---|---|---|
| **Stripe** (live) | Customer (name, email, address), subscription, invoices, payment method | Subscriptions **cancelled first**, fail-closed. Customer / subscription / invoice ids archived (minimised). | — | **Customer is deliberately not deleted**: its invoices are CrewFlow's own accounting records (6 y **[LEGAL]**). Deleting a Stripe customer is permanent and does not remove invoices anyway. After retention: redact via Stripe's data-redaction tooling (Dashboard). Detach the saved payment method if wanted sooner (Dashboard). |
| **Supabase Auth** | `auth.users`, identities, sessions, MFA | Hard or soft delete via the Admin API; sessions revoked; local `auth.audit_log_entries` rows for the user removed. | On hosted Supabase auth events go to the platform log pipeline (prod `auth.audit_log_entries` has 0 rows — VERIFIED catalogue count); those logs cannot be edited. | None — they age out with the plan's log retention. |
| **Supabase Storage** | Tenant files | Removed through the Storage API (object + bytes); teardown refuses to run while any remain. | — | — |
| **Resend** (live) | Sent-email log: recipient, subject, body | Nothing. CrewFlow uses no Resend audiences / contacts. Local queue rows (`notification_email_queue`) are deleted. | No endpoint deletes an individual sent email. | Logs expire on Resend's plan retention. Put the period in the privacy notice. A bespoke request goes to Resend support. **[LEGAL]** |
| **Sentry** (live) | Error events | Nothing needed by design: `sendDefaultPii:false`, `scrubEvent` on every event, no `setUser`, replays off. | — | If an incident ever shows PII in an event: delete that issue in the Sentry UI. Events expire on plan retention. |
| **PostHog** | Product events | Nothing needed: the server sink keys events by a **hash of the org id**; no person profile. | — | — |
| **Anthropic** (keys disarmed locally; tiers armed in prod) | Prompts / outputs in transit | Local AI history deleted (`ai_quote_drafts`; `ai_invocations` holds hashes and token counts only). | No API deletes individual requests; provider-side retention is contractual. | Record Anthropic's retention period in the sub-processor list. **[LEGAL]** |
| **Twilio / Meta WhatsApp** (dormant) | Call / message logs, recordings, media | Local rows go with the org. No provider call — the integrations are dark and must stay dark. | — | **Before either is activated**, add a provider step (Twilio: delete recordings / messages by SID; Meta: none available). Recorded as a pre-activation condition (§10). |
| **Vercel** | Request logs (IP, path) | — | Not editable. | Age out on plan retention. |

---

## 7. Backups and restores

| Copy | Retention | Effect on deleted data |
|---|---|---|
| Supabase managed backups | 7 daily (Pro; PITR off) | Deleted data is gone from them within 7 days. |
| Off-platform encrypted dump (`scripts/ops/off-platform-backup.sh`, B2) | Last 8 (weekly ⇒ ~8 weeks) | Gone within ~8 weeks. |

Deleted data is **not** removed from existing backups — rewriting encrypted archives is neither practical nor
required; it is "put beyond use" and ages out. Maximum residual lifetime in any backup: ~8 weeks. This must be
said in the privacy notice. **[LEGAL]**

**The restore problem.** A backup taken before a deletion contains the deleted data and — because the ledger
is in the same database — does **not** contain the tombstone. Restoring it would silently resurrect erased
people and companies.

**The design.**

1. **Tombstones leave the database.** `privacy_tombstone_export(since)` returns every sealed tombstone as
   opaque JSON (id, kind, target ids, completed-at). The backup job writes it to a **separate, append-only
   object** beside — never inside — the dump (`tombstones.jsonl`), exempt from the keep-last-8 rotation. It is
   safe to keep indefinitely: no personal data. *(The SQL and `exportTombstones()` are implemented and tested;
   wiring the extra upload into the backup script is a staged change — §10 — because that script runs against
   production.)*
2. **Every restore re-applies them before the app reopens.** `reapplyTombstones(tombstones)` →
   `privacy_tombstone_reapply` decides per tombstone: already honoured / nothing to re-apply / an in-flight job
   the restore rewound (made due now) / target is back → record a new request (`actor_role =
   'restore_reapply'`, `reapply_of` = the tombstone) — and the normal engine runs it through the same
   resumable steps. No confirmation is re-collected: the authority is the original, completed deletion.
   VERIFIED by test (a deleted account and a deleted company are "restored" and re-erased).
3. **Runbook addition** (proposed text for `docs/backup-recovery-runbook.md`, restore Step 3): *"Before
   removing maintenance mode: fetch the latest `tombstones.jsonl`; run the tombstone re-application; confirm
   every line reports `already_applied`, `nothing_to_reapply` or a completed run. Do not reopen until it does."*

Limit, stated: a restore to a point *after* the last tombstone export but before a later deletion would miss
that deletion. Mitigation: export tombstones on every deletion completion as well as with each backup (the
staged change does both).

---

## 8. Legal judgements required

None of these is settled by engineering. Each is implemented in the conservative direction noted, and each is
a one-line registry or constant change if counsel decides otherwise.

| # | Question | Implemented as | Where to change |
|---|---|---|---|
| L1 | Is CrewFlow a **processor** for tenant business/employment data, so that on company deletion it deletes rather than "anonymises and keeps" the tenant's ledgers? | Yes — full teardown; export offered first. | Architecture (§3.2). |
| L2 | What must CrewFlow keep of **its own billing** of a deleted customer, and for how long? | Minimised amounts / dates / Stripe handles; 6 years after the year end; Stripe customer retained. | `BILLING_RETENTION_YEARS`; `privacy_org_teardown`. |
| L3 | May an **employee self-erase** employment records the company holds? | No — account only; records stay with the employer as controller. | §2; `user-erasure.json`. |
| L4 | **Retention periods** for payroll (3 vs 6 y), pension (6 y), working time (2 y), leave / SSP. | Retained indefinitely *by the tenant*; CrewFlow enforces no purge. | `user-erasure.json` reasons; a future tenant-side retention policy. |
| L5 | **NI number**: keep with payroll, or always delete? | Kept only while a payroll line exists. | `conditional` class. |
| L6 | **Signed H&S / quality evidence** (name snapshot on acknowledgements, inductions, sign-offs, NCRs): retain against an erasure request? | Retained (Art. 17(3)(b)/(e)). | `retain` class. |
| L7 | **Authored-by references** — pseudonymise (kept) vs detach. Voice notes and photos especially. | Pseudonymised; content untouched. | default class. |
| L8 | Is a **7-day cooling-off** acceptable delay? Should billing stop at request rather than at execution? | 7 days; billing stops at execution. | `ORG_DELETION_COOLING_OFF_SECONDS`. |
| L9 | When a company is deleted, are **members' accounts** deleted too? | Yes, if they belong to no other company (an account with no company holds personal data for no purpose). | `identities` step. |
| L10 | **Backups**: is "beyond use, ages out in ≤ 8 weeks" acceptable, and is it disclosed? | Yes, by design; disclosure is a privacy-notice edit. | Privacy notice. |
| L11 | **Security logs** (`admin_activity_log` is immutable; `actor_email` / metadata cannot be scrubbed). Retention period and lawful basis. | Retained; `actor_id` detached. | A sanctioned audit-retention primitive (reserved hook exists). |
| L12 | CrewFlow's **own sales records** about the person who became the customer (`demo_requests` scrubbed; `hq_sales_*`, `hq_memories`, `waitlist` not linked by key). | `demo_requests` scrubbed automatically; the rest manual. | §10. |
| L13 | **Sub-processor retention** (Resend, Anthropic, Vercel, Supabase logs) that CrewFlow cannot shorten — disclosed? | Documented here; disclosure is a notice edit. | Privacy notice / DPA. |
| L14 | The **event spine** (`hq_events`, append-only, partition-retained) holds business-event payloads keyed by entity id. Is partition expiry sufficient? | Left; ages out by partition retention. | A producer-payload audit (§10). |

---

## 9. Activation (founder)

1. Counsel reviews §8.
2. Apply migrations `20261311`–`20261314` (additive; the only change to existing objects is the teardown
   escape added to 19 guard functions — listed in `20261312`).
3. Set `FEATURE_ACCOUNT_DELETION=true`. The daily `retention-purge` cron then also drains due requests.
4. Update the privacy notice (backups, sub-processors, cooling-off) and the restore runbook (§7.3).
5. Approve the staged backup-script change (§10).

---

## 10. Known gaps and follow-ups

| Item | Severity | Why not done here |
|---|---|---|
| Retire `POST /api/gdpr/erase` + `gdpr_erase_org` (cannot complete; destroys files then rolls back). | P1 (latent — dark) | Removing an existing route / function is a separate, reviewed change. Until then **do not enable `FEATURE_GDPR_ERASURE`**. |
| Tombstone upload in `off-platform-backup.sh`. | P2 | Script runs against production; staged under `staged-migrations/`. |
| No **ownership transfer** — a sole owner can only delete the company. | P2 | A new authorisation feature; out of scope. |
| `staff_compensation` has no `org_id`: a person in two companies has one shared pay / emergency-contact row. | P2 (0 multi-org users in prod per programme notes) | Pre-existing schema issue; reported, not changed. |
| `hq_memories` / `hq_sales_*` / `waitlist` rows about a deleted customer. | P2 | No reliable key; manual purge. |
| `hq_events` payload audit for incidental personal data. | P3 | Requires reviewing every producer. |
| Purge of `privacy_retained_billing_records` after `retention_until`. | P3 (first due 2032) | Irreversible; staged for approval. |
| Twilio / Meta provider deletion step. | Pre-activation condition | Integrations are dark and must stay dark. |
| Coordination: another workstream added `subscription_cancellations` concurrently. The teardown verifier is catalogue-driven, so it will **refuse** to complete if that table neither cascades from `organizations` nor is handled — by design. Reconcile at merge. | Note | Not this workstream's table. |
