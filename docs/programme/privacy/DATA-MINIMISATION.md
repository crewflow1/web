# CrewFlow — data-minimisation audit (Phase 6), 2026-11-13

**Question asked of every table, column, upload field, log and integration payload:** is this personal data CrewFlow (or the tenant using it) actually needs — and if not, is anything still writing or reading it?

**Method.** For each candidate: (1) trace every writer — UI form, server action, route handler, database function/trigger, cron, import; (2) trace every reader — screens, exports, PDFs, emails, integrations; (3) take an aggregate production count of non-null values; (4) decide: *legitimate need* / *unnecessary — remove* / *judgement call — recommend*. "No frontend reference" was never treated as proof on its own: migrations, triggers and server code were searched too, and the database catalogue was checked for dependent views, functions, indexes and constraints.

**Rule followed for changes.** Where collection was clearly unnecessary and removal low-risk: stop the write in code + add a regression test. **No column was dropped and no data deleted** — those steps are staged as approval-required SQL in `staged-migrations/`. Product or legal judgement calls are recommendations only.

Evidence labels per `AGENT-RULES.md` §5. Production counts are aggregates taken 2026-11-13.

---

## 0. Re-verification on main `d24295e8` (2026-11-16)

The branch was rebuilt from `origin/main` (`d24295e8`, prod) as `privacy/data-minimisation`; M-1–M-3 were
cherry-picked and re-checked against the code that landed since `8cec66a7` (D-17 staff field operations,
column ACLs 20261340–46, file-visibility 354).

| Fix | Re-check on current main | Result |
|---|---|---|
| M-1 clock-in GPS | Every `time_entries` writer in `app/ server/ lib/` (grep `from("time_entries")`): the only insert is still `clockIn` in `app/(app)/me/actions.ts`; D-17 (`20261346`) changes operations-table policies only and adds no clock-in path or location column; no `navigator.geolocation` / `getCurrentPosition` anywhere | VERIFIED — no re-introduction. `__tests__/security/clock-in-no-location.test.ts` 3/3 |
| M-2 avatar copy | No `avatar_url` write in `app/ server/ lib/` (only comments); `20261342` lists `avatar_url` in the colleague-readable column grant (dropping the column drops its privileges automatically; see the staged-SQL README for the follow-up) | VERIFIED. `no-avatar-collection.test.ts` 3/3 |
| M-3 rate-limit keys | `rate_limit_hit` is called only from `checkPersistent` (`lib/security/rate-limit.ts`), which digests the key; no new direct caller | VERIFIED. `rate-limit.test.ts` 18/18 |
| M-4 Sentry free text | Not on this branch — owned by the SECURITY workstream (see §1) | — |

**Public API of `lib/security/rate-limit.ts` is unchanged by this branch** apart from two additive exports
(`durableKey`, `sweepExpiredCounters`): `check`, `enforce`, `identifyRequest`, `identifyHeaders`, `checkPersistent`,
`consume`, `enforcePersistent`, `enforceIdentified`, `enforceIdentifiedStrict`, `DEFAULT_LIMITS` and the
`RateLimit*` types keep their signatures, so per-user AI route limits can call them as-is. Only the stored key
format changes (`<route>:h1_<digest>`), which callers never see.

### New findings on 2026-11-16

