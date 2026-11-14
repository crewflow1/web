# Account & data deletion — evidence

Everything here was run on **2026-11-14** against the shared **local** Supabase stack (Postgres 17.6, real
Storage, real GoTrue) with **synthetic data only**. Nothing was run against production; production was read
for catalogue facts only (role privileges, one aggregate row count), as noted.

Labels follow AGENT-RULES §5: **VERIFIED** (ran it, saw it) · **SIMULATED-ONLY** · **NOT-IMPLEMENTED**.

How to reproduce the suites:

```bash
source /Users/moetalibi/Code/cf-wt/_shared/local-env.sh
for f in supabase/migrations/2026131[1-4]000000_*.sql; do psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DB_URL" -c "notify pgrst, 'reload schema'"
npx vitest run --config vitest.integration.config.ts __tests__/integration/privacy
```

---

## 1. What the existing erase does (STEP 1)

### 1.1 Method

A catalogue-driven fuzz fixture (`tools/fixture-create.sh` → `tools/synthetic-seed.sql`) builds one synthetic
company and writes three distinctive marker strings (a name, an email stem, a phone number) into **every text /
citext / jsonb column of every org-scoped table the schema will accept a row for**, plus one marker-named
object in each of the 13 storage buckets, plus two real auth users. `tools/residue-scan.sql` then searches
every text-like column of every ordinary table in **every non-system schema** (`public`, `auth`, `storage`, …)
for each marker. Nothing is assumed about where personal data "should" be.

| Fixture fact | Value |
|---|---|
| Org-scoped tables seeded by the fuzzer | **156 of 237** (the other 81 refuse a generic row: state-machine triggers, composite CHECKs — listed by the tool; they are covered instead by the cascade verifier, §2.3) |
| Marker locations before any deletion | **584** `(schema.table.column, marker)` pairs, **635** hits, across **148** tables incl. `auth.users`, `auth.identities`, `auth.audit_log_entries`, `storage.objects`, `public.users`, `public.organizations`, `public.hq_events_2026_11` |
| Storage objects | 13, one per bucket, nested two levels under `<org_id>/` |

### 1.2 Result of running the existing service — VERIFIED

`tools/run-existing-erase.ts` calls the unmodified `eraseOrg()` exactly as the gated route would.

```
ERASE FAILED: gdpr erase: new row for relation "cis_subcontractors" violates check constraint "cis_subcontractors_outcome_dated"
storage objects for the org after the failed run: 0        (17 before)
```

The row that triggers it is a **default** CIS subcontractor (`cis_status='unverified'`,
`verification_reference` NULL): the name-based scrub sets `verification_reference='[erased]'`, which the
constraint forbids for an unverified subcontractor.

Replaying the function's logic table-by-table inside a rolled-back transaction, with each failure caught
instead of aborting, gives the full list **for the 156 seeded tables**:

| Phase | Table | Failure |
|---|---|---|
| anonymise | `cis_subcontractors` | CHECK `cis_subcontractors_outcome_dated` |
| anonymise | `supplier_payments` | CHECK `supplier_payments_void_evidenced` |
| hard-delete | `comm_events` | `comm_events is append-only — DELETE is not permitted` |
| hard-delete | `job_milestones` | `a programme milestone cannot be deleted — supersede the baseline instead` |
| hard-delete | `job_programme_baselines` | `a programme revision cannot be deleted — the baseline history is the audit trail` |
| hard-delete | `asset_inspection_templates` | `asset_inspections.template_id is immutable once set` (the `ON DELETE SET NULL` on the child) |

Any one of these aborts the single transaction. The 81 unseeded tables include most of the H&S and
receptionist evidence tables, which carry further guards of the same kind, so this list is a floor.

Also VERIFIED on the same fixture, each in a rolled-back transaction:

- `delete from organizations where id = …` → `ERROR: comm_events is append-only — DELETE is not permitted`.
  Before this workstream **a tenant holding one logged communication could not be deleted by any path**.
- `delete from auth.users where id = <staff>` while the org lives → `ERROR: blueprint_versions are immutable`
  (raised by the `ON DELETE SET NULL` on `uploaded_by`).

These are pinned as characterisation tests (`existing-erase-baseline.test.ts`, 3 cases, passing):

