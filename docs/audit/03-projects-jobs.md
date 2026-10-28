# Domain 03 — Projects / Jobs

Auditor: read-only product audit · 2026-10-28 · worktree `/Users/moetalibi/Code/web-main`.
Scope: `/jobs` (list), `/jobs/calendar`, `/jobs/templates` (+ `/new`, `/[id]`), `/jobs/new`, and the full job workspace `/jobs/[id]` with every tab/section — Overview, Commercial, Billing, Valuations, Drawings (blueprints), Timeline, Certificate, Warranties, Variations/new — plus the job APIs (`/api/jobs/[id]/photos`, `…/eot-pack/pdf`, `/api/v1/jobs*`) and the calendar reschedule seam (`/api/schedule/[id]`).
Status legend + role model per `docs/audit/CONVENTIONS.md`. Roles: owner, admin, staff (ADMIN_ROLES = owner+admin). Browser verification NOT performed — classification is from code + known prod state (per CONVENTIONS limitation).

**Cross-cutting role finding (important):** the task brief assumed "staff see assigned jobs only". That is **FALSE at the data layer.** The `jobs` SELECT RLS policy is `org_id in (select current_org_ids())` (`supabase/migrations/20260515150000_jobs_table_and_rls_policies.sql:97-99`) — every org member (incl. staff) can list and open **every** job in the org. `/jobs` and `/jobs/[id]` apply NO `assigned_to` filter. Staff are restricted to assigned jobs only on `/me` ("My day"), not here. Update/Delete on `jobs` are admin-only (RLS `is_org_admin`, lines 105-113). Per-role differences below are therefore mostly about which *tabs/panels* render (money tabs admin-gated), not which jobs are visible.

**Cross-cutting navigation pattern:** all `/jobs/[id]/*` sub-route write actions return `FormState` + `redirectTo` and navigate via `<StateForm>` (full document load / `window.location.assign`), never `redirect()` — the Next 15.5 deep-swap commit race (`reference_nextjs_deep_swap_commit_race`). In-place panels (checklist, photos, documents, blueprint pins) use optimistic state + `router.refresh()`.

---

### Page: Jobs list — route `/jobs` (`app/(app)/jobs/page.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (core prod surface; address-search + exact-count pagination shipped).
**Roles:** owner/admin/staff (nav `projects` = ALL_ROLES). No per-role query difference — all members see all org jobs (see cross-cutting finding). "Templates" link target is admin-only once opened; the link itself shows to all.
**Purpose:** The org's job register — search by site address/postcode/town/customer, paginate, open a job.
**What the user sees:** Header (title, count, Help link, Calendar/Templates/New-job buttons) · GET search form (`q`, optional `customer` filter chip) · desktop canonical `DataTable` (Status, Customer, Address, Assigned, Scheduled, Open→) with client-side sort/filter over the loaded page · mobile: "Today's jobs" section (own bounded query) then "All jobs" cards (customer, assignee, status, address, notes, tap-to-call, map actions) · pagination nav (`page.tsx:423-454`).

**Features:**
1. **Address-first search** — (1) find a job by where/who. (2) type into `q`, submit (GET). (3) read-only: resolves a customer pre-pass (`customers` by name/address, capped 200, org-pinned, loud on error `page.tsx:106-117`) then an OR branch on the jobs query (site address OR matched customer ids) applied BEFORE `.range()` so the whole table is searched then paginated. (4) results + count reflect matches; Clear link. (5) none. (6) feeds both desktop table and mobile sections. (7) built. (8) URL-length-bounded customer match (200 UUIDs).
2. **Customer filter** — arrives via `?customer=<uuid>` (from a customer page); shows a filter chip with "Back to customer" + "Clear customer filter"; carried on pagination links.
3. **Pagination** — exact `count` + `.range()` (`PAGE_SIZE` from `lib/jobs/list`); stable `scheduled_date,id` order; Prev/Next preserve `q`+`customer`.
4. **Today's jobs (mobile)** — own bounded query `scheduled_date = today` (org-pinned), so it never empties once the org passes the page cap (documented former bug, `page.tsx:142-151`).
5. **Row/card open** — Link to `/jobs/[id]`; mobile card adds `tel:` Call (if customer phone) + `MapActions` (directions).

