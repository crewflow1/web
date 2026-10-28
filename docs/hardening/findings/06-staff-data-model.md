# 06 — Staff Data Model: restricting STAFF to ASSIGNED jobs

**Scope:** data-layer inventory for a change that restricts `staff`-role members to
only their assigned jobs + their own self-scoped data, hiding all other org jobs
and all confidential pricing/commercial data.
**Repo state:** `/Users/moetalibi/Code/web-main`, `origin/main` tip `aedb9279`
(working copy `0830a7b9`). READ-ONLY inventory — no code or migration changes.

---

## TL;DR

- **There is NO real "staff ↔ job" assignment relation designed for many-staff-per-job.**
  `jobs.assigned_to` is a **single, nullable** FK to `users(id)` — one "primary
  assignee" per job, not a crew. The only table that can express *many staff on
  one job* today is `rota_entries` (`user_id` + `job_id`, many rows per job), which
  was built as a **scheduling** table ("who is working when"), not an access-control
  assignment list. **Building a proper assignment relation is a prerequisite.**
- **Every job and job-child table is org-wide for staff.** Current RLS is uniformly
  `org_id in (select current_org_ids())` for SELECT (members), `is_org_admin()` for
  DELETE. **No table carries an assignee predicate.** At least **11 tables** need a
  staff-assigned predicate added.
- **Commercial/pricing hiding is UI/route-only, NOT data-layer.** The `/jobs/[id]/commercial`
  page redirects non-admins, but the underlying `finances`, `quotes`, `invoices`,
  `job_budgets` tables all have **org-wide member SELECT**. A staff JWT calling
  `/rest/v1/finances` directly still sees every pound. This is the single biggest gap.
- **Storage** (`job-photos`, `job-docs`) is org-wide for members; `job-docs-private`
  is already admin-read-only. Signed URLs are minted with the **tenant client**
  (RLS-scoped) + a path-prefix guard, so an assigned-jobs restriction *is*
  enforceable there — but only once the underlying table/bucket RLS carries the
  assignee predicate.
- **Self-scoped data is partly ready:** `leave_requests` and `time_entries` are
  already own-or-admin for writes but **org-wide for SELECT**; `rota_entries` is
  org-wide SELECT. `staff_compensation` is already self-or-admin (good model to copy).

---

## 1. Job assignment model (TODAY)

### `jobs.assigned_to` — single primary assignee, NOT a crew
`supabase/migrations/20260515150000_jobs_table_and_rls_policies.sql:72`

```sql
-- nullable + SET NULL on user delete
assigned_to     uuid references public.users(id) on delete set null,
```

- **One staff member per job.** This is a scalar column — it **cannot** represent
  many staff on one job. Comment (`20260523000000_job_rota_unification.sql:102`)
  explicitly calls it a *"Primary assignee. Convenience pointer"*.
- Guarded by `tg_assignee_is_org_member()` (`20261112000000`, reused by leads &
  checklists) so the assignee must be a member of the job's org — but **nothing**
  restricts *reads* by it.

### `rota_entries` — the de-facto many-staff linkage (but it's a shift table)
`supabase/migrations/20260521000000_staff_rota_leave.sql:50`

```sql
create table if not exists public.rota_entries (
  id uuid primary key default gen_random_uuid(),
  org_id  uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  job_id  uuid references public.jobs(id) on delete set null,   -- nullable!
  starts_at timestamptz not null, ends_at timestamptz not null, ...
);
```

- `(user_id, job_id)` with many rows → **this is the only place "staff X is on job Y"
  can be expressed for multiple staff.** `20260523000000` wires `jobs.assigned_to +
  scheduled_date` to auto-create a default `rota_entry`, and backfills existing jobs.
- But: `job_id` is **nullable** (a shift need not be tied to a job), the table is
  **admin-write-only** (`rota: admins insert/update/delete`), and its whole purpose
  is *scheduling*, not authorization. Using it as the assignment source means
  "assigned" == "has a rota shift on this job", which is a **product decision** and
  would make unscheduled-but-assigned work invisible.

### `job_documents.assigned_to`, `job_checklists.assigned_to`
Per-document / per-checklist-item single-owner pointers (`20260704010000:33`,
`20261182000000`). Same single-user shape; not a job-level crew list.

