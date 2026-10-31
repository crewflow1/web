# R5 — Database Staff-Access Security · Production Approval Pack

> **Status label key:** BUILT = code written + reviewed; ISOLATED-VERIFIED = applied
> to a throwaway Postgres and tested; CI-GREEN = all gates pass on the PR;
> APPLIED = run against production. **Nothing in R5 is APPLIED.**
>
> **These are production ACCESS-POLICY migrations. Per the standing approval
> gate they are built and isolated-tested only. They must NOT be merged or
> applied without explicit founder approval.**

R5 tightens the database so ordinary staff can read only the jobs they are
**explicitly assigned** to, while owners and admins keep full org-wide access —
enforced at Postgres (RLS), not just in the app. It is split into small,
independently reviewable phases so each can be approved, applied, and watched on
its own.

---

## Phase 1 — `job_assignments` model + backfill  ·  PR #975

- **Migration:** `supabase/migrations/20261242000000_job_assignments.sql`
- **What it does:** creates the multi-worker `job_assignments` join table
  (org_id, job_id, user_id, assigned_by, assigned_at; `unique(job_id,user_id)`;
  composite FK `(job_id,org_id)→jobs(id,org_id)` so an assignment can never cross
  tenants), indexes it, enables RLS, **revokes all client grants (service-role
  only / DARK)**, and backfills one row per job from `jobs.assigned_to`.
- **Access change:** NONE. No policy references the table; it is unreadable by
  any client. Applying it is a no-op for every existing user.
- **Lockout risk:** none (nothing enforces on it).
- **Rollback:** `drop table if exists public.job_assignments;` (zero product impact).
- **GDPR (resolved via service-side export, not exclusion):** `job_assignments`
  is classified in `lib/gdpr/org-tables.json` as `service_side_export` and **IS
  included in the DSAR export** via a service-role admin-client lane in
  `server/services/gdpr-export.ts` (the user-JWT loop cannot read a service-role-
  only table). The lane is org-pinned + redacted and gated by a defence-in-depth
  membership probe (the caller's own RLS-subject client must see the
  `organizations` row for `orgId` before the admin lane runs), so a non-member
  can never trigger a service-role read of another org. Erasure already
  hard-deletes `job_assignments` by default and user-erasure cascades it. This
  resolves the "don't permanently exclude a dark table from subject access"
  requirement; it also future-proofs multi-worker assignments (exported with no
  divergence from `jobs.assigned_to`).
- **Status:** BUILT + independently reviewed (APPROVE for the table/backfill;
  the service-side export lane carries its own adversarial review). Re-verify
  CI-GREEN before approving.

---

## Phase 2 — jobs PARENT assignment-aware SELECT  ·  branch `feat/r5-phase2-jobs-rls` (stacked on #975)

- **Migration:** `supabase/migrations/20261243000000_r5_phase2_jobs_assignment_rls.sql`
- **What it does:**
  - adds `my_assigned_job_ids()` — SECURITY DEFINER, **no argument**, self-scoped
    by `auth.uid()` (returns only the **caller's own** assigned job ids; no row
    data, no cross-tenant oracle). Set-returning + STABLE so the policy evaluates
    it once and drives from the Phase-1 `(user_id, org_id)` index — work is
    bounded by the caller's assignment count, not the org's job count;
  - replaces the jobs SELECT policy:
    ```sql
    using (
      org_id in (select public.current_org_ids())
      and ( public.is_org_admin(org_id)
            or assigned_to = auth.uid()
            or public.is_job_assignee(id) )
    )
    ```
- **Access change (intended):** ordinary staff now SELECT only jobs assigned to
  them (via the legacy `assigned_to` column **or** the Phase-1 table); owners and
  admins keep full org access. INSERT/UPDATE/DELETE are **unchanged**.
- **Owner lockout analysis:** NONE. `is_org_admin()` short-circuits the OR for
  role `owner`/`admin`, so an owner is never denied a job in their own org.
- **App-behaviour dependency (deployment ordering):** the app reads jobs through
  the RLS client, so staff-facing job lists narrow to assigned-only. The one
  blocker before APPLY is reconciling the staff-facing job-read surfaces
  (~60+ `createClient().from("jobs")` read sites — empty states, assigned-only
  lists, and by-id deep links returning 404 rather than erroring). **No
  `job_assignments` write-path sync is required for the current single-assignee
  flow** — the policy's `assigned_to = auth.uid()` branch already covers every
  job assigned via the existing UI, so applying Phase 2 does not strand any
  currently-assigned staff member. A write-path that populates `job_assignments`
  is needed only when a **multi-worker assignment UI** is built (assigning
  secondary workers who are not `assigned_to`); that feature, the authenticated
  SELECT policy on `job_assignments`, and the GDPR re-classification land
  together. **Apply order:** reconcile staff job-read surfaces → apply this
  migration. (Also a conscious product call: with only owner/admin/staff roles,
  an office coordinator modelled as `staff` loses org-wide job visibility.)