**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Calendar | header | Link → `/jobs/calendar` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Templates | header | Link → `/jobs/templates` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| New job | header | Link → `/jobs/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Help with jobs | header | HelpLink → help article | — | Help drawer/page | IMPLEMENTED, NOT LIVE-VERIFIED |
| Search | search form | GET submit `?q=` | search term | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Clear / Clear customer filter | search / chip | Link resetting params | — | Reset | IMPLEMENTED, NOT LIVE-VERIFIED |
| Column sort/filter | desktop DataTable | client-side over loaded page | — | Re-order rows | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open → / card tap | row / card | Link → `/jobs/[id]` | — | Open job | IMPLEMENTED, NOT LIVE-VERIFIED |
| Call | mobile card | `tel:` link | customer phone | Dial | IMPLEMENTED, NOT LIVE-VERIFIED |
| MapActions | mobile card | directions to address | — | Maps app | IMPLEMENTED, NOT LIVE-VERIFIED |
| ← Prev / Next → | pagination | Link w/ `page` ±1 | — | Page change | IMPLEMENTED, NOT LIVE-VERIFIED |
| Empty-state primary/secondary | empty list | Links → `/jobs/new`, `/customers/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: New job — route `/jobs/new` (`app/(app)/jobs/new/page.tsx`, form `../_form.tsx`, action `../actions.ts:createJob`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** any member can open + create (jobs INSERT RLS = members). Customer/staff dropdowns scoped to ACTIVE org (`_form-helpers.ts`, paged complete per F-1). Template picker shown only if active templates exist; its programme-baseline clone is admin-only inside the RPC.
**Purpose:** Create a job (customer, assignee, status, dates, recurrence, site address override, notes, optional template).
**What the user sees:** Breadcrumb · single `JobForm`: Customer `<select>`, Assigned-to `<select>`, Status `<select>` (new/in-progress/completed/blocked — **cancelled is edit-only**, hidden on create `_form.tsx:147-154`), optional "Start from a template" `<select>`, Scheduled date + End date, Recurring pattern + Repeat-until, Site-address fieldset (optional, inherits customer address if blank), Notes, Create/Cancel.

**Features:**
1. **Create job** — (1) register a new job. (2) fill form → Create. (3) INSERT into `jobs` (org-pinned); zod `jobFormSchema`; cross-tenant ref integrity re-check (`verifyCrmReferences`) over the composite FK + membership trigger (`actions.ts:75-79`); multi-day span validation (`validateSpan`). (4) success → redirect to `/jobs/[id]`; `revalidatePath('/jobs')`. (5) **side-effects:** if template chosen → `clone_job_template` RPC clones checklist (+ admin programme baseline) best-effort; if `status=completed` on create → `dispatchAutomation('job.completed')` (idempotent, drives "suggest invoice" rule); if scheduled_date set → `bestEffortPushJob` one-way calendar push (**no-op while calendar integration dark**). (6) connects to templates, automation OS, calendar connectors. (7) built. (8) cancelled-on-create refused by DB guard (surfaced verbatim).
2. **Picker silent-null defence** — `withPreservedOption` guarantees a currently-set customer/assignee always has an `<option>` so an untouched save can't NULL a valid ref (F-1 class).

**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Customer / Assigned-to / Status / Template selects | form | set field | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Scheduled/End/Recurring/Repeat-until | form | date/recurrence | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Site-address fields + Notes | form | optional overrides | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create job | form | `createJob` server action | customer optional; status required | Insert + redirect to detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | form | Link → `/jobs` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Job workspace shell (layout) — wraps `/jobs/[id]/*` (`app/(app)/jobs/[id]/layout.tsx`, tabs `_job-tabs.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** all members; org-pinned header read. Tab bar hides admin-only tabs for staff.
**Purpose:** Persistent context header (breadcrumb → job identity → status badge) + tab bar across the whole job.
**Tabs:** Overview · **Commercial** (adminOnly) · **Valuations** (adminOnly) · **Billing** (adminOnly) · Drawings · Timeline · Certificate · Warranties. `isAdmin = role owner|admin`; adminOnly tabs filtered out for staff (`_job-tabs.tsx:19-34,46`). Pages themselves also fail-closed server-side (defence in depth). **Note:** the New-variation page, EOT-pack PDF and the job's Site-hub sub-surfaces have NO tab — reached only via overview buttons/links (hard-to-discover, see summary).

---

### Page: Job detail — Overview — route `/jobs/[id]` (`app/(app)/jobs/[id]/page.tsx`, 1127 lines)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (the product's core; many panels corroborated by prod-shipped migrations in memory).
**Roles:** all members open it (org-pinned `loadJobForOrg`; non-active-org job → 404). **Per-role render diffs:** owner/admin see Profit/Margin/Costs-by-category + the "Profitability" heading; staff see a "Costs" heading with "+ Add cost" only and the message "Profit and margin are visible to owners and admins" (`page.tsx:869-905`). Private documents area: owner/admin get full read; staff get a write-only drop-box (fetch gated, not just render `_job-documents.tsx:72-76`). Retention admin forms, programme re-baseline, variation-request review, budget: admin-only. Delete job: admin-only (RLS).
**Purpose:** Operate one job end-to-end — edit, commercial strip, money/value tiles, and the whole "Job Site Hub" (progress, programme, checklist, diary, snags, variation requests, materials, assets, drawings, safety, quality, delays, documents, attachments, site timeline), plus completion follow-ups and delete.
**What the user sees:** Breadcrumb · "Overview" h1 · quick links (Get paid — billing plan, Site timeline) · cash strip (Outstanding/Overdue/received/billed/contract → Commercial, shown when billed/revised > 0) · error/saved banners · Site-address card + MapActions · the full `JobForm` (edit) · Photos gallery · Retention panel (if active/admin) · Job-value tile (Original/Variations/Total [+ Profit/Margin for admin] + Committed POs + Billed-actual + variations list + "+ Add variation") · Profitability/Costs panel ("+ Add cost") · **Suspense-streamed Job Site Hub** (Progress, Programme, Checklist, Diary, Snags, Variation requests, Materials, Assets, Drawings teaser, Safety, Works quality, Delays & EOT, Staff+Private documents, generic Attachments, Site timeline) · completed-job follow-up strip (Request review / Completion certificate / Warranties) · Delete-job confirm box.

**Features (numbered):**

1. **Edit job (`JobForm` → `updateJob`)** — (1) change any job field. (2) edit inline → Save changes. (3) UPDATE `jobs` with `count:'exact'`, org-pinned + admin-only RLS; ref-integrity + span re-checks; `count===0` → "Only admins/owners can edit jobs". (4) in-place success banner; `revalidatePath('/jobs' + '/jobs/[id]')`. (5) **side-effects:** `status=completed` → `dispatchAutomation('job.completed')`; scheduled_date set → `bestEffortPushJob` else `bestEffortDeleteJobEvent` (calendar connector, dark). (6) automation OS, calendar. (7) built. (8) cancel/reopen transitions enforced by DB trigger (20261220), surfaced verbatim. Uses `useActionState` + `router.push(redirectTo)` (edit path has no redirect → `router.refresh()`).
2. **Delete job (`ConfirmForm` → `deleteJob`)** — admin-only (RLS); removes job + photo refs; best-effort external-event delete first; `?error=delete_denied/_failed` on failure; redirect `/jobs`.
3. **Photos (`_photo-gallery.tsx`)** — (1) before/during/after proof. (2) Upload (multi, ≤10 files, ≤10 MB, image mimes) / Delete per photo (confirm). (3) client fetches `GET /api/jobs/[id]/photos` (signed URLs), POST multipart, DELETE by filename. (4) refresh list. (5) storage writes (service-role upload) + `append_job_photo`/`remove_job_photo` SECURITY DEFINER RPCs (any member). (6) feeds "photos missing" dashboard tile. (7) built & member-writable.
4. **Progress (`_job-progress.tsx` → `recordJobProgress`)** — dated %-complete readings; hand-rolled SVG curve (no chart lib); trend badge; planned dashed line only when a fully-weighted programme exists; UPSERT on `(job_id,observed_on)` (one reading/day, corrections allowed, provenance stamped); future dates refused; loud read. Writes NOTHING to money.
5. **Programme (`_job-programme.tsx` → `setJobProgramme`, `setMilestoneDependencies`)** — admin baseline the planned window + up to 6 weighted milestones via atomic `set_job_programme` RPC (supersede-not-overwrite revisions, note required to re-baseline); EoT re-baseline *suggestion* from accepted variations (never auto-moves); milestone dependency editor + derived critical-path/float (`computeCriticalPath`, cycle refused). Admin gate presentational; RLS/RPC real.
6. **Checklist (`_checklist-client.tsx` → `checklist-actions.ts`)** — member-writable run-list: add/toggle-done/remove, assign to a member + due date. Optimistic + `router.refresh()`. **Side-effect:** new assignment to another person fires a targeted in-app notification (`emitNotifications`, `job_checklist.assigned` → `/jobs/[id]#checklist`). Completion provenance stamped by trigger.
7. **Variation requests (`_variation-request-panel.tsx` → `variation-request-actions.ts`)** — any member logs a change request (title/details/why/urgency); management reviews (Start review / Accept / Reject-with-note, optimistic-concurrency `status` predicate); accepting exposes "Create variation from this request" → `/jobs/[id]/variations/new?fromRequest=`. Also receives customer/worker-portal requests (same table, `requester_type`). Per-request attachments via universal `AttachmentsPanel`. Accepting creates NO money.
8. **Materials / Diary / Snags (read-only job windows)** — composed summaries from the materials/diary/snag verticals (counts, overdue flags), links to `/materials/requests?job=`, `/diary/new?job=`, `/snags/new?job=`. Best-effort (degrade to empty).
9. **Assets** — open custody assignments on the job (bounded, loud error block), links to `/assets/[id]`. Hides when none.
10. **Safety (`_job-safety.tsx`)** — per-job RAMS / permits-to-work / toolbox talks with DERIVED permit status (expired never reads "active"); **loud fail-closed** (any read error → explicit error block, never a false all-clear). "No issued RAMS current" warning. Hides when none.
11. **Works quality (`_job-quality.tsx`)** — per-job ITP inspection plans + hold-point warnings ("Work should not proceed…"); warns, never blocks; loud read. Links `/quality/[id]`.
12. **Delays & EOT (`_job-delays.tsx`)** — delay-event evidence position, ongoing count, evidence gaps, and **Evidence pack (PDF)** link (`/api/jobs/[id]/eot-pack/pdf`) when ≥1 recorded event; loud read; links `/delays/new?jobId=`.
13. **Documents (`_job-documents.tsx` / client / `job-documents-actions.ts`)** — Staff docs (team-wide) + Private docs (owner/admin full, staff write-only drop-box). Per doc: Download (signed URL), New version / Photo (camera), Complete (locks), Delete (admin). Service-role used for staff→private drop. Completion locks versioning. Error-code→friendly map.
14. **Drawings teaser (`_blueprints.tsx`)** — count + "View/Add drawings" → `/jobs/[id]/blueprints`.
15. **Retention (Programme C)** — accrued/released/held tiles; admin forms: set retention rate, record release (capped at `maxReleasable`); release schedule section (JCT moieties, PC date + defects months + first-release %). Writes via `retention-actions.ts`.
16. **Job value / Profitability tiles** — Original vs Variations vs Total revenue, Committed (POs, ex-VAT), Billed-actual; admin-only Profit/Margin + Costs-by-category (labour incl. employer NI/pension + stock COGS). "+ Add variation" → variations/new; "+ Add cost" → `/finances/new?job_id=` (member-open). Cash strip + unified position link to `/commercial`.
17. **Site timeline panel** — latest N composed events (diary/delays/snags/safety/reports/drawings/uploads), "View full timeline →".
18. **Completed-job follow-ups** — when `status=completed` + customer: Request a review (`/reviews/new?...`), Completion certificate, Warranties & servicing.

**Buttons & controls (Overview):**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Get paid — billing plan | quick links | Link → `/jobs/[id]/billing` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Site timeline | quick links | Link → `/jobs/[id]/timeline` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Commercial → (cash strip) | cash strip (billed/revised>0) | Link → `/commercial` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| MapActions | site-address card | directions | — | Maps | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save changes | edit form | `updateJob` | status required; admin for success | Update job | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | edit form | Link → `/jobs` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload / Delete (photo) | Photos | POST/DELETE `/api/jobs/[id]/photos` | files (≤10, ≤10 MB) | Add/remove photo | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record (progress) | Progress | `recordJobProgress` | percent req, date ≤today | Upsert reading | IMPLEMENTED, NOT LIVE-VERIFIED |
| Baseline/Re-baseline programme | Programme (admin) | `setJobProgramme` RPC | start/end; note to re-baseline | New revision | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save dependencies | Programme (admin, ≥2 milestones) | `setMilestoneDependencies` RPC | edges | Critical path | IMPLEMENTED, NOT LIVE-VERIFIED |
| checkbox / Add / Remove / assignee / due (checklist) | Checklist | checklist-actions | label 1–300 | Mutate + notify assignee | IMPLEMENTED, NOT LIVE-VERIFIED |
| Log request / Start review / Accept / Reject / Create variation | Variation requests | variation-request-actions | title; note to reject; mgmt to review | Request lifecycle | IMPLEMENTED, NOT LIVE-VERIFIED |
| Request materials / Log today's entry / Log a snag + "all/history" links | Materials/Diary/Snags | Links to verticals | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Evidence pack (PDF) | Delays & EOT (≥1 recorded) | `GET …/eot-pack/pdf` | — | PDF download | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download / New version / Photo / Complete / Delete | Documents | job-documents-actions | file ≤25 MB; admin to delete | Doc CRUD | IMPLEMENTED, NOT LIVE-VERIFIED |
| View/Add drawings | Drawings teaser | Link → `/blueprints` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save rate / Release / Set completion date (schedule) | Retention (admin) | retention-actions | amount ≤ releasable | Retention writes | IMPLEMENTED, NOT LIVE-VERIFIED |
| + Add variation | Job-value tile | Link → `/variations/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| + Add cost | Profitability/Costs (all roles) | Link → `/finances/new?job_id=` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Request a review / Completion certificate / Warranties | completed strip | Links | job completed + customer | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete job | delete box (admin) | `deleteJob` (ConfirmForm) | admin | Delete + redirect | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generic attachments (add/remove/download) | AttachmentsPanel | universal attachments pipeline | — | File CRUD | IMPLEMENTED, NOT LIVE-VERIFIED |

Mobile: list page swaps DataTable → Today/All cards; overview panels are single-column, 44px touch targets, camera-capture inputs on document/photo uploads.

---

### Page: Commercial position — route `/jobs/[id]/commercial` (`page.tsx` 692 lines, `actions.ts`, `_budget-form.tsx`, `_commercial-timeline.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** **owner/admin only** — staff server-redirected to `/jobs/[id]` (`page.tsx:63-65`); tab hidden for staff. Read-model over tenant (RLS) client; never service-role (pinned by a security source-contract test).
**Purpose:** One authoritative cash-first commercial lifecycle + audit timeline + budget/forecast.
**What the user sees:** Breadcrumb · "Commercial position" h1 · Contract & cash section · Cost & profit section (margin pill, costs-by-bucket) · `CommercialTimeline` (chronological commercial events) · Budget & forecast section with `BudgetForm`.
**Features:**
1. **Unified position** — composes cash (ledger-truthful received/outstanding/overdue from `invoice_payments`), retention, committed POs (ex-VAT, less billed), job profitability (labour incl. on-costs + stock COGS), all from paged + loud reads. Read-only.
2. **Budget baseline (`setJobBudget` via `set_job_budget` RPC)** — admin-only (app check + `is_org_admin` RLS). Writes a PLAN only — never touches `finances` (accounting boundary, pinned by `job-budgets.test.ts`). Total OR four buckets (all-or-none); optional target margin %; revision requires a reason. `window.location.assign` navigation (no revalidatePath on this 4-deep route).

**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Budget detail toggle + figures + target margin + note | BudgetForm (admin) | `setJobBudget` RPC | total or 4 buckets; reason on revision | Budget baseline/revision | IMPLEMENTED, NOT LIVE-VERIFIED |
| Back-to-job breadcrumb | header | Link | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Get paid (Billing) — route `/jobs/[id]/billing` (`page.tsx`, `actions.ts`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (LIVE in prod per H2-CASH history).
**Roles:** **management only** — `requireManagementRole(ctx)` fails closed before any read (`page.tsx:42`); tab hidden for staff. All write actions re-check `isManager`.
**Purpose:** Billing plan (deposit/staged/milestone/progress) + stages + stage invoicing + debtor/cash outlook.
**What the user sees:** "Get paid" h1 + Back · money summary (Contract ex-VAT, Billed, Received, Collectable now) · debtor detail (Outstanding/Overdue/Retention held/Unscheduled) · cash outlook tiles · either Create-plan form (structure + contract value) or the Payment schedule (stages list + per-stage Generate invoice / Remove / linked invoice; Add-stage form; Cancel plan).
**Features:**
1. **Create plan** — insert `job_billing_plans` (one active/job), structure + basis_amount.
2. **Add stage** — resolve net amount (fixed/percent-of-contract/balance-remainder, capped at remainder), VAT 20/5/0, due date; Σ≤basis DB guard.
3. **Generate stage invoice** — atomic idempotent `generate_stage_invoice` RPC (disabled if job has no customer); active-org stage ownership re-checked. **Side-effect:** creates a real invoice.
4. **Delete stage** (not-yet-invoiced only) / **Cancel plan**.

**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Structure + Contract value + Create plan | no-plan form (mgmt) | `createBillingPlan` | structure, basis | Active plan | IMPLEMENTED, NOT LIVE-VERIFIED |
| Name/Kind/Basis/Amount/%/VAT/Due + Add stage | schedule (mgmt) | `addBillingStage` | name | Stage row | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate invoice | stage (mgmt) | `generateStageInvoice` RPC | job has customer | Invoice created | IMPLEMENTED, NOT LIVE-VERIFIED |
| Remove (stage) | stage (mgmt) | `deleteBillingStage` | not invoiced | Stage deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| View invoice | invoiced stage | Link → `/invoices/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel this plan | schedule (mgmt) | `cancelBillingPlan` | — | Plan cancelled | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Valuations — route `/jobs/[id]/valuations` (`page.tsx`, `_valuations.client.tsx`, `../valuation-actions.ts`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** **management only** (`requireManagementRole`, fails closed, tab hidden for staff). Certify is additionally owner/admin (`isAdmin`).
**Purpose:** Interim valuations / applications for payment (gross this period, retention, link variations, certify, generate invoice).
**What the user sees:** List of valuation lines by status; "+ New valuation" → create-draft form; per draft: Edit/Save/Cancel, link/unlink variations, Submit for certification; submitted (admin): Certify (freezes figures); certified: Generate invoice; negative-amount guard note.
**Features:** create/update/submit/cancel valuation (FormState + redirectTo); `linkVariation`/`unlinkVariation`; `certifyValuation` via `certify_valuation` RPC (admin, freezes); `generateValuationInvoice` via `generate_valuation_invoice` RPC → redirects to new invoice. All org-pinned; `_record_activity` audit.

**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New valuation / Create draft | header/create form | `createValuation` | — | Draft line | IMPLEMENTED, NOT LIVE-VERIFIED |
| Edit / Save / Cancel | draft | `updateValuation` / toggle | — | Edit figures | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add (link variation) / unlink | draft | `linkVariation`/`unlinkVariation` | variation | Link | IMPLEMENTED, NOT LIVE-VERIFIED |
| Submit for certification | draft | `submitValuation` | — | Status submitted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Certify | submitted (admin) | `certifyValuation` RPC (confirm) | admin | Frozen figures | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel (valuation) | draft/submitted | `cancelValuation` (confirm) | — | Cancelled | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate invoice | certified | `generateValuationInvoice` RPC | — | Invoice + redirect | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Drawings (Blueprint Centre) — route `/jobs/[id]/blueprints` (`page.tsx` + ~12 client/action files)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (Blueprint programme complete per memory; PWA-offline shell + pins + markup + compare built).
**Roles:** all members list/upload/add revisions/view/compare/offline; **admin-only** status change, delete, and pin deletion (`canDeletePins`). Org-pinned (`loadJobForOrg`). File access via signed-URL redirect (`f/[versionId]/route.ts`, cross-org → 404).
**Purpose:** Controlled drawing register — current issue + full revision history, in-browser PDF/image viewer with pins (note/snag/task) and redline markup, two-revision compare (overlay/swipe), and offline caching.
**What the user sees:** "Drawings" h1 + "Add a drawing" · per drawing: number/title/discipline/status badge, current revision, action row (View, Offline download/remove, Compare revisions, Add revision), revision-history details (Open per version), admin status `<select>`+Set and Delete. Viewer modal: pdf.js render, zoom, pin toolbar (Snag/Task/Note/Link snag), pin details (comments thread, photos, task status/assignee), markup tools (select/text/freehand/line/arrow/rect, Delete). Compare modal: revision A/B, swap, opacity slider, zoom/reset.
**Features:** upload drawing / add revision (`actions.ts`, service layer, FormState+redirect); set status (admin, org-pinned UPDATE + `recordAdminActivity` audit); delete (admin); **pins** (`pin-actions.ts`: note/snag/task create, link existing snag, move, delete, threaded comments create/delete, direct photo upload/delete, assignable-members lookup — each revalidates the register); **markup** (`markup-actions.ts`: create/remove/delete redlines); **compare**; **offline** (download-for-offline / remove, PWA cache); version file open via 60s signed-URL redirect.

**Buttons & controls (condensed — register + viewer + compare):**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add a drawing (number/title/discipline/revision/date/notes/file) + Upload drawing | header form | `uploadBlueprint` | drawing number, title, file | New drawing v1 | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add revision (revision/date/notes/file) + Upload revision | per drawing | `uploadRevision` | file | New version | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | per drawing | opens pdf.js viewer modal (dynamic ssr:false) | — | Viewer | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download for offline / Remove | per drawing | PWA cache store/evict | — | Offline copy | IMPLEMENTED, NOT LIVE-VERIFIED |
| Compare revisions (+ swap/opacity/zoom) | per drawing (≥2 vers) | opens compare modal | — | A/B overlay | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open (version) | revision history | `f/[versionId]` → signed-URL redirect | — | File opens | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status select + Set | per drawing (admin) | `setBlueprintStatus` + audit | admin | Status change | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete (drawing) | per drawing (admin) | `removeBlueprint` (confirm) | admin | Deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Pin toolbar: Snag / Task / Note / Link snag | viewer | pin-actions create/link | title / assignee | Pin placed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Pin: comment / photo / task status+assignee / move / delete | viewer pin details | pin-actions | admin to delete pins | Pin mutate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Markup tools (text/freehand/line/arrow/rect) + Delete | viewer | markup-actions | — | Redline CRUD | IMPLEMENTED, NOT LIVE-VERIFIED |
| Filter pins / Zoom | viewer | client state | — | View change | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Site timeline (full) — route `/jobs/[id]/timeline` (`page.tsx`, `_timeline-feed.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** all members (org-pinned). Read-only read-model; strict loud read (`loadJobSiteTimelineStrict`).
**Purpose:** Complete chronological record of everything on the job (diary, delays, snags, toolbox, RAMS, permits, plant inspections, site reports, drawing revisions, uploads), day-grouped, each linking back to its owning record.
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Event links | feed rows | Link to owning record | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Back to the job | empty state | Link → `/jobs/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Completion certificate — route `/jobs/[id]/certificate` (`page.tsx`, `actions.ts`, `_form.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** all members view; **issue/publish/withdraw owner/admin only** (`isAdmin`, DB-backed). Requires job `status=completed` to create.
**Purpose:** Practical Completion Certificate — draft → issue (freezes content) → publish to customer portal / withdraw; PDF.
**Features:** create draft (`CertificateForm` → `createCertificate`, numbering via `next_certificate_number` RPC); issue (freezes, `issueCertificate`); publish/withdraw to portal (`publishCertificate`/`withdrawCertificate`, stamps `portal_published_at`/`_withdrawn_at`); PDF via `/api/completion-certificates/[id]/pdf`.
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Issue a certificate (form) | no-cert, completed, admin | `createCertificate` | completion date | Draft cert | IMPLEMENTED, NOT LIVE-VERIFIED |
| Preview/Download PDF | cert | `/api/completion-certificates/[id]/pdf` | — | PDF | IMPLEMENTED, NOT LIVE-VERIFIED |
| Issue certificate | draft (admin, confirm) | `issueCertificate` | admin | Frozen cert | IMPLEMENTED, NOT LIVE-VERIFIED |
| Publish to customer portal / Withdraw from portal | issued (admin) | `publishCertificate`/`withdrawCertificate` | admin | Portal visibility | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Warranties & servicing — route `/jobs/[id]/warranties` (`page.tsx`, `actions.ts`, `_form.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** all members view; **create/publish/withdraw/void admin-only**. Clock keys off the ISSUED completion certificate's frozen date (none → "no honest start date", none invented).
**Purpose:** Record post-completion warranties + servicing intervals; derive expiry/service dates; publish to customer portal. **Reminders are shown, never sent** — explicitly no email/SMS/scheduled job (documented product decision, `page.tsx:170-175`).
**Features:** create warranty (`createWarranty`, admin); publish/withdraw portal (`publishWarranty`/`withdrawWarrantyFromPortal`); void with reason (`voidWarranty`, records `job_warranty.voided` audit activity, stays on record, disappears from portal). Derived clock via `computeWarrantyClock`.
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add warranty (`WarrantyForm`) | section (admin) | `createWarranty` | title/kind/period | Warranty row | IMPLEMENTED, NOT LIVE-VERIFIED |
| Publish to customer portal / Withdraw from portal | warranty (admin) | publish/withdraw actions | admin | Portal visibility | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw warranty (void, with reason) | warranty (admin, confirm) | `voidWarranty` + audit | reason | Voided | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: New Variation Order — route `/jobs/[id]/variations/new` (`page.tsx`, `_form.tsx`, action `quotes/actions.ts:createVariation`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **No tab — reached only via overview "+ Add variation" or "Create variation from this request".**
**Roles:** all members open (org-pinned); the underlying `createVariation` applies quotes' own authorization. `?fromRequest=<uuid>` prefills from an ACCEPTED variation request and stamps it `converted` on success.
**Purpose:** Capture out-of-scope work as a variation order (a quote with `variation_number`); customer approves via shareable link; on approval an invoice is generated and revenue rolls into job profitability.
**What the user sees:** Breadcrumb · h1 · intro · optional "pricing the accepted request" banner · `VariationForm` (client, live-preview math: line items, net/VAT/total preview) → `createVariation.bind(null, id)`.
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Variation line items + Live preview | form | client math | — | Preview totals | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create (submit) | form | `createVariation(jobId, fd)` | title/items | Variation quote (+ stamp request converted) | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Jobs calendar — route `/jobs/calendar` (`page.tsx`, `_calendar.tsx`, `_month-view.tsx`, `_gantt-view.tsx`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** all members (nav ALL_ROLES). **Reschedule/reassign admin-only** — enforced by the `PUT /api/schedule/[id]` endpoint's jobs UPDATE RLS (`is_org_admin`); the drag UI is shown to all but a staff drag fails server-side. Window-scoped reads (F-1) + recurring expansion.
**Purpose:** Schedule jobs across Week (drag-drop), Month (read-only grid), Gantt and Resource-lane views, filtered by status/staff.
**What the user sees:** View toggle (Week/Month/Gantt/Resource, preserves filters+anchor) · week grid of draggable job cards + day drop targets, assignee `<select>` per card, status/staff filter form, prev/today/next week nav · month 6-row grid (click day → week) · gantt/resource multi-day spans.
**Features:** **reschedule** (drag card → day → optimistic move → `PUT /api/schedule/[jobId] {scheduled_date}` → `router.refresh()`; rollback on failure); **reassign** (`PUT …{assigned_to}`); **filters** (GET form `status`,`staff`); recurring occurrences rendered (non-draggable). No redirect race (uses fetch + refresh).
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Week/Month/Gantt/Resource toggle | header | Link w/ `?view=` | — | View change | IMPLEMENTED, NOT LIVE-VERIFIED |
| Prev / Today / Next week | week header | Link `?d=` | — | Window shift | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status / Staff filter + Apply + Clear | filter form | GET submit | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Drag job card → day | week grid | `PUT /api/schedule/[id]` reschedule | admin (RLS) | Date change | IMPLEMENTED, NOT LIVE-VERIFIED |
| Assignee select | card | `PUT /api/schedule/[id]` reassign | admin (RLS) | Reassign | IMPLEMENTED, NOT LIVE-VERIFIED |
| Day click (month) | month grid | Link → week at that date | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Card tap | any view | Link → `/jobs/[id]` | — | Open job | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Job templates list — route `/jobs/templates` (`page.tsx`, `actions.ts`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** nav entry ADMIN_ROLES; page loads for any member (sees the list, read-only), but **New template / Edit / Delete are admin-only** (presentational gate + redirect on `/new` & `/[id]`; RPC/RLS the real gate). Org-pinned, paginated (exact count).
**Purpose:** Reusable milestone + checklist blueprints by job type, used by `/jobs/new`'s "Start from a template".
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New template | header (admin) | Link → `/jobs/templates/new` | admin | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Jobs | header | Link → `/jobs` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Edit → | row (admin) | Link → `/jobs/templates/[id]` | admin | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| ← Prev / Next → | pagination | Link | — | Page change | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: New / Edit job template — `/jobs/templates/new`, `/jobs/templates/[id]` (`_template-form.tsx`, `actions.ts`)
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** admin-only (member redirected to list). Save via atomic `save_job_template` SECURITY INVOKER RPC (admin RLS); delete is org-pinned by-id (`deleteJobTemplate`).
**Purpose:** Author a template — name, job type, description, default status, up to N weighted milestones (day offsets, customer-visible), up to N checklist items (requires-photo). Jobs created from a template keep their own copy.
**Buttons & controls:**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Name/Job type/Default status/Description | form | header fields | name required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Milestone rows (title/offsets/weight/customer) | form | milestone payload | ≥1 milestone or checklist item | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Checklist rows (label/requires-photo) | form | checklist payload | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create/Save template | form | `createJobTemplate`/`updateJobTemplate` RPC | admin | Template saved → list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete template | edit page (admin, confirm) | `deleteJobTemplate` | admin | Deleted | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### APIs (job-scoped)
| Endpoint | Methods | Auth/role | Notes | Status |
|---|---|---|---|---|
| `/api/jobs/[id]/photos` | GET, POST | any member; org-pinned | list signed URLs / multipart upload (≤10 files, ≤10 MB, image mimes); service-role upload + `append_job_photo` RPC; path-prefix guard before signing | IMPLEMENTED, NOT LIVE-VERIFIED |
| `/api/jobs/[id]/photos/[path]` | DELETE | any member; org-pinned | `remove_job_photo` RPC + service-role object delete | IMPLEMENTED, NOT LIVE-VERIFIED |
| `/api/jobs/[id]/eot-pack/pdf` | GET | any member; org-pinned | @react-pdf EOT evidence pack; 409 if no recorded events; `private,no-store` | IMPLEMENTED, NOT LIVE-VERIFIED |
| `/jobs/[id]/blueprints/f/[versionId]` | GET | member (service-gated) | 302 → 60s signed URL; cross-org → 404 | IMPLEMENTED, NOT LIVE-VERIFIED |
| `/api/completion-certificates/[id]/pdf` | GET | (outside jobs dir) | certificate PDF, linked from cert tab | IMPLEMENTED, NOT LIVE-VERIFIED (not re-audited here) |
| `/api/schedule/[id]` | PUT | admin (jobs UPDATE RLS) | calendar reschedule/reassign (lives in schedule domain) | IMPLEMENTED, NOT LIVE-VERIFIED (not in jobs dir) |
| `/api/v1/jobs` | GET, POST | API-key `read:jobs`/`write:jobs` | **FLAGGED OFF** `FEATURE_PUBLIC_API_JOBS` → 404 dark; org-pinned, DTO allowlist | FLAGGED OFF (`FEATURE_PUBLIC_API_JOBS`) |
| `/api/v1/jobs/[id]` | GET, PATCH | API-key scopes | **FLAGGED OFF** same flag; no cross-org oracle | FLAGGED OFF (`FEATURE_PUBLIC_API_JOBS`) |

---

## DOMAIN SUMMARY

**Counts**
- **Pages/routes audited:** 15 UI routes — `/jobs`, `/jobs/new`, `/jobs/calendar` (4 views), `/jobs/templates`, `/jobs/templates/new`, `/jobs/templates/[id]`, `/jobs/[id]` (Overview), `/commercial`, `/billing`, `/valuations`, `/blueprints`, `/timeline`, `/certificate`, `/warranties`, `/variations/new` — plus 7 API surfaces.
- **Overview sub-sections/panels:** ~18 (edit, photos, progress, programme, checklist, diary, snags, variation-requests, materials, assets, drawings-teaser, safety, works-quality, delays, documents×2, attachments, site-timeline, retention, job-value, profitability, completed-strip, delete).
- **Distinct interactive features:** ~70+. **Buttons/controls catalogued:** ~120+ across all tables.
- **Server actions:** ~45 (jobs CRUD; progress; programme+dependencies; checklist×4; variation-request×2; retention×3; billing×5; valuation×8; commercial budget; blueprint actions×4 + pin-actions×12 + markup×3; certificate×4; warranty×4; template×3; job-documents×5).

**Status tallies**
- LIVE & WORKING: 0 asserted (no browser verification this pass; several are LIVE per prod-migration history — billing/H2-CASH, blueprint programme, retention, CIS/valuations — but classified conservatively).
- IMPLEMENTED, NOT LIVE-VERIFIED: the overwhelming majority (all UI pages/features above).
- FLAGGED OFF: 2 — `/api/v1/jobs` and `/api/v1/jobs/[id]` behind `FEATURE_PUBLIC_API_JOBS` (404 while dark).
- Calendar connector push (`bestEffortPushJob`/`bestEffortDeleteJobEvent`) is **DARK/no-op** until the calendar integration flag is lit (built, inert) — a gated side-effect, not a dead control.
- PARTIALLY/PLACEHOLDER/BROKEN: none found.

**Notable findings (5–10)**
1. **Role assumption wrong:** staff see **all** org jobs on `/jobs` and can open any `/jobs/[id]` — the SELECT RLS is org-wide, not `assigned_to`-scoped (`20260515150000_jobs...sql:97-99`). Assigned-only scoping exists on `/me`, not here. The job detail is open to staff; only the money tabs (Commercial/Billing/Valuations) and the Profit/Margin tiles + private-doc reads are role-gated.
2. **Money boundary is defence-in-depth and consistent:** Commercial/Billing/Valuations hide their tab for staff AND fail closed server-side (`requireManagementRole` / role-redirect) before any read; Profit/Margin/Costs-by-category render for owner/admin only because `staff_compensation` makes co-worker pay admin-only (understated cost otherwise). Cost ENTRY ("+ Add cost") stays open to all members by design.
3. **Hard-to-discover / not-in-nav surfaces:** `/jobs/[id]/variations/new`, `/timeline`, and the EOT-pack PDF have **no tab** — reachable only via overview buttons/panel links. The whole "Job Site Hub" (progress, programme, checklist, diary, snags, variation requests, materials, assets, safety, quality, delays, documents) lives only as overview panels, not as tabs, so cross-job registers (Site & Safety area) and the per-job panels can feel disconnected.
4. **Accounting boundary is explicit and tested:** job budget (`set_job_budget`) and programme milestone weights write PLANS only and never touch `finances`; progress % writes no money; variation-request accept creates no money — all pinned by security tests. One money engine (variations → quotes/invoices).
5. **Warranties deliberately send nothing:** every warranty/service date is derived at render; there is no reminder table, scheduled job or email — stated on-screen. A genuine product gap (no proactive reminders) presented honestly rather than faked.
6. **Public Jobs API fully built but dark:** `/api/v1/jobs(+/[id])` implement GET/POST/PATCH with scope auth, org pinning, DTO allowlist and no cross-org oracle, but 404 behind `FEATURE_PUBLIC_API_JOBS` (CEO decision to expose).
7. **Blueprint register is the richest sub-surface:** in-browser pdf.js viewer with note/snag/task pins (threaded comments + direct photos + task assignment), redline markup, two-revision overlay/swipe compare, and PWA offline caching — all member-usable, admin-gated status/delete. Large client bundle loaded only on demand (`next/dynamic ssr:false`).
8. **Navigation-race discipline is pervasive and deliberate:** every `/jobs/[id]/*` write action returns `redirectTo` + `<StateForm>` (document load), never `redirect()`, to dodge the Next 15.5 deep-swap commit race; in-place panels use optimistic state + `router.refresh()`. This is the single most-repeated engineering pattern in the domain.
9. **Side-effects to flag:** checklist assignment → targeted in-app notification; `job.completed` status (via create OR edit) → automation dispatch ("suggest invoice", idempotent); billing stage → real invoice generation; valuation certify → frozen figures + invoice; blueprint status/warranty-void → admin audit-log rows; calendar push → external calendar event (dark). No SMS/email is sent from this domain except nothing (warranties) — transactional email is left to invoice/review flows elsewhere.
10. **No orphaned/dead controls found.** Every server action in the jobs tree has a UI caller; the only UI-less-by-design surfaces are the flagged v1 API (external callers) and the EOT-pack PDF/photo APIs (consumed by overview buttons and the gallery client).