### Verdict
**No `job_assignments` / `job_assignees` / `job_staff` join table exists** (confirmed
by grep across all 399 migrations). To deliver "jobs EXPLICITLY ASSIGNED to a staff
member" with many-staff-per-job and read-scoping semantics, a **new assignment
relation must be built** (e.g. `job_assignees(org_id, job_id, user_id)` with a
composite FK to `jobs(id, org_id)` and `tg_assignee_is_org_member`-style guard),
then referenced by a SECURITY DEFINER helper (e.g. `current_assigned_job_ids()`)
that RLS predicates can call. Reusing `rota_entries` is possible but conflates
scheduling with authorization.

---

## 2. `jobs` RLS + per-table change inventory

### Current `jobs` SELECT policy (quote)
`supabase/migrations/20260515150000_jobs_table_and_rls_policies.sql:97`

```sql
create policy "jobs: members can select" on public.jobs for select to authenticated
using (org_id in (select public.current_org_ids()));
```

Full `jobs` policy set:
- SELECT — any member (`current_org_ids()`), **no assignee restriction** ✅ org-wide.
- INSERT — any member (`:101`).
- UPDATE — `is_org_admin(org_id)` only (`:105`).
- DELETE — `is_org_admin(org_id)` only (`:110`).

`current_org_ids()` returns **every org the user belongs to** (not active-org) and is
the outer tenant boundary only; app code adds the active-org pin via `loadJobForOrg`
(`lib/jobs/load.ts`) / `.eq("org_id", ctx.org.id)`. **Neither RLS nor the app-layer
pin restricts staff to assigned jobs today.**

### Tables needing a staff-assigned predicate

All currently use the same `org_id in (select current_org_ids())` SELECT for members.
A "staff-assigned" predicate would (conceptually) become, for the `staff` role only:

> `org_id in (select current_org_ids()) AND (is_org_admin(org_id) OR job_id in (select current_assigned_job_ids()))`

while owner/admin keep org-wide visibility. (Predicate sketch only — not writing it.)

| # | Table | Defining migration:line | Current SELECT policy | Job link | Needs assignee predicate |
|---|-------|------------------------|-----------------------|----------|---------------------------|
| 1 | `jobs` | `20260515150000:97` | `org_id in (current_org_ids())` | self (`id`) | **Yes** — root; predicate on `id in current_assigned_job_ids()` |
| 2 | `job_documents` | `20260704010000:114` | org + `(visibility='staff' or is_org_admin)` | `job_id` NOT NULL | **Yes** — add assigned-job gate on top of existing staff/private split |
| 3 | `job_document_versions` | `20260704010000:152` | org + visibility (denormalized) | via `document_id` | **Yes** — mirror parent |
| 4 | `job_photos` (bucket `jobs.photos[]` + storage) | `20260515160000` | org-wide member read | `jobs.photos` array + `<org>/<job>/` path | **Yes** — see §3 |
| 5 | `job_progress_observations` | `20261078000000:237` | `org_id in (current_org_ids())` | `job_id` NOT NULL (composite FK) | **Yes** — "progress/notes on assigned jobs" |
| 6 | `snags` | `20260919000000:64` | `org_id in (current_org_ids())` | `job_id` nullable | **Yes** (where job-linked) |
| 7 | `site_diary_entries` | `20260920000000:46` | `org_id in (current_org_ids())` | `job_id` nullable | **Yes** (where job-linked) |
| 8 | `site_reports` | `20260922000000:71` | `org_id in (current_org_ids())` | `job_id` nullable | **Yes** — carries `progress_percent`, customer-facing |
| 9 | `job_checklists` | `20261132000000` (+`20261182000000`) | org-scoped | `job_id` | **Yes** |
| 10 | `material_requests` / `material_request_lines` | `20261066000000:347` | `org_id in (current_org_ids())` | `job_id` nullable | **Decision** — may be commercial; restrict or hide |
| 11 | `time_entries` | `20260525000000:60` | `is_org_member(org_id)` (**org-wide**) | `job_id` nullable | **Yes for SELECT** — staff currently see ALL colleagues' clock entries (see §4) |
| 12 | `rota_entries` | `20260521000000:77` | `is_org_member(org_id)` (**org-wide**) | `job_id` nullable | **Decision** — staff see whole team rota today |

**Commercial job-child tables (should be DENIED to staff entirely, see §5):**

| Table | Migration:line | Current SELECT | Note |
|-------|---------------|----------------|------|
| `finances` | `20260515180000:56` | org-wide member | actual-cost ledger — **leaks cost/margin** |
| `quotes` / `quote_line_items` | `20260515150000:256/272` | org-wide member | pricing + variation `cost_*` |
| `invoices` | `20260515190000` | org-wide member | billing amounts |
| `job_budgets` | `20261072000000:284` | org-wide member SELECT (admin write) | budget/target margin — **member SELECT leaks the baseline** |
| `job_billing_plans` / `job_billing_stages` | `20261039000000:201/210` | org-wide member SELECT (admin write) | staged billing amounts |