| Case | Asserts |
|---|---|
| Ordinary company (customer, job, message, one comms event, staff footprint, 4 files) | `eraseOrg` rejects with `comm_events is append-only`; every DB row still present; **no `gdpr_erasure_log` row**; **storage objects 4 → 0**. |
| One default CIS subcontractor | `eraseOrg` rejects with `cis_subcontractors_outcome_dated`. |
| Near-empty company (it completes) | Marker scan still finds `organizations.name/phone`, `users.full_name/email/phone`, `staff_compensation.emergency_contact`, `auth.users.email`. |

### 1.3 Summary — what it deletes, anonymises, retains, misses

| | |
|---|---|
| Who may invoke | Org owner or super-admin; `FEATURE_GDPR_ERASURE=true`; `confirm` = org slug. No re-auth, no cooling-off. |
| Production status | Gated **off**; per the privacy workstream's production aggregates it has **never run** (0 exports, 0 erasures). The defects are latent. |
| Intended to delete | 185 org-scoped tables + all org-prefixed storage objects. |
| Intended to anonymise in place | 38 "statutory" tables (PII-named columns → `'[erased]'`). |
| Intended to retain | 14 CrewFlow-side / evidence tables. |
| Actually does, on a populated org | **Removes the files, then fails and rolls the database back.** |
| Misses even when it completes | The `organizations` row (name, slug, phone, billing email, address); `public.users`; `auth.users` / identities / sessions; `staff_compensation`; `mfa_recovery_codes`; Stripe; every provider. No per-person erasure of any kind. |
| Test coverage before | Source-text assertions only; one behavioural call on an org with a single `activity_log` row. |

**Finding F-1 (P1, latent):** do not enable `FEATURE_GDPR_ERASURE`. Retire the route (DESIGN §10).

---

## 2. Company deletion (owner) — VERIFIED

`company-deletion.test.ts` — 15 cases, all passing. Stripe is a recording stand-in (**SIMULATED-ONLY**: no
call to Stripe was made; the *ordering, idempotency key and fail-closed behaviour* are what is proved).