| # | Finding | Evidence | Decision | Label |
|---|---|---|---|---|
| M-5 | **Every password or magic-link sign-in erased the saved name and phone** (accuracy, Art. 5(1)(d) — formerly G-18) | `ensureUserRow` upserted `full_name: input.fullName ?? null, phone: input.phone ?? null`; the password path and a magic-link callback without OAuth metadata pass neither. Reproduced on the local PostgREST with a synthetic user: the null-filled upsert cleared both fields | **FIXED** (`server/services/bootstrap-account.ts`): a profile field is written only when a non-empty value is supplied. Test `__tests__/security/user-profile-accuracy.test.ts` (4); the local reproduction shows the new `{id,email}` upsert keeps saved values | VERIFIED |
| M-6 | **Photo uploads keep the camera's EXIF metadata, which can include the GPS position where the photo was taken** | `app/api/jobs/[id]/photos/route.ts` stores `await f.arrayBuffer()` unchanged; no EXIF handling exists anywhere (`grep -ri exif` over `app lib server components` = 0). The job-documents picker uses `capture="environment"`. Whether a given file carries GPS depends on the phone and its camera settings | RECOMMEND — **founder decision** (`COMPLIANCE-GAPS.md` G-24): strip location on upload, or keep it as site evidence and say so in the notice. Not changed: it alters evidential content and the upload pipeline other workstreams are testing (#1104) | VERIFIED (code); content of real files not inspected |
| M-7 | **Every magic-link sign-in puts the email address in a URL** — wider than G-10 | `app/(auth)/actions.ts:120` redirects to `/check-email?email=<address>`; `bounceToLogin()` (`app/auth/callback/route.ts:76`) adds `?email=` on a failed bootstrap. The URL reaches Vercel request logs and browser history, PostHog page-view URLs **after** analytics consent (`lib/analytics/sanitize-url.ts` masks UUIDs only, not query values), and Sentry breadcrumbs (masked only once the SECURITY branch's free-text scrub ships) | **FIXED** (`924774c1`): sessionStorage hand-off (no cookie), error-code-only bounce, address-quoting provider messages replaced, email dropped from the callback success log. Tests: `__tests__/security/auth-urls-no-email.test.ts` (13); e2e magic-link test in `auth-recovery-and-signup.spec.ts` | VERIFIED |

## 1. What was changed on this branch

| # | Finding | Before | Change | Commit | Regression test | Label |
|---|---|---|---|---|---|---|
| M-1 | **Clock-in accepted GPS coordinates** | `clockIn` copied `gps_lat`/`gps_lng` from the posted form into `time_entries`. No screen sends them and the Permissions-Policy denies geolocation, so the only route was a hand-crafted request — precise worker location stored with no notice, purpose or retention. `/me` selected the columns and never displayed them | Action ignores the fields; page no longer selects them | `671ee57a` | `__tests__/security/clock-in-no-location.test.ts` (3): a form post *with* coordinates produces an insert with no location keys; no executable reference in action/page; `geolocation=()` still in the header | VERIFIED |
| M-2 | **Google profile-picture URL copied on every sign-in** | `/auth/callback` read `avatar_url`/`picture` from the OAuth metadata; `ensureUserRow` upserted it to `users.avatar_url`. Nothing reads the column — no screen, export, email, PDF, view or function | Neither read nor written | `015c53fb` | `__tests__/security/no-avatar-collection.test.ts` (3): the upsert payload never carries `avatar_url`, even when a caller passes one; callback has no reference | VERIFIED |
| M-3 | **Rate-limit table stored raw IPs, emails and live portal tokens, forever** | `rate_limit_counters.key = "<route>:<identifier>"`, where the identifier is the visitor IP (quote links, public forms), the sign-in email, or the **customer-portal bearer token**. `rate_limit_sweep()` existed and was never called | Key is `<route>:h1_<HMAC-SHA256 digest>`; the daily housekeeping cron now calls the sweep | `afdbc459` | `__tests__/security/rate-limit.test.ts` (18, 6 new): no raw IP/email/token reaches the RPC; digest is deterministic and keyed; sweep is called and fail-soft. The previous assertion that pinned the raw email as the key was updated to expect the digest | VERIFIED |
| M-4 | **Error reports carried access tokens and identifiers** (integration payload) | Sentry scrubbing was by key name only. A synthetic event kept the token segment of `/customer-portal/<token>`, an email inside an exception message, and an email + phone in a console breadcrumb | `redactPathTokens` + `scrubText` applied to URL, message, exception values, breadcrumbs, spans | moved to the SECURITY workstream (`security/injection-secrets-hardening`, commits `be7140af` + `a0c26962`) — not on this branch | `__tests__/monitoring/scrub-free-text.test.ts` (on that branch) | VERIFIED on 2026-11-13; ownership transferred 2026-11-16 |

Tests and typecheck: see §6.

**Not deployed.** M-1–M-3 (and M-5, §0) are commits on `privacy/data-minimisation`, rebuilt on main `d24295e8` on 2026-11-16; M-4 ships with the security branch. Production behaves as "Before" until the lead merges and deploys.

---

## 2. Staged, approval-required removals (nothing applied)

| File | Removes | Evidence it is safe | Needs |
|---|---|---|---|
| `staged-migrations/20261308000000_drop_unused_personal_columns.sql` | `time_entries.gps_lat`, `gps_lng`; `users.avatar_url`; `demo_requests.user_agent` | prod: 0 GPS values (0 time entries), 2 avatar URLs, 0 user-agent values. `demo_requests.user_agent` has **no writer at all** (`app/api/demo/route.ts` insert lists every column it sets). No view/function/index/constraint depends on any of them (catalogue query) | M-1 and M-2 deployed first; two test files and `types.ts` updated in the same PR (listed in the file header) |
| `staged-migrations/20261309000000_drop_orphan_waitlist.sql` | table `waitlist` (email, company, phone, trade, employees, source, user agent, IP hash) | Its endpoint was removed 2026-10-19 (`lib/supabase/middleware.ts` note); no code reads or writes it; 0 rows in prod; no foreign keys | one test list updated (header) |
| `staged-migrations/20261310000000_purge_verbatim_rate_limit_keys.sql` | pre-digest rate-limit rows | optional — the daily sweep removes them within about a day of deploy | — |

---

## 3. Candidate-by-candidate findings

Legend — **Decision:** KEEP (legitimate need) · REMOVED (this branch) · STAGED (drop awaiting approval) · RECOMMEND (judgement call, not changed).

### 3.1 The categories the brief named

| Candidate | Where | Written by | Read by | Prod | Decision and reasoning |
|---|---|---|---|---|---|
| **Identity-document photos** | no dedicated field | — | — | — | **None collected by design.** No form asks for a passport or driving licence. Two general upload points *could* receive one: a staff qualification scan (`staff_qualifications.document_path` — CSCS-type cards often carry a photo) and "import a document" (`form-imports`, sent to Anthropic vision, auto-deleted after 7 days). RECOMMEND: say "certificate or card — not ID documents" next to the qualification upload |
| **Selfies / face images** | `users.avatar_url` | OAuth callback | nothing | 2 | **REMOVED** (M-2), drop STAGED. Residual: Supabase Auth itself keeps the picture URL inside `auth.users.raw_user_meta_data` — that is the identity provider's payload and cannot be trimmed from application code |
| **Biometrics** | — | — | — | — | **None.** No template, liveness, face or voice matching; no such dependency. Drawn signatures are images used as signatures, not biometric identification |
| **Precise GPS at clock-in** | `time_entries.gps_lat/lng` | `clockIn` (form field no UI sent) | selected, never shown | 0 | **REMOVED** (M-1), drop STAGED |
| **Location history — vehicle telematics** | `telematics_readings.latitude/longitude/recorded_at` | `/api/cron/telematics-sync` from Samsara / Verizon Connect | fleet vehicle page | 0 (dormant) | KEEP as built-dark, with conditions: it is in effect driver tracking → **DPIA and worker notice before activation** (G-21). It is on the retention allow-list — RECOMMEND a default window when the feature is switched on rather than leaving it to each tenant |
| **Prospect coordinates** | `hq_sales_locations.latitude/longitude` | HQ sales console | HQ company page | 0 | KEEP — business premises of a prospect company, not a person's location. Low value; RECOMMEND dropping if the map view is never built |
| **Date of birth** | `payroll_tax_profiles.date_of_birth` | staff payroll-tax form (optional) | `lib/payroll/compute.ts` — "feeds the category consistency warning only" (does the NI category letter match the person's age band?) | 0 | RECOMMEND (legal/product): a full date of birth is more than that one warning needs. Options: (a) keep optional and say why on the form; (b) replace with an age-band choice (under 21 / apprentice under 25 / over state-pension age); (c) drop. A real payroll run would need DOB for RTI, but CrewFlow produces estimates and files nothing |
| **National Insurance number** | `staff_secrets.ni_number` | staff profile (admin) via `lib/staff/secrets.ts`, format-validated | payslip PDF, payroll CSV | 0 | KEEP — it is what a payslip and a payroll-bureau file need. Already well isolated: own table, admin-only RLS, masked in lists, excluded from the export ZIP and from search/embeddings. Stored in plaintext — RECOMMEND column encryption before real payroll data arrives; and clear on staff removal + retention window (G-7) |
| **UTR (subcontractor tax reference)** | `cis_subcontractors.utr`, `cis_contractor_profiles.contractor_utr` | CIS screens | CIS statements/returns (masked form) | 0 | KEEP — required to operate the Construction Industry Scheme. Masked on output. Same encryption recommendation |
| **Bank details** | `organizations.bank_details` | company settings | printed on the tenant's quotes/invoices/PDFs | 0 | KEEP — the tenant's own payment details, shown so its customers can pay. No staff or customer bank details are collected anywhere; card numbers never reach CrewFlow |
| **Emergency contact** | `staff_compensation.emergency_contact` | invite modal, staff profile, join flow (all optional) | staff profile, behind the compensation permission | 0 | KEEP as optional — a reasonable thing for a construction employer to hold. It is a **third party's** data: RECOMMEND deleting it the moment the staff member is removed (G-7) and a one-line prompt to tell the contact |
| **Device identifiers / fingerprints** | `push_subscriptions.endpoint/p256dh/auth/user_agent` | push opt-in | push sender; the user agent labels the device | 0 (dormant) | KEEP — inherent to Web Push; removed on unsubscribe. No fingerprinting library anywhere |
| | HMRC fraud-prevention headers (`hmrc_connections.gov_client_ids`; request IP + user agent) | HMRC connect flow | HMRC submission | 0 (dormant) | KEEP — mandated by HMRC for MTD software; must be disclosed in the policy when activated |
| **IP addresses** | `rate_limit_counters.key` | every rate-limited public action | limiter | 11 | **REMOVED as raw values** (M-3) |
| | `signatures.ip_address` (holds a keyed **hash**), `safety_acknowledgements.ip_hash`, `site_inductions.ip_hash`, `worker_acknowledgements.ip_hash` | sign-off actions via `lib/security/ip-hash.ts` | quote page ("IP hash"); audit | 1 / 0 / 0 / 0 | KEEP — evidence that a signature was made, already pseudonymised with a server-secret salt. RECOMMEND renaming `signatures.ip_address` → `ip_hash` (misleading name) in a future migration |
| | `impersonation_sessions.ip_address` (raw) | `server/services/impersonation.ts` | not displayed anywhere I found | 25 | KEEP — it is the audit trail of CrewFlow staff opening a tenant workspace; the data subject is the CrewFlow operator and accountability outweighs. RECOMMEND a retention period |
| | `auth.sessions.ip`, `auth.mfa_challenges.ip_address` (raw) | Supabase Auth | Supabase | 9 | Supabase-managed; cannot be minimised in code. Set a session lifetime (F-17) |
| | hosting / monitoring logs | Vercel, Sentry, PostHog | — | — | inherent; disclose |
| **User agents** | `signatures.user_agent`, `safety_acknowledgements.user_agent`, `site_inductions.user_agent`, `worker_acknowledgements.user_agent` | sign-off actions | quote page shows the first 100 characters; the H&S ones are **not displayed** | 1 / 0 / 0 / 0 | RECOMMEND: keep on quote acceptance (contract evidence, shown to the tenant); for the three H&S tables the value is written and never read — a candidate to stop collecting. Not changed: these are evidential records and whether a browser string adds evidential weight is a legal call |
| | `demo_requests.user_agent`, `waitlist.user_agent` | **nobody** | nobody | 0 | **STAGED** drop |
| | `impersonation_sessions.user_agent` | impersonation start | — | 25 | KEEP with the raw IP, same reasoning |
| **Old tracking metadata** | `waitlist` (`source`, `ip_hash`, `user_agent`) | nobody since 2026-10-19 | nobody | 0 | **STAGED** drop |
| | `leads.source`, `demo_requests.source` | intake | pipeline reports | — | KEEP — a channel label, not tracking |
| **Unused customer fields** | all `customers` columns | customer form, import, lead conversion | customer pages, documents, search | 602 rows | No unused personal field found. `phone_sig` / `phone_normalized` / `postcode_normalized` are database-generated lookup keys for search and (dormant) caller recognition — derived, never shown |

### 3.2 Other candidates found while tracing

| Candidate | Finding | Decision |
|---|---|---|
| **Email address in a redirect URL** | `bounceToLogin()` puts `?email=<address>` on `/login` after a failed bootstrap → hosting logs, history | RECOMMEND (G-10): carry the hint another way. Not changed — touches the sign-in flow |
| **Customer contact details copied into the audit feed** | `_tg_customers_activity` writes name, email and phone into `activity_log.metadata`; the feed is append-only and never purged | RECOMMEND (G-14): name + id are enough for a feed line; needs a new migration replacing a trigger function, so not done here |
| **Raw imported rows kept after import** | `import_rows.raw` holds each source row verbatim; 1,803 rows + 7 files in prod, no purge | RECOMMEND (G-15) |
| **Raw provider payloads** | `billing_events`, `whatsapp_webhook_events`, `email_webhook_events`, `call_events`, `comm_events` keep the full payload indefinitely | RECOMMEND (G-16): null after processing + N days |
| **Full email bodies in the queue** | `notification_email_queue.body_text/body_html` | KEEP — needed for retry; sent rows are deleted at 90 days (enforced) |
| **Leave type and reason** | `leave_requests.type`, `reason` | KEEP — but `type` can reveal sickness (health data). RECOMMEND the UI discourages medical detail in the free-text reason |
| **Site-visitor vehicle registration** | `site_visitors.vehicle_registration` (optional) | KEEP — ordinary site-security practice; optional in the schema |
| **Lead score** | `leads.lead_score*` — rule-based, explained by `lead_score_factors` | KEEP — prioritisation only; no decision is automated. Disclose as profiling-lite if the adviser thinks it necessary |
| **Staff mobile numbers in receptionist settings** | `ai_receptionist_setups.staff_numbers`, `fallback_number`, `urgent_escalation_number` (2 rows) | KEEP for the dormant feature; they are personal mobiles — RECOMMEND the settings screen says who will be called |
| **Call recording / transcripts / voice notes** | `calls.recording_url`, `transcript`; `voice_notes.audio_url` | Dormant, 0 rows. The receptionist settings already carry `recording_enabled` and a consent message. DPIA before activation (G-21) |
| **Prompt content to AI providers** | no redaction layer except the quote-writer contract | RECOMMEND extending the closed "disclosure contract" idiom (`lib/ai/quote-context.ts`) to `lead.summary`; uploaded documents cannot be minimised — the file is the task |
| **Plaintext backup copies** | 8 local plaintext dump directories | RECOMMEND (G-6) — the largest unnecessary copy of personal data in the whole system |
| **`organizations.last_login_at`, health scores, MRR** | CrewFlow's customer-success view of each tenant | KEEP — organisation-level; disclose (policy audit A21) |
| **Password sign-in nulls name/phone** | the opposite of over-collection — an accuracy defect | **FIXED 2026-11-16** (M-5, §0) |

### 3.3 Minimisation that is already done well (verified, no action)

- **Browser capabilities denied outright:** `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()` on production responses (VERIFIED from live headers). Photos come from the file picker, which needs no camera permission.
- **AI quote writer:** a closed list of fields may leave; the customer's name, email, phone and full address are excluded and the builder throws on any unlisted key (`lib/ai/quote-context.ts`).
- **AI ledger:** stores a hash of the prompt, never the prompt (`ai_invocations`).
- **Search index:** a column deny-list keeps money, secrets, NI numbers out of embeddable text (`lib/search/semantic/mappers.ts`).
- **Public API:** explicit field-by-field DTOs; the time-entry DTO excludes user id, note, breaks and location (`lib/public-api/time.ts`).
- **Analytics:** no autocapture, no session recording, anonymous, UUID-masked URLs, and nothing at all without Accept.
- **Sentry:** no Session Replay, `sendDefaultPii: false`, user reduced to an id (and none is set).
- **Export:** credentials, tokens and NI numbers are excluded from the organisation export ZIP by table and by column.
- **Offline data on the device:** the write queue, photo queue, read cache and blueprint store each expose a clear-all that the sign-out path calls (static check of `lib/offline/*`, `lib/blueprints/offline-store.ts`) — IMPLEMENTED-UNTESTED from my side.
- **Document imports:** uploaded source documents are deleted after 7 days regardless of any flag.
- **Fonts:** all three typefaces are self-hosted; the browser contacts no font host.
- **Demo form:** collects only what the form shows; no IP, user agent or hidden tracking fields are stored.

---

## 4. Legal retention duties noted while deciding (for the adviser — not advice)

| Data | Why it cannot simply be deleted on request |
|---|---|
| Invoices, payments, VAT, purchase records | tenant's 6-year records duty (HMRC / Companies Act) |
| CIS statements, UTR, verification | CIS records, commonly 3 years after the tax year |
| Payroll figures, NI number | PAYE records, commonly 3 years after the tax year |
| Working-time records | commonly 2 years |
| H&S sign-offs, inductions, RAMS | no single rule; often kept for the limitation period or longer |
| Signed quotes | contract evidence — limitation period |
| Emergency contact, DOB (if unused), stale leads, import staging, profile pictures, device strings | **no** retention duty — the first candidates for deletion |

## 5. What remains, and why it was not done here

| Item | Why not |
|---|---|
| Dropping the staged columns/table | Irreversible on the single production database — needs founder approval (F-24) |
| H&S user-agent collection | Evidential value is a legal judgement |
| DOB → age band | Product + legal judgement; changes a form and the payroll model |
| Activity-log trigger metadata | Needs a new migration (trigger replacement) and a view on what the feed should show |
| Import-staging purge; webhook-payload ageing; ex-staff clean-up | Need retention periods the founder has not set (F-11) |
| Plaintext backup directories | Production DR tooling, owned by ops; needs F-18 |
| NI/UTR column encryption | Key-management design; worth doing before real payroll data, not a low-risk drive-by |
| `/login?email=` | Auth-flow change; small, but outside "clearly unnecessary collection" |

## 6. Tests run (real output, 2026-11-13/14)

| Command | Result |
|---|---|
| `npx vitest run --config vitest.security.config.ts __tests__/security/clock-in-no-location.test.ts __tests__/security/no-avatar-collection.test.ts __tests__/security/rate-limit.test.ts` | 3 files, 21 tests passed (before the sweep tests were added); `rate-limit.test.ts` alone later: 18 passed |
| `npx vitest run --config vitest.security.config.ts` on 12 guard/affected files (`rate-limit`, `cron-fairness-guard`, `public-api-rate-limit-failclosed`, `api-keys`, `phase7`, `auth-completion`, `active-org-write-pin-guard`, `active-org-write-slice`, `active-org-list-scoping`, `f1-bare-select-guard`, `f1-limit-clamp-guard`, `loud-read-failures`) | 12 files, 522 tests passed |
| `npx vitest run` (unit) on `__tests__/me`, payroll output/employer-cost tests, `access-gate`, `auth-flow`, `ops/cron-runs-retention`, `ops/cron-telemetry-error-capture`, `demo/route`, `launch/phase8` (the filter also matched the `memory` suites) | 26 files, 443 tests passed |
| `npx vitest run __tests__/monitoring` | 4 files, 28 tests passed |
| `npx vitest run --config vitest.security.config.ts __tests__/security/monitoring-selftest.test.ts` | 1 file, 6 tests passed |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/rls/timesheet-clock-lifecycle.test.ts` (real Postgres) | 1 file, 4 tests passed |
| `heavy.sh npm run typecheck` | exit 0 — run twice: after M-1…M-3, and again after M-4 |

Not run: the full unit, security and integration suites, the production build, and Playwright. Only the targeted files above were run.