---

## 3. Storage (job documents + photos)

### Buckets
- `job-photos` — private, 10 MB, image MIME allowlist (`20260515160000:21`). Path
  convention `<org_id>/<job_id>/<filename>`.
- `job-docs` — private, 25 MB (`20260704010100:12`). Path `<org>/<job>/<doc>/v<n>.<ext>`.
- `job-docs-private` — private; **admin-read-only**, member-insert drop-box
  (`20260704010100:65`). Already enforces the staff/confidential boundary on bytes.

### storage.objects RLS (quote — `job-photos` read)
`supabase/migrations/20260515160000_storage_job_photos_bucket.sql:37`
```sql
create policy "job-photos: members can read" on storage.objects for select to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);
```
Tenancy is derived from the **first path segment = org_id** only. There is **no job
dimension** in the storage predicate, so storage RLS alone cannot restrict to
assigned jobs. `job-docs` read is identical (`20260704010100:38`).

### How signed URLs are minted (and whether assigned-jobs is enforceable)
- **Job photos** (`app/api/jobs/[id]/photos/route.ts:83`): uses the **tenant client**
  `createClient()` (RLS-scoped), first loads the job pinned to `ctx.org.id`, filters
  paths via `storagePathBelongsToOrg(p, ctx.org.id)`, then `createSignedUrls(paths, 60)`.
- **Job documents** (`server/services/job-documents.ts`) and **blueprints** mint via
  tenant client with a path-prefix guard; private docs go via **service-role** only
  after a server-side admin check (the hard boundary).

**Enforceable?** Yes — because signing goes through the RLS-scoped tenant client plus
a per-request job load. Two levers:
1. The `.eq("org_id", ...)` / `loadJobForOrg` job load before signing becomes the
   natural choke point to also require the job be in `current_assigned_job_ids()` for
   staff (app-layer).
2. For defence-in-depth on the bytes, the `job_id` would need to appear in the path
   predicate — but `storage.foldername(name)[2]` *is* the job_id by convention, so a
   storage policy *could* in principle join to an assignment table. More robust:
   keep storage org-scoped and rely on the (now assignee-scoped) table RLS + the
   service-signing choke point, matching how `job-docs-private` already works.

---

## 4. Staff self-scoped data

| Data | Table:line | SELECT policy | INSERT/UPDATE | State vs target |
|------|-----------|---------------|---------------|-----------------|
| Rota / shifts | `rota_entries` `20260521000000:77` | `is_org_member` (**org-wide**) | admin-only write | **Needs tightening** if "own rota only" is required — staff currently see the whole team's shifts by design |
| Clock in/out | `time_entries` `20260525000000:60` | `is_org_member` (**org-wide**) | own-or-admin insert/update; update blocked once `payroll_line_id` set (`:72`) | **SELECT needs tightening** — staff see all colleagues' clock sessions today |
| Holiday / leave | `leave_requests` `20260521000000:140` | `is_org_member` (**org-wide**) | insert own (`:145`), update own-pending-or-admin (`:152`) | Writes already own-scoped ✅; **SELECT is org-wide** ("so staff can see who's off") — tighten to own + approved-team if required |
| Pay / comp | `staff_compensation` `20261218000000:87` | `can_read_compensation(user_id)` = **self-or-admin** | admin write | ✅ Already the correct model — copy this pattern |

**Key point:** the rota/clock/leave tables were deliberately built **org-wide-readable**
for team awareness. The founder's target (own rota / own clock / own holiday only)
**requires tightening their SELECT policies** to `user_id = auth.uid() OR is_org_admin(org_id)`.
Writes on `leave_requests`/`time_entries` are already own-scoped. `staff_compensation`
is the reference implementation of the self-or-admin pattern.

---

## 5. Commercial-data hiding (current mechanism)

**Commercial data is hidden from staff only at the UI/server-route layer — NOT at the
data layer.**

- `/jobs/[id]/commercial/page.tsx:62` redirects non-owner/admin to `/jobs/[id]`.
  Billing, valuations, warranties pages compute an `isAdmin` flag and gate server
  actions (`billing/actions.ts:18`, `commercial/actions.ts:95`, etc.).
- **But the underlying tables are org-wide member-readable:** `finances` (`:56`),
  `quotes`/`quote_line_items`, `invoices`, and even `job_budgets` SELECT (`20261072000000:284`)
  and `job_billing_*` SELECT (`20261039000000:201`) all use
  `org_id in (select current_org_ids())` for `authenticated`.