- **Performance:** OR evaluated per candidate row for non-admins only;
  `assigned_to=auth.uid()` is a free column compare; `is_job_assignee` resolves
  via `job_assignments(unique job_id,user_id)` (live since Phase 1). No new index.
- **Rollback:**
  ```sql
  drop policy if exists "jobs: assignee or admin can select" on public.jobs;
  create policy "jobs: members can select" on public.jobs for select to authenticated
    using (org_id in (select public.current_org_ids()));
  drop function if exists public.is_job_assignee(uuid);
  ```
- **Isolated-Postgres verification (local `supabase db reset`, real JWTs):**
  `__tests__/integration/rls/jobs-assignment-access.test.ts` — 7/7:
  owner sees all 3 org jobs · admin sees all 3 · staff-assigned-via-table sees
  only that job · staff-assigned-via-legacy-column sees only that job ·
  **staff with a seat but no assignment sees nothing** · cross-tenant staff sees
  none of this org's jobs (and still sees their own assigned job) · anon sees
  nothing. secdef-org-rpc guard 15/15; data-api-grant guard 7/7; security tier
  8550/8550; typecheck clean.
- **Status:** BUILT + ISOLATED-VERIFIED. Awaiting independent adversarial review,
  CI-GREEN, and founder approval. **Not merged, not applied.**

---

## Phase 3 — operational child tables (slices 1–5 BUILT + ISOLATED-VERIFIED, apply-held)