| # | Requirement | Case | Key assertions |
|---|---|---|---|
| 1 | Complete deletion | *deletes the whole company…* | org row gone; 0 rows in customers / jobs / messages / comm_events / memberships / payroll / time entries / NI / billing; **0 storage objects** (4 before, nested); the 3 sole-company members' auth users are gone and a pre-deletion access token no longer resolves; step order is exactly `stripe_cancel → lockout → storage → teardown → identities`. |
| 2 | No residue | same | `privacy_residue_scan` (catalogue-wide, all schemas): >15 locations before; afterwards the **only** hits are the still-live account of the member who also works for another company. |
| 3 | No cross-tenant effect | same, and #8 | A canonical JSON snapshot of the bystander company — every row of every org-scoped table, its org row, its users' profiles and auth records, pay rows, storage count — is **string-identical** before and after. |
| 4 | Export-before-delete | same | `buildOrgExport` as the owner returns the company's customer during the cooling-off. |
| 5 | Retained records | same | `privacy_retained_billing_records` holds exactly `org_account` + `billing_invoice`: Stripe handles, amount 99, `GBP`, `retention_until` = 31 Dec six years on; contains **no marker** although the source invoice's `notes` did. |
| 6 | Tombstone | same + *sealed tombstone* | status `completed`, `actor_role='owner'`, per-table counts, `work = {}`; JSON contains none of name / email / phone / slug; UPDATE and DELETE of a sealed row are refused. |
| 7 | Idempotency | same | second run → `not_claimed`, no further Stripe call, ledger row byte-identical. |
| 8 | Interrupted then resumed | *interrupted right after `<step>`* — **5 separate cases**, one per boundary | Die immediately after the step is recorded → status `failed`; resume → `completed`; the recorded step is **not** repeated; Stripe cancelled exactly once; **residue scan returns nothing at all**; attempts = 2; bystander snapshot identical. (Was one looped test taking ~10 s of a 30 s budget; under load from another workstream's suite it failed once for the lead. Split so each case is ~5 s (measured while another workstream's Playwright sweep was running) with its own 120 s budget — same assertions, plus the bystander snapshot now per boundary.) |
| 9 | Concurrency | *hard crash … two runners* | A runner killed so hard it cannot record failure leaves `running` + a lease; a second runner gets `not_claimed`; after lease expiry two simultaneous runners yield exactly one `completed` and one `not_claimed`. |
| 10 | Double submit | *double submit…* | 3 concurrent submits → 1 request id, `created` true once, 1 ledger row. |
| 11 | Authorisation | *authorisation…* | admin, staff, and the owner of another company are each refused `forbidden`; wrong / blank / slug / other-company name refused `confirmation`; no ledger row, no data change. |
| 12 | Not reachable by clients | *primitives are unreachable…* | 11 primitives × {anon key, the owner's own JWT} all refused; ledger and archive tables unreadable and unwritable by both. |
| 13 | Cancel | *double submit…* | staff / admin / outsider cannot cancel; the owner can; a cancelled request never runs; a new request can then be made. |
| 14 | Racing a role change | *deletion racing a role change* | ownership moved during cooling-off → run returns `cancelled`, reason `requester_not_owner`; **Stripe not called**; org, rows, memberships, files all intact. |
| 15 | Stripe fail-closed | *Stripe fails closed* | no client → `stripe_cancel:stripe_unconfigured`; Stripe error → `stripe_cancel:stripe_error`; nothing destroyed either time; subscription already gone at Stripe → completes. |
| 16 | Fail-closed teardown | *teardown refuses…* | a storage step that removes nothing → teardown raises, **rolls back completely**: org row, customer, comms event and files all still present. |
| 17 | Cooling-off | #1 | request is `scheduled` ≈ 7 days out; the engine returns `not_claimed` before then. |

Also `drain.test.ts` (1 case): the cron drain is inert with the flag unset; with it on, it completes the due
request and leaves the one still cooling off.

### 2.1 Fuzz-fixture run of the new flow — VERIFIED

Same method as §1, fresh fixture, through `tools/run-org-deletion.ts`:

```
before : 584 marker locations / 635 hits in 148 tables; 13 storage objects in 13 buckets; 2 auth users
run    : {"status":"completed","kind":"org"}     teardown: 154 tables, 177 rows · storage: 13 objects · identities: 2 hard-deleted
again  : {"ok":false,"code":"not_found"}         (the company no longer exists)
after  : 1 marker location / 2 hits · 0 storage objects · 0 auth users
```

The one survivor is `public.hq_events_2026_11.payload`. It is a fuzzing artefact: the event spine copies a
**whitelisted** payload from an activity (`hq_emit_from_activity`: status, quote/invoice *number*, total,
changed-field *names*), and the fuzzer wrote the name marker into `invoices.number`. Real invoice numbers are
sequence codes. No name, email or phone column is in the whitelist (read from the function source). The table
is append-only and partition-retained.

### 2.2 What had to change in existing objects — and the escape that was wrong first time

`20261312` re-creates **19** guard functions (`tg_comm_events_frozen`, 15 `receptionist_*_block_mutation`,
3 `ai_reply_*_block_mutation`) so that a company holding their rows can be deleted at all.

**First version (withdrawn).** It gave them the existing 20261052 idiom — "let the DELETE through when the
organisation row is absent". That was wrong for these tables: 18 of the 19 carry `org_id` with **no foreign
key**, so a row can hold an org id that matches no organisation, and every such row became deletable by
anyone with DELETE rights. The tenant-isolation workstream caught it: **17 existing receptionist append-only
tests failed** (they write rows with a random org id and expect DELETE to be refused).

**Current version.** A DELETE is admitted only when **all four** hold for the row's org: (1) the
transaction-local setting `crewflow.privacy_teardown_org` equals that org id — set in one place, inside
`privacy_org_teardown`, and gone when that transaction ends; (2) the caller is `service_role`; (3) the
organisation row no longer exists; (4) a company-deletion request for that org is `running` in the ledger.
With no sanctioned teardown in progress the tables are exactly as append-only as before, orphan rows included.

| Check | Result |
|---|---|
| `__tests__/integration/receptionist` (47 files) — **unmodified** | **all pass** (run together with the privacy suites and two RLS suites: 55 files, 411 tests, 0 failed) |
| *append-only evidence stays append-only* (new case) | With no request: DELETE refused for the live org's ledger row, for an **orphan** row, and for `comm_events`. With a deletion **running** for that org: a direct service-role DELETE is still refused, and so is a bare `delete from organizations`. After the sanctioned teardown: the org's rows are gone, **the orphan row is still there** and still undeletable. |
| Does the pre-existing 20261052 rule share the weakness? | **No, on the evidence available.** The 30 other tenant-table delete guards that use "organisation absent" all sit on tables whose `org_id` is NOT NULL and participates in a foreign key (catalogue query, 30 / 30), so an orphan row cannot exist there. The transitive chain of each composite FK was not walked. Nothing was changed in those guards. |

**The sweep.** Because those ledgers have no FK on `org_id`, no cascade reaches them. After removing the
organisation row the teardown now deletes, explicitly, from every table the catalogue shows still holding the
org's id (FK-retry loop), then verifies. VERIFIED: a `receptionist_conversation_executions` row for the test
company is gone after deletion, and the tombstone records `tables_swept_without_fk ≥ 1`.

Consequence, stated: a plain service-role `delete from organizations` still fails for an org with comms or
receptionist evidence — **only the sanctioned teardown can remove such a company**. That was already true
before this workstream; it is now deliberate.

Drift guard: of **53** row-level delete guards on tenant tables, 49 reference `organizations` (30 pre-existing
+ these 19) and the other 4 test their parent row instead (reviewed, allow-listed by name); a new
unconditional guard fails CI.

### 2.3 Why unseeded tables are still covered

The teardown does not enumerate tables to delete. It deletes the organisation row and then **asks the
catalogue** for every table with an `org_id` column and raises — rolling everything back — if any still holds
the org's id. A table that neither cascades nor is handled cannot be silently skipped.

---

## 3. Individual account deletion — VERIFIED

`account-deletion.test.ts` — 7 cases, all passing.

| Requirement | Assertions |
|---|---|
| Complete deletion, no statutory footprint | Auth user **hard-deleted**, profile gone, old token dead, re-login refused; **residue scan returns nothing**; NI number and date of birth deleted. **The company is not deleted**: org row, customer, the other membership, 4 files, the owner's login all intact. |
| Statutory footprint | Delete-class rows gone (6 tables + pay / emergency contact); payroll line, NI number and DOB **retained** with the same user id; time entry kept with `note`, `gps_lat`, `gps_lng` NULL; sick-leave row kept with `reason` NULL; authored note intact; profile = `Deleted user` / `deleted-<id>@deleted.invalid`; auth row soft-deleted (email hashed, metadata `{}`, `deleted_at` set); sessions revoked; **residue scan returns nothing**; tombstone records per-class counts. |
| Sole owner | Refused `sole_owner`, no ledger row, account intact; allowed once a second owner exists, and the company survives. |
| Racing a role change | Co-owner demoted after the request is recorded → `cancelled / sole_owner`; nothing deleted. |
| Authorisation | The company owner cannot create an account deletion for an employee (`42501`); wrong confirmations refused. |
| Several companies + interruption | Crash after the first company → one membership left, account still exists; resume finishes the second only; an unrelated third company's snapshot is string-identical. |
| Concurrency | Two simultaneous submits → one request, one deletion. |

## 4. Staff erasure by an admin — VERIFIED

`staff-erasure.test.ts` — 4 cases, all passing.

| Requirement | Assertions |
|---|---|
| Erasure | Membership and personal rows gone; payroll retained; time entry scrubbed; pay / emergency-contact row gone; **the person's account survives** (same email, can sign in); markers remain *only* in their own live account; three colleagues and the company untouched; tombstone `actor_role='admin'`. |
| NI number / DOB / pay / emergency contact | No payroll line → NI number **and** date of birth deleted. Still employed by a second company → the org-less pay / emergency-contact row is **left and reported**; the second company's snapshot is string-identical. |
| Authorisation | Refused: staff→staff, outsider, outsider with own org id, admin→self, admin→owner, owner→self, subject→self, admin→admin, wrong email. Owner→admin allowed. |
| Containment | A staff-erasure request cannot call the identity primitive (`42501`) nor be aimed at another org the person belongs to (`42501`). |

**Does this close the "removed staff keep NI / DOB / pay / emergency contact forever" gap (privacy workstream
G-7)?** For a person erased through this flow: **yes** for NI number and DOB (deleted unless a payroll line
needs them — then retained with a stated reason), **yes** for pay and emergency contact when they belong to no
other company, **no** when they do (the row has no `org_id`, so it cannot be attributed; it is reported in the
tombstone). It does **not** change the existing "Remove from team" action, which still deletes only the
membership — erasure is a separate, explicit act. Retro-erasing people already removed is possible (the
account-deletion org list is catalogue-driven) but there is no admin entry point for a former member yet.

## 5. Restore and drift — VERIFIED

`restore-and-drift.test.ts` — 6 cases, all passing.

- A deleted company re-created under its original id with a member, a customer and files is **re-deleted from
  its exported tombstone alone** (`reapply_scheduled → completed`); residue scan empty; the re-application is
  itself idempotent; a tombstone whose target never came back → `nothing_to_reapply`.
- A deleted person whose profile, membership and a notification are "restored" is erased again; payroll stays.
- The exported tombstone has exactly six keys, none personal.
- Drift guards: 0 unclassified hard user references (26 hard of 254; 24 per-org + 2 user-keyed); no dead
  registry entries; 0 blocking delete guards; all 13 buckets in the census; the scan refuses markers < 6 chars.

## 6. How `activity_log` is treated

The table is append-only (20261214) and its triggers copy the actor's name, and for some actions customer
details, into `actor_name` / `metadata`.

| Flow | Treatment | Evidence |
|---|---|---|
| Company deletion | Every row goes with the organisation (the guard permits the cascade once the org row is gone). | 13 `activity_log` rows counted and removed in §2.1; scan clean. |
| Account deletion / staff erasure | Rows where the person is the **actor** get the one update the guard allows: `actor_name='[erased]'`, `metadata='null'`. | Residue scans in §3 / §4 are clean. |
| Rows about a **customer**, written by other people | **Not touched** by a per-person flow — they are the company's audit trail and are not keyed to the departing person. They go when the company is deleted. A customer's own erasure request is a tenant-side capability that does not exist yet. | Stated limit. |

## 7. What is retained, and why

| Retained | Where | Why | Until |
|---|---|---|---|
| Tombstone (opaque ids, counts, role) | `privacy_deletion_requests` | Proof of completion; restore re-application | Indefinitely (no personal data) |
| CrewFlow's billing of a deleted company | `privacy_retained_billing_records`; Stripe customer + invoices | CrewFlow's own tax records **[LEGAL]** | 31 Dec, 6 years on |
| Payroll lines, pension enrolment, holiday entitlement | tenant tables | Statutory employment records **[LEGAL]** | Tenant's decision / company deletion |
| NI number, date of birth | `staff_secrets`, `payroll_tax_profiles` | Only while a payroll line exists **[LEGAL]** | As above |
| Working-time and leave rows (scrubbed) | `time_entries`, `leave_requests` | WTR records **[LEGAL]** | As above |
| Signed H&S / quality evidence incl. name snapshot | `safety_acknowledgements`, `site_inductions`, `inspection_signoffs`, `non_conformance_reports` | Evidence of duty discharged **[LEGAL]** | As above |
| Authored-by references | 226 nullable columns | Company's business records; identity behind them removed | As above |
| HQ security log | `admin_activity_log`, `impersonation_sessions` | Security; immutable **[LEGAL]** | Not yet bounded |
| Event spine | `hq_events_*` | Whitelisted business events, no identifiers | Partition retention |
| Backups | Supabase 7 daily; off-platform last 8 | Cannot be rewritten; beyond use **[LEGAL]** | ≤ ~8 weeks |

## 8. The user-facing flow

Built behind `FEATURE_ACCOUNT_DELETION` (default off): `server/auth/reauth.ts`; actions in
`app/(app)/settings/account/actions.ts` and `app/(app)/staff/erasure-actions.ts`; Settings → Account page;
an erasure panel on the staff page; a link from Settings.

| What | Test | Result |
|---|---|---|
| Re-authentication logic | `__tests__/privacy/reauth.test.ts` (9) | **VERIFIED.** Newest `amr` entry wins, `token_refresh` ignored; 10 malformed tokens all read as not-fresh; window edge exact (600 s ok, 601 s not); future timestamps rejected; another user's fresh token rejected; a **wrong password never falls back** to a fresh session; errors fail **closed** (`unavailable`). |
| Re-authentication against real GoTrue | `__tests__/integration/privacy/reauth.test.ts` (2) | **VERIFIED.** Real password accepted; wrong password and another account's password refused; the throw-away check session is discarded **without ending the user's own session**; a real access token carries an `amr` timestamp within seconds of now and reads fresh; the same token 11 minutes later does not. |
| Action-level authorisation | `__tests__/privacy/deletion-actions.test.ts` (23) | **VERIFIED** (service layer mocked — its behaviour is §2–§4). Flag off → each of the 4 actions returns before any session read. Company deletion: admin / staff refused before re-auth; consequences box required; failed re-auth → service never called; **forged `org_id` / `user_id` / `request_id` form fields are ignored** — the service receives the session's org and user. Cancel: takes **no input** (function arity 0); request resolved from the session org. Account: always the session user; sole-owner refusal (at create and at run) reported, no sign-out. Staff erasure: staff refused; self / non-uuid / empty target refused before re-auth; owner and admin allowed for the session org only. |
| Browser happy paths | `e2e/account-deletion.spec.ts` | see below |

**Browser run** (Playwright, Chromium, against `next dev` on port 3106 started with
`FEATURE_ACCOUNT_DELETION=true`, local stack, synthetic people):

PLAYWRIGHT_RESULT_PLACEHOLDER

The spec has two modes: with the capability off (CI's default, and production today) it asserts the dark
state — support-assisted panel, no deletion control; with `E2E_ACCOUNT_DELETION=1` it runs the three flows.

Not verified in a browser: the passwordless path (sign out / sign in / return within 10 minutes) — its logic
is covered by the two reauth suites; the Google and magic-link sign-ins themselves cannot be driven locally.
`next dev` rather than a production build was used (a build was not affordable on the shared machine).

## 9. Regression and guard suites

| Suite | Result |
|---|---|
| `__tests__/integration/privacy` (7 files) | **38 / 38 passed** |
| `__tests__/privacy` unit (reauth, deletion-actions; plus the pre-existing consent test) | **45 / 45 passed** |
| `__tests__/integration/receptionist` (47 files, unmodified) + privacy + `org-teardown-cascade` + `audit-log-immutability`, under `heavy.sh` | **55 files, 411 / 411 passed** |
| Security tier: `gdpr-erase`, `gdpr-export`, `migration-data-api-grant-guard`, `loud-read-failures`, `f1-bare-select-guard`, `f1-limit-clamp-guard`, `f1-pagination-guard`, `cron-fairness-guard`, `env-contract-census`, `retention-purge-primitive`, `retention-policy-exclusions`, `membership-role-derivation`, `staff-competencies` | **all passed.** Two guards fired during the work and were satisfied, not loosened: the env census (until `FEATURE_ACCOUNT_DELETION` was declared in `lib/env.ts`) and the loud-read shape ledger (a discarded `getSession` error in `reauth.ts`, now bound and thrown). |
| Unit: `__tests__/ui` (reachability, design-system adoption, tokens), `permission-editor`, `polish-batch`, `logo-wiring`, `hq-logout`, `sprint-a`, `gdpr-*-registry` | **all passed** (15 files / 285 tests; registry 23 tests) |
| Integration: `audit-log-grant-lockdown`, `audit-log-immutability`, `least-privilege-grants`, `org-teardown-cascade`, `secdef-org-rpc-guard`, `slice15-pr1-privilege-holes`, `slice15-pr2-cclass-least-privilege` | **all passed (67 tests)** |
| Integration: `rls/gdpr-export` | **10 / 11.** Case *5b REVERSE* fails on `subscription_cancellations` — a table created concurrently in the shared database by **another workstream**, not classified in `lib/gdpr/org-tables.json`. Not caused by this branch (its own tables use `target_org_id` and stay out of that census). To be classified by the lead when the branches meet. |
| `heavy.sh npm run typecheck` | **exit 0** (at `566c7dbe`; re-run after the last change — see the final report) |

## 10. Migrations — apply order and production preconditions

All four are additive. **None deletes or rewrites a row when applied.** They may be applied **before** the
code deploys, and the code may deploy before them, **as long as `FEATURE_ACCOUNT_DELETION` stays off** — with
the flag off no code path calls any of these functions (the cron drain returns before its first query; the
account page does not read the ledger). The flag must not be turned on until all four are applied.
Apply in numeric order (312–314 use `_privacy_require_service_role` from 311).

| Migration | Changes existing objects? | Safe before code? | Precondition query (read-only, catalogue) | Expect |
|---|---|---|---|---|
| `20261311` ledger, tombstone, retained-billing table, request lifecycle | No | Yes | `select to_regclass('public.privacy_deletion_requests'), to_regclass('public.privacy_retained_billing_records'), (select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'privacy\_%' or proname like '\_privacy\_%'))` | `NULL, NULL, 0` — the names are free |
| `20261312` teardown-safe guards, lockout, teardown | **Yes — `create or replace` of 19 guard functions** | Yes: with no marker set they behave exactly as now | `select p.proname, (p.prosrc ilike '%organizations%' or p.prosrc ilike '%current_setting%') as already_conditional, p.proconfig from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname ~ '^(receptionist_.*|ai_reply_.*)_block_mutation$' or p.proname='tg_comm_events_frozen') order by 1` | 19 rows, `already_conditional = false` on every row (i.e. production still has the unconditional bodies this migration replaces — if any row is `true`, someone changed a guard since and the migration must be re-read against it); `proconfig` NULL except `{search_path=public}` on `tg_comm_events_frozen` |
| | | | `select c.relname from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and (p.proname ~ '^(receptionist_.*|ai_reply_.*)_block_mutation$' or p.proname='tg_comm_events_frozen') and ((t.tgtype & 1)=0 or not exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='org_id' and not a.attisdropped))` | 0 rows — every such trigger is row-level on a table that has `org_id` (the guards read `old.org_id`) |
| `20261313` per-person erasure | No | Yes | none beyond 311 | — |
| `20261314` residue scan, drift introspection, tombstone export / re-apply | No | Yes | none beyond 311. `privacy_residue_scan` sequentially scans every text column — an operator tool, never to be run at peak. | — |

After applying, confirm the lockdown (expect every row `false, false`, and both tables RLS on / 0 policies):

```sql
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and (p.proname like 'privacy\_%' or p.proname like '\_privacy\_%')
order by 1;
```

(VERIFIED locally: 20 functions, all `false / false`; both tables RLS on, 0 policies, no client privilege.)

## 11. Not done

| Item | Label | Exact next step |
|---|---|---|
| Real Stripe cancellation | **SIMULATED-ONLY** | Exercise once in Stripe **test mode** with a founder-supplied test key. |
| Browser test on a production build; passwordless re-auth in a browser | **IMPLEMENTED-UNTESTED** in a browser (logic unit- and integration-tested) | Run `e2e/account-deletion.spec.ts` in CI with the flag on in a dedicated job. |
| Users with **no company** cannot open Settings → Account (the app shell requires an org) | **NOT-IMPLEMENTED** | Give `/settings/account` a route outside the org-gated shell, or handle via support. Affects someone erased from their only company who then wants their login deleted. |
| Erasing a person **already removed** from the team | **NOT-IMPLEMENTED** (no entry point; `privacy_request_create` requires a current membership) | Add an owner action that targets a former member by id, authorised by the org holding rows for them. |
| Notifying the other owners / admins when a company deletion is scheduled | **NOT-IMPLEMENTED** | The pending banner on Settings → Account is the only signal today; add an in-app notification (email is a customer communication and needs sign-off). |
| Tombstone upload in the off-platform backup script | **NOT-IMPLEMENTED** (SQL + `exportTombstones()` are VERIFIED) | See `staged-migrations/backup-tombstone-export.md`. |
| Provider deletion for Twilio / Meta | **NOT-IMPLEMENTED** by design | Pre-activation condition for those integrations. |
| Retiring `POST /api/gdpr/erase` | **NOT-IMPLEMENTED** | Separate reviewed change. |
| `privacy_tombstone_reapply` accepts any well-formed tombstone | Noted | It is service-role-only and operator-run by design (the ledger that would authenticate a tombstone is exactly what a restore loses). Never call it from a request path; consider signing the exported file. |