- There is **no column-level ACL** and **no separate "staff-safe" projection** of a
  job. The commercial figures live in normal member-readable tables; only *writes*
  to budgets/billing are `is_org_admin`-gated.

**Consequence:** a staff user with a valid JWT can read all pricing/cost/margin data
directly via PostgREST (`/rest/v1/finances`, `/rest/v1/quotes`, `/rest/v1/job_budgets`…),
bypassing the page redirects. **Meeting "no confidential pricing even on assigned jobs"
requires moving the commercial boundary into RLS** — either deny these tables to the
`staff` role outright, or (for job-linked rows a staff member legitimately needs, e.g.
a material request on their job) split commercial columns into a separate admin-only
table / view. This is the largest and most security-critical part of the change.

---

## 6. Compatibility risks (behaviour changes when staff → assigned-only)

1. **`/jobs` list** (`app/(app)/jobs/page.tsx`): explicitly relies on RLS org-scoping
   with **no assignee filter** ("RLS scopes everything to the caller's org automatically").
   Staff would see an empty/much-shorter list — the list query, pagination
   (`lib/jobs/list.ts`), and the "today" bounded query all need the assignee filter.
2. **Jobs calendar** (`app/(app)/jobs/calendar/page.tsx`) — same org-wide assumption;
   would need to show only assigned jobs for staff.
3. **Search** (`lib/search/filters.ts`, `JOB_SEARCH_COLUMNS`): global job/customer
   search would surface jobs a staff user can no longer open → broken links / leaks
   of job existence + customer names. Must filter to assigned.
4. **Rota/clock/leave team views**: tightening their SELECT (§4) removes the
   "see who's working / who's off" team awareness staff have today — a deliberate
   product behaviour change the founder is asking for, but it will visibly change
   the rota and leave screens.
5. **Dashboard / HQ tiles & counts**: any staff-visible aggregate that counts jobs,
   open snags, site reports, etc. will drop to assigned-only; blended counts need
   per-role scoping or they under/over-report.
6. **Auto-rota sync coupling** (`20260523000000`): if `rota_entries` becomes the
   assignment source, note that clearing `jobs.assigned_to` does **not** remove the
   rota entry, and a rota entry can exist with `job_id = NULL` — "assigned" semantics
   must be defined precisely or staff lose/keep access unexpectedly.
7. **Multi-org members**: `current_org_ids()` spans all orgs; any new
   `current_assigned_job_ids()` helper must likewise be active-org-aware at the app
   layer (the `loadJobForOrg` lesson) or a staff member assigned in org A could be
   scoped oddly in org B.
8. **Customer portal** is a separate token-based surface (`app/customer-portal/*`,
   service-role signing) and is unaffected by the staff-role change.

---

## Answers to the brief

1. **Does a job-assignment relation exist, and many-staff-per-job?**
   No true assignment relation. `jobs.assigned_to` is a **single nullable user FK**
   (one primary assignee, cannot hold a crew). The only many-staff-per-job linkage is
   `rota_entries(user_id, job_id)`, which is a **scheduling** table (admin-write,
   nullable `job_id`), not an access list. **A real assignment relation must be built.**

2. **Exact `jobs` RLS SELECT policy:**
   ```sql
   create policy "jobs: members can select" on public.jobs for select to authenticated
   using (org_id in (select public.current_org_ids()));
   ```
   Org-wide, no assignee restriction. (`20260515150000:97`.)

3. **Tables needing a staff-assigned predicate:** `jobs`, `job_documents`,
   `job_document_versions`, `job-photos` storage, `job_progress_observations`,
   `snags`, `site_diary_entries`, `site_reports`, `job_checklists`, `material_requests`
   (decision), `time_entries` (SELECT), `rota_entries` (decision) — **plus** the
   commercial tables (`finances`, `quotes`/`quote_line_items`, `invoices`,
   `job_budgets`, `job_billing_plans`/`stages`) which must be **denied/column-split**
   for staff, not merely assignee-scoped.

4. **Top compatibility risks:** (a) `/jobs` list, calendar and global search all
   assume org-wide job visibility and will break/leak for staff; (b) commercial data
   is only UI-gated — staff can read pricing straight from PostgREST today, so the
   real work is moving that boundary into RLS; (c) tightening rota/clock/leave SELECT
   removes today's team-awareness behaviour; (d) defining "assigned" precisely when
   the candidate source (`rota_entries`) has nullable `job_id` and decoupled sync.