- **Slice 1** (`20261244`, PR #981): `snags`, `site_diary_entries`, `site_reports`,
  `job_progress_observations`, `job_checklists`.
- **Slice 2** (`20261245`): `permits_to_work`, `risk_assessments`, `toolbox_talks`,
  `inspection_test_plans`, `completion_certificates`. (`material_requests`
  DEFERRED to its own slice — it has an offline idempotency path needing the
  same narrow self-scoped service-role lookup as `site_diary_entries`.)
- Each SELECT policy → `member AND (is_org_admin OR job_id in my_assigned_job_ids())`.
- **Assignment-source fix (from Phase-3 adversarial review):** `my_assigned_job_ids()`
  now UNIONs **both** sources — `job_assignments` AND the legacy `jobs.assigned_to`
  — because the live app writes `assigned_to`, not `job_assignments`. Gating on the
  join table alone would have stranded assigned staff from their own jobs' records.
  A regression test asserts a `jobs.assigned_to`-assigned staff member sees the
  records. Verified: full `rls/` integration tier green, zero regressions.
- **Caller reconciliation** (no blanket `created_by` exception, per founder): the
  offline-writes idempotency lookup uses a narrow self-scoped service-role path
  `(org_id, client_write_key, created_by)`; the blueprint-pins RPC + job-progress
  tests seed real assignments.
- **Slice 3** (`20261247`): `material_requests` + grandchild `material_request_lines`
  → `member AND (is_org_admin OR job_id in my_assigned_job_ids())`; lines scoped via
  the self-scoped helper `my_assigned_material_request_ids()`. Offline idempotency
  reconciled with a narrow self-scoped service-role lookup
  `(org_id, client_write_key, created_by)` (no `created_by` RLS exception). **BUILT +
  ISOLATED-VERIFIED** (operational-child-access incl. grandchild, material-requests
  lifecycle, offline-write-expansion — all green).
- **Slice 4** (`20261248`): `job_documents` + `job_document_versions` → STAFF area
  narrowed to assigned jobs; **private drop box unchanged (admin-only)**; versions
  scoped via `my_assigned_job_document_ids()`. **This also secures the signed-URL
  download with no app change** — `getJobDocumentDownloadUrl` mints a URL only for a
  version row the tenant client can read, so the narrowed SELECT is the capability
  gate. **BUILT + ISOLATED-VERIFIED** (rls/job-documents-access 4/4).
- **Slice 5** (`20261249`): **job-photos STORAGE** SELECT narrowed from org-wide to
  admin-or-assigned-job (closes a direct-storage uuid-guess IDOR; the GET route was
  already Phase-2-gated). Cast-safe `job_photo_path_assigned(text)` fails closed on
  malformed names. job-docs buckets need no storage change (download gated by the
  slice-4 RLS read before the admin signs). **BUILT + ISOLATED-VERIFIED**
  (rls/job-photos-storage-access 3/3, real storage API).
- **Remaining Phase-3 (not built, not in the directive's named scope):**
  `blueprints` / `blueprint_markup` / `blueprint_pins`, `job_programme_baselines`,
  `job_warranties`, `worker_acknowledgements`, `asset_assignments`, `delay_events`,
  `weather_watches`. Flagged for a later slice.

## ✅ Cross-cutting PRE-APPLY blocker — RESOLVED (reconciliation migration `20261246`)

The earlier blocker ("legacy `updateJob`/reassignment writes `jobs.assigned_to` but
not `job_assignments`, so a reassigned-off worker keeps a stale row") is **resolved**
on branch `feat/jobs-assignment-reconciliation`:

- **Two transactional SECURITY DEFINER RPCs** are now the single write path for
  assignment (admin-only, org-pinned, `current_org_ids()`+`42501` guard):
  - `set_job_primary_assignment(job, org, assignee)` — sets `jobs.assigned_to` AND
    puts the assignee on the crew atomically, and on a CHANGE **preserves the
    outgoing primary on the crew** (only if still a member) so reassigning the lead
    never silently drops their access;
  - `remove_job_worker(job, org, user)` — deletes the crew row AND nulls
    `jobs.assigned_to` if it points at them, **atomically** — no stale path survives.
- `createJob`/`updateJob` route `assigned_to` through the RPC (updateJob after its
  admin gate, so the RPC reads the OUTGOING primary before it changes); the crew
  panel's `removeWorker` uses the RPC.
- **Product decision (answered by founder):** reassigning the primary does NOT remove
  the previous lead from the crew — they stay until explicitly removed. Implemented.
- **Independent adversarial review found + FIXED a HIGH concurrency defect:** a
  set-vs-remove race (reproduced ~75%) could resurrect an explicitly-removed worker.
  Fixed with a **per-job transaction advisory lock** in both RPCs; a 12-iteration
  race regression test now passes. Two low-severity hardenings also applied
  (loud P0002 on wrong-org remove; member-check on the preserve-insert).
- **Verified:** rls/job-assignment-reconciliation 11/11 + secdef-org-rpc-guard 15/15.
- **Apply ordering note:** `20261246` depends on the Phase-3 union helper (`20261244`),
  so it applies AFTER Phase 3 slices 1–2 (prefix order already satisfies this:
  242 → 243 → 244 → 245 → 246 → 247 → 248 → 249).

## Remaining phases (not yet built)

Job-linked child-table inventory (36 tables carrying a `job_id`, enumerated from
the migrations) classified for Phases 3–5:

- **Phase 3 — operational, assignment-visible** (staff see rows only for jobs
  they're assigned to; owner/admin keep org-wide): `job_documents`,
  `job_checklists`, `job_progress_observations`, `job_programme_baselines`,
  `snags`, `site_diary_entries`, `site_reports`, `completion_certificates`,
  `inspection_test_plans`, `permits_to_work`, `risk_assessments`,
  `toolbox_talks`, `worker_acknowledgements`, `worker_signoff_tokens` (H&S
  evidence; token column already export-redacted), `material_requests`
  (goods-received is operational — kept distinct from PO pricing),
  `blueprints`, `blueprint_markup`, `blueprint_pins`, `delay_events`,
  `asset_assignments`, `weather_watches`, `job_warranties`. Attachments/photos
  ride `job_documents` + storage — **storage-object paths need their own
  assignment check** (an assigned-job row does not auto-authorise every byte).
- **Phase 4 — commercial, staff-barred regardless of assignment**: `finances`,
  `job_billing_plans`, `job_billing_stages`, `job_budgets`, `job_valuations`,
  `variation_requests` (valuation variations), `retention_releases`,
  `purchase_orders` (supplier prices), `review_requests`, plus `stock_movements`
  (carries cost/valuation) — confirm each. Indirect-leak sweep across views,
  RPCs, document downloads, signed URLs and AI outputs. Preserve legitimate
  staff **cost entry** and **goods-received confirmation** without exposing the
  ledger.
- **Phase 5 — workforce self-scoping**: `rota_entries`, `time_entries` (own
  clock only) — a staff member cannot read another's rota/timesheets/leave by
  changing an identifier. (`time_entries` is both job-linked and workforce; its
  self-scope is the authoritative rule.)

Each phase ships as its own stacked, apply-held, independently-reviewed migration
with the same evidence shape as Phase 2.

---

## Apply order (all apply-held — explicit founder approval required)

```
242 job_assignments (P1)
 → 243 jobs SELECT (P2)
 → 244 operational children slice 1 + my_assigned_job_ids() union helper (P3)
 → 245 safety/inspection children slice 2 (P3)
 → 246 assignment reconciliation RPCs + concurrency lock   (branch feat/jobs-assignment-reconciliation)
 → 247 material_requests + lines (P3 slice 3)
 → 248 job_documents + versions + download gate (P3 slice 4)
 → 249 job-photos storage read (P3 slice 5)
 → 250 commercial read denial — 8 tables (P4 slice 1)
 → 251 workforce self-scope — rota_entries, time_entries (P5)
 → 252 finances read denial (P4 slice 2)
 → 253 report RPCs owner/admin-only — indirect-leak close (P4 slice 3)
 → 254 purchase_order_line_items read denial (P4 slice 4)
```
**Sprint-3 (full-chain RC validation + adversarial-review fixes):**
- Reset a fresh DB to the COMPLETE 242→254 sequence and ran the entire matrix
  together: **94/94** (81 read/commercial/report + 13 reconciliation incl the F1
  add-vs-remove race) on the final migration order. Chain is contiguous, no
  prefix collision (R5 branches pushed to origin for CI).
- **Review BLOCKER fixed:** 252 broke member-open staff COST ENTRY
  (app/api/finances/route.ts did insert+RETURNING on the tenant client). Fixed —
  the route mints its id and skips RETURNING; INSERT policy unchanged. Regression
  test proves a non-admin can still enter a cost yet cannot read the ledger.
- **Review HIGH fixed (254):** purchase_order_line_items (per-line unit prices /
  totals) were left staff-readable while the PO header was locked — now admin-only.
- **Review MEDIUM (noted, not blocking):** assign authority is granular
  hasCapability on create/crew-add but coarse is_org_admin on update-reassign;
  fails closed, not exploitable (admins are wildcard-granted; prod has 0 admins).
- stock_movements masking: DESIGNED (docs/hardening/STOCK-MOVEMENTS-MASKING-DESIGN.md)
  — a deliberate read-split refactor, NOT shipped (a blanket denial would zero
  staff quantities + stock valuation).
**Sprint-2 additions (all BUILT + ISOLATED-VERIFIED, apply-held):**
- **246 gains `add_job_worker`** (review F1): the crew-add now takes the same
  per-job advisory lock, so add-vs-remove can no longer resurrect a removed
  worker. **F2:** createJob refuses up-front when a non-admin picks an assignee
  (no more silent "created-but-unassigned"). rls/job-assignment-reconciliation
  13/13.
- **252 finances** → is_org_admin SELECT (cost ledger off-limits to staff; cost
  entry preserved; active-org-finance-scoping 64/64). **stock_movements still
  deferred** (commercial+operational — needs column-level masking, not a blanket
  denial).
- **253 report RPCs** → six SECURITY-DEFINER report functions now require
  is_org_admin (they bypassed RLS + the page gate is client-side). Found by the
  indirect-leak sweep (PR #996). rls/report-rpc-admin-guard 6/6, reporting intact.
- **Indirect-leak sweep verdict (PR #996):** NO app-code leak — signed-URL
  issuers, exports, AI context, page tiles all correctly gated; the entire
  exposure was these six RPCs (now fixed).
**Phase 4 (slice 1) + Phase 5 are now BUILT + ISOLATED-VERIFIED** (apply-held):
- **P4/250** narrows SELECT to `is_org_admin` on job_budgets, job_valuations,
  job_billing_plans, job_billing_stages, variation_requests, retention_releases,
  purchase_orders, review_requests (staff barred regardless of assignment).
  `pg_policies` confirms one admin-only SELECT policy per table; rls/commercial-denial
  4/4. **DEFERRED within P4:** `finances` (staff cost entry) + `stock_movements`
  (goods-received) need a write-path audit before SELECT narrowing; indirect-leak
  sweep (views/RPCs/signed-URLs/AI) tracked separately.
- **P5/251** self-scopes rota_entries + time_entries (`is_org_admin OR user_id =
  auth.uid()`); rls/workforce-self-scope 2/2 (a worker never reads another's).
Prefix order already encodes the only hard dependency (246 needs the 244 union
helper). Each is independently reviewable; apply in prefix order after the
Phase-2 staff-facing job-read surfaces are reconciled (that remains the one app
reconciliation gate — see Phase 2).

## Founder decisions required

1. Approve **#975** (Phase 1) to merge + apply — unblocks applying Phase 2+.
2. Approve the **Phase-2 app reconciliation → apply** ordering above.
3. Confirm the Phase 3/4/5 table classification (the staff-access model in the
   master directive §1.2–§1.5 is taken as the confirmed classification).
4. **The cross-cutting reconciliation blocker is RESOLVED** (migration 246 +
   concurrency fix, above) — no decision pending; the "reassign keeps prior lead
   on the crew" product call is answered and implemented.
5. **Phase 4 (financial denial) + Phase 5 (workforce self-scope) — BUILT, VERIFIED,
   CI-GREEN.** See the FINAL STATUS section below.

---

## ✅ FINAL STATUS — 2026-10-31: R5 ENGINEERING COMPLETE, BOTH PRs CI-GREEN

The whole R5 programme is now built, independently reviewed, and green across all
CI tiers. **Nothing engineering-side is outstanding — the only remaining gates are
the protected production actions in this pack (founder merge + apply) and the
external credentials unrelated to R5.**

**The two PRs (apply-held — do NOT merge/apply without explicit founder action):**
- **#997 `r5/consolidated-operational-rls`** (tip `31526073`) — the full read-side
  programme: Phase 2 (jobs), Phase 3 (operational children + material requests +
  job documents + job-photo storage), Phase 4 (commercial/financial denial +
  report-RPC admin guard + PO line-items + **stock_movements masking read-split**),
  Phase 5 (workforce self-scope), and the offline uuid-RPC fix. **ALL 7 CI tiers
  green** (lint, unit, integration, security, typecheck, e2e, gitleaks). Carries
  migrations **242–259 minus 246**.
- **#998 `feat/jobs-assignment-reconciliation`** (tip `77d2fbe1`) — Phase 1
  (job_assignments) + the transactional assignment-reconciliation RPCs with the
  per-job advisory-lock concurrency fix + the multi-worker crew UI. **ALL 7 CI
  tiers green.** Carries migrations **242 + 246**.

**Full combined chain (242 → 259, including 246) — REVIEWED + VERIFIED:**
applied in prefix order on a fresh database with no collision or ordering fault,
then the entire integration tier ran against that unified schema: **278 test files
/ 2771 tests PASS**, including the 13-test assignment-reconciliation + set-vs-remove
race suite. Financial denial, stock masking, workforce self-scope, cross-tenant
isolation, worker revocation and mutation concurrency all hold *together*.

```
242 job_assignments (P1, #998)      250 P4 commercial denial
243 P2 jobs RLS                      251 P5 workforce self-scope
244 P3 operational children (+union) 252 P4 finances denial
245 P3 slice 2                       253 P4 report-RPC admin guard
246 assignment reconciliation (#998) 254 P4 PO line-items denial
247 P3 material_requests             255 offline own-row lookup RPCs
248 P3 job_documents                 256 P4 access regressions (GRN/crew/variation)
249 P3 job-photo storage             257 P4 stock_movements masking (read-split)
                                     258 P4 stock write RPCs → definer
                                     259 fix: own-lookup RPC uuid param
```
Apply in prefix order; `246` slots after `245` (needs the `244` union helper) and
before `247` — verified to interleave cleanly.

**End-to-end proof:** the first-customer simulation (`e2e/first-customer-sim.spec.ts`,
11 scenarios, owner/admin/staff/customer/HQ) passes against the production build with
R5 applied — including the staff-denial scenario (a non-assigned staff member is
refused a progress write), which auto-activates whenever the branch carries the R5
migrations.

**Founder actions to go live (protected — not performed autonomously):**
1. Approve + merge **#998** and **#997** (either order; both share P1/242 and the
   combined chain is verified to interleave).
2. Apply migrations 242 → 259 (incl 246) to production in prefix order (single
   production Supabase; no staging).
3. Post-apply, confirm staff isolation on a real staff login (assigned vs
   non-assigned job).

**Unrelated external gates (not R5, from the integration verification):** Stripe
(`STRIPE_SECRET_KEY`/webhook), Resend (`RESEND_API_KEY` + verified domain), Sentry
DSN, Supabase Auth custom SMTP, and AI provider keys (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CREWFLOW_INTERNAL_ORG_ID`). All corresponding code is
code-complete and wired; each feature is dark purely pending its credential.
