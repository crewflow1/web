# CrewFlow Feature & Button Audit — People & Payroll domain

Audit date: 2026-10-28 · worktree `/Users/moetalibi/Code/web-main` · READ-ONLY (code-derived; no browser verification — multi-role prod access out of scope, per CONVENTIONS.md).

Scope: the "People" nav area — `/staff`, `/staff/[id]`, `/staff/[id]/timesheet`, `/staff/rota` (+ `/generate`, `/conflicts`), `/staff/leave`, `/payroll` (+ `/[id]`), payroll CSV + payslip-PDF API routes, the public `/api/v1/staff` read, and the staff self-view `/me`.

Nav model (`app/(app)/_nav/nav-model.ts:170-178`): area `people`, roles `ALL_ROLES`; children — Staff (`/staff`, ADMIN_ROLES), Rota (`/staff/rota`, ADMIN_ROLES), Leave (`/staff/leave`, all roles), Payroll (`/payroll`, ADMIN_ROLES), "My day" (`/me`, staff). `/staff/[id]`, `/staff/[id]/timesheet`, `/staff/rota/generate`, `/staff/rota/conflicts`, `/payroll/[id]` are reachable routes NOT listed as nav children (reached via in-page links).

Pay-data access control (DB-enforced, the sensitive core of this domain):
- `hourly_pay` + `emergency_contact` live in `staff_compensation` (migration `20261218000000_protect_staff_compensation.sql`), RLS `can_read_compensation` = self OR owner/admin of an org the target belongs to; `can_write_compensation` = owner/admin only (a member can NEVER set their own pay). Columns were DROPPED from `public.users` (previously any co-worker could read them).
- `ni_number` lives in `staff_secrets` (migration `20260529000000_security_hardening.sql`), RLS `is_org_admin` — admin-only, NOT even self-readable; masked for non-admins on payslips.
- Payroll lists/detail/CSV/PDF are admin-gated AND additionally `.eq("org_id", ctx.org.id)` pinned in-statement (RLS admits every org a dual-org owner belongs to, so the app pin is the real cross-tenant boundary).

---

### Page: Staff list — route `/staff` → app/(app)/staff/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** nav-gated ADMIN_ROLES; page itself runs for any member via `requireOrgContext`. Owner/admin: full roster incl. an **Hourly** column + "+ Add staff" + edit links + pending-invites. Staff: directory (name/email/role/type/since) with the **Hourly column hidden entirely** (`page.tsx:191-193` — a non-admin would otherwise see only their own rate and "—" for everyone, reading as broken data); row link says "View →" not "Edit →". **Who sees pay:** the Hourly column renders only for admins; `staff_compensation` is read self-or-admin so a non-admin reaching this page sees only their own value anyway (`page.tsx:70-82`).
- **Purpose:** org member register + invite entry point.
- **What the user sees:** header with member count + pending count + links to Rota / Leave requests / Schedule check; a canonical `DataTable` (sticky header, client-sort, roving-key nav, INERT selection checkboxes — no bulk actions by design, `page.tsx:174-178`); admin-only pending-invites panel + invite modal.
- **Features:**
  1. **Roster table** — problem: see who's in the org. Step: load `memberships` + embedded `users` (name/email/phone/employment_type/start_date), order by role; separately load `staff_compensation.hourly_pay` for members (admin sees all, non-admin sees own). CRUD: Read. Side-effects: none. Connected: each row → `/staff/[id]`. Prod: available. Deps/limits: loud-read guards (`readFailure`), no pagination on the roster read (acceptable for org member counts).
  2. **Pending invites (admin)** — reconciled against current members so an accepted invite drops off; uses service-role `listPendingInvites` (`_invites.ts`). CRUD: Read. Connected: resend action.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Add staff | header (admin only) | opens InviteStaffModal | — | modal | IMPLEMENTED, NOT LIVE-VERIFIED |
| Column sort (Name/Email/Role/Hourly/Since) | table header | client-side sort of loaded rows | — | re-order | IMPLEMENTED |
| Row select checkbox | table | INERT — no bulk action wired | — | nothing | PLACEHOLDER (intentional) |
| Edit → / View → | row end | navigates to `/staff/[id]` | — | detail page | IMPLEMENTED |
| Rota / Leave requests / Schedule check | subheader links | navigate | — | those pages | IMPLEMENTED |

---

### Page: Staff detail / profile — route `/staff/[id]` → app/(app)/staff/[id]/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** any member can open (own or co-worker). **Admin** sees + edits everything; **staff** gets a read-only page (forms render `isAdmin`-gated). **Who sees pay:** the Pay tile + profile `hourly_pay` default come from `staff_compensation` (self-or-admin): a staff user viewing a **co-worker** sees Pay = "—" and emergency contact blank (`page.tsx:88-105`); viewing **their own** detail they see their own pay. Pension/payroll-tax sections render only for admins (`page.tsx:110-111, 422-451`).
- **Purpose:** single-person record — profile, pay, performance, qualifications, holiday entitlement, pension, payroll-tax inputs, role, remove.
- **What the user sees:** breadcrumb, "View timesheet" button, Profile form, Pay mini-tile, Performance scorecard (derived), Qualifications list + add form, Holiday entitlement + derived balance, Pension auto-enrolment (admin), Payroll tax inputs (admin), Role selector (admin), AttachmentsPanel, Remove-from-org danger zone (admin, non-owner).
- **Features:**
  1. **Profile edit** — `updateStaffProfile` (admin). Writes `users` (name/phone/employment_type/start_date) + upserts `staff_compensation` (hourly_pay + emergency_contact). CRUD: Update. After: `formSuccess`, revalidate `/staff` + detail. Side-effects: none. Limits: verifies target is a member first.
  2. **Role change** — `updateStaffRole` (admin). Refuses owner assignment; **last-owner demotion guard** (counts owners, loud-reads, `last_owner_lock`). CRUD: Update. 
  3. **Remove from org** — `removeStaff` (admin). Refuses removing an owner; deletes membership (historical assignments/rota persist). CRUD: Delete (membership only). Confirm dialog via `ConfirmForm`.
  4. **Qualifications** — `addStaffQualification` / `deleteStaffQualification` (admin). Writes `staff_qualifications`. Connected: expiring items surface in daily briefing + bias the rota generator. Expiry badges computed client-side.
  5. **Holiday entitlement** — `upsertHolidayEntitlementAction` (admin). Writes via `holiday-balance` service; derived balance tiles (remaining/allowance/accrued/taken/booked/carried).
  6. **Pension auto-enrolment** (admin) — `upsertPensionEnrolmentAction`; percent→fraction. Feeds the payroll employer-cost **estimate**; filing is external.
  7. **Payroll tax inputs** (admin) — `upsertPayrollTaxProfileAction`; tax_region / student_loan_plan / salary_sacrifice (£→pence) / ni_category / dob / standard_hours_per_day. Refines take-home **estimate**; revalidates `/payroll`.
  8. **Performance scorecard** — read-model from `getStaffPerformance` (jobs assigned/completed/on-time, open NCRs, hours coverage). "Not a rating."
  9. **Attachments** — `AttachmentsPanel targetTable="memberships"`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| View timesheet | header | → `/staff/[id]/timesheet` | — | timesheet | IMPLEMENTED |
| Save (Profile) | Profile form (admin) | `updateStaffProfile` | name/phone/pay/type/dates/emergency | users + staff_compensation updated | IMPLEMENTED, NOT LIVE-VERIFIED |
| Update (Role) | Role section (admin) | `updateStaffRole` | role select | membership role changed (owner blocked, last-owner guarded) | IMPLEMENTED |
| Add qualification | Qualifications (admin) | `addStaffQualification` | type/title/ref/dates | row inserted | IMPLEMENTED |
| Delete (qualification) | per-row (admin) | `deleteStaffQualification` (confirm) | qual id | row deleted | IMPLEMENTED |
| Save (Holiday/Pension/Payroll-tax) | respective forms (admin) | upsert actions | form fields | config saved; payroll revalidated | IMPLEMENTED |
| Remove | danger zone (admin, non-owner) | `removeStaff` (confirm) | — | membership deleted | IMPLEMENTED |

---

### Page: Staff timesheet — route `/staff/[id]/timesheet` → app/(app)/staff/[id]/timesheet/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** admin OR the staff member themselves (`viewer.id === staffId`); anyone else gets a "Forbidden — your timesheet lives on /me" message (`page.tsx:47-57`). **Who sees pay:** the £/h rate + labour-cost tiles come from `staff_compensation`, authorised for exactly those viewers.
- **Purpose:** owner/admin triage of one person's hours (week + month) with labour cost; also self-accessible.
- **What the user sees:** breadcrumb, week nav (prev/next), 4 tiles (hours week/month, labour cost week/month), per-entry table (started/ended/hours/job/note/status: open|closed|locked).
- **Features:** 1. **Hours read** — paged `time_entries` for the month, org+user pinned, loud-read; week/month windows summed in-process. CRUD: Read. 2. **Labour cost** — hours × hourly_pay (loud on pay-read failure, not silent £0). No writes on this page.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| ← Prev week / Next week → | header | reload with `?weekStart=` | — | different week | IMPLEMENTED |
| Job link | per-row | → `/jobs/[id]` | — | job | IMPLEMENTED |

---

### Page: Rota — route `/staff/rota` → app/(app)/staff/rota/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** nav ADMIN_ROLES; page runs for any member. Admin sees the "Assign shift" form + per-shift delete (×); non-admin sees the grid read-only. No pay data on this page.
- **Purpose:** weekly Mon–Sun grid of shifts per staff member.
- **What the user sees:** week header with Generate rota / Schedule check / Prev / This week / Next; admin-only Assign form (with optional pre-fill banner from a schedule recommendation); staff × 7-day grid of shift chips (time + optional job link + admin × delete).
- **Features:**
  1. **Assign shift** — `createRotaEntry` (admin). Validates, **refuses an overlapping same-day shift** for that user (conflict read pinned to active org — comment `actions.ts:501-514`), inserts `rota_entries`. After: `bestEffortPushRota` (one-way calendar push, **no-op while the calendar integration is dark**; never blocks the save). CRUD: Create. Side-effect: calendar push (dark).
  2. **Delete shift** — `deleteRotaEntry` (admin). `bestEffortDeleteRotaEvent` first (dark no-op), then delete org-pinned. CRUD: Delete.
  3. **Prefill from recommendation** — URL params shape-checked (`readPrefill`); grant nothing (createRotaEntry re-validates + re-gates).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Generate rota | header | → `/staff/rota/generate` | — | planner | IMPLEMENTED |
| Schedule check | header | → `/staff/rota/conflicts` | — | conflicts | IMPLEMENTED |
| Prev / This week / Next | header | shift `?week=` | — | different week | IMPLEMENTED |
| Assign | Assign form (admin) | `createRotaEntry` | user/start/end/(job)/(notes) | shift inserted; calendar push (dark) | IMPLEMENTED, NOT LIVE-VERIFIED |
| × (delete) | shift chip (admin) | `deleteRotaEntry` | — | shift deleted | IMPLEMENTED |

---

### Page: Generate rota — route `/staff/rota/generate` → app/(app)/staff/rota/generate/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **STRICTLY READ-ONLY** (no form/action/mutation on the page).
- **Roles:** runs for any member (`requireOrgContext` only — **NOT page-level admin-gated**, though only linked from the admin Assign header). Not in nav.
- **Purpose:** deterministic constraint solver proposing one person per unstaffed job in the next `SCHEDULE_WINDOW_DAYS`. "No AI, no guesswork" — score = sum of shown factors.
- **What the user sees:** plan summary (N of M jobs staffable), proposed-assignment cards (person, role, score, evidence row-ids, "Fill in on the rota" link), "Nobody free" cards, ranking-criteria disclosure.
- **Features:** 1. **Build plan** — `buildRotaPlan(org_id)` over rota/leave/assignments/locations. CRUD: Read. 2. **Apply link** — opens `/staff/rota?assign_*=…` prefilled; the shift exists only when a human presses Assign (admin-gated `createRotaEntry`). Side-effects: none.
- **Buttons & controls:** Schedule check / ← Back to rota (navigate); "Fill in on the rota" per card (prefills the Assign form).
- **Note:** page copy says the solver "answers who is free and who is nearest — never who is best — because CrewFlow stores no skills or certifications" (`generate/page.tsx:301`), while `/staff/[id]` says "the rota generator prefers people who hold a job's required qualifications" (`[id]/page.tsx:310`). Minor doc inconsistency — flagged, not verified against the solver internals.

---

### Page: Schedule check (conflicts) — route `/staff/rota/conflicts` → app/(app)/staff/rota/conflicts/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **STRICTLY READ-ONLY** (incl. recommendations).
- **Roles:** runs for any member (not page-level admin-gated; linked from admin Assign header). Not in nav.
- **Purpose:** deterministic conflict detector across rota / jobs / approved leave / plant custody, each with ranked fix options.
- **What the user sees:** conflict roll-up by kind, per-day grouped conflict cards (severity + kind + "Open" link), collapsible "How to fix this" recommendation panels (candidate cards with score factors + "Fill in on the rota" + "why others were not offered").
- **Features:** 1. `buildScheduleIntegrity(org_id)` — Read. 2. Recommendation apply links → prefilled Assign form (write only via `createRotaEntry`, admin-gated). Side-effects: none.
- **Buttons & controls:** ← Back to rota; per-conflict "Open" (→ `c.href`); "Fill in on the rota" per candidate.

---

### Page: Leave requests — route `/staff/leave` → app/(app)/staff/leave/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** ALL roles. Staff: submit own + see team leave for awareness + cancel own pending. Admin: everything + Approve/Reject on pending rows. Default filter = `pending` (admin) / `mine` (staff). No pay data.
- **Purpose:** holiday/sick/emergency/unpaid request lifecycle (pending → approved | rejected | cancelled).
- **What the user sees:** filter pills (Mine/Pending/All), own holiday-balance tiles (if entitlement configured), Request-leave form, org-wide "Leave calendar" (upcoming approved+pending), requests table (staff/type/dates/reason/status + per-row actions).
- **Features:**
  1. **Submit leave** — `createLeaveRequest` (any member, no admin gate). Inserts `leave_requests` status=pending. **Side-effect: emails owners/admins** via `notifyOwnersOfLeaveRequest`; in-app notification via DB trigger (`actions.ts:626-636`). CRUD: Create.
  2. **Approve / Reject** — `reviewLeaveRequest` (admin). Updates status + reviewer + note, only while `status='pending'` (`already_reviewed` guard, org-pinned). **Side-effect: emails the requester** via `notifyStaffOfLeaveDecision` (`actions.ts:684-694`); in-app notification via DB trigger. CRUD: Update. Connected: approved holiday feeds payroll holiday-pay + holiday-balance.
  3. **Cancel** — `cancelLeaveRequest` (own pending only). Sets status=cancelled. CRUD: Update.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Mine / Pending / All | header filters | reload `?filter=` | — | filtered list | IMPLEMENTED |
| Submit (Request leave) | form (all) | `createLeaveRequest` | type/start/end/(reason) | request created; owners emailed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Approve | pending row (admin) | `reviewLeaveRequest` (decision=approved) | — | approved; requester emailed | IMPLEMENTED |
| Reject | pending row (admin) | `reviewLeaveRequest` (decision=rejected) | — | rejected; requester emailed | IMPLEMENTED |
| Cancel | own pending row | `cancelLeaveRequest` | — | cancelled | IMPLEMENTED |

---

### Page: Payroll overview — route `/payroll` → app/(app)/payroll/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** admin-only — **non-admins get a redirect-style message to /me, not the data** (`page.tsx:33-43`, and the route is hard-gated, not just nav-gated). **Who sees pay:** owner/admin only; the whole run register (gross/net per run) is here. Org-pinned (`.eq("org_id")`) — the most sensitive list in the product; a dual-org owner previously saw both companies' totals.
- **Purpose:** create weekly/monthly runs + run history.
- **What the user sees:** "estimates" disclaimer, two new-run forms (weekly/monthly with default periods), run-history list (cycle · period · line count · gross · net · status chip draft|finalised).
- **Features:**
  1. **Create run** — `createPayrollRun` (admin). **Open-entry guard**: refuses the run if any staff are still clocked-in in the window (names them) so no hours are silently dropped (`actions.ts:60-121`, paged F-1). Pulls members (paged) + `staff_compensation.hourly_pay` (paged, loud) + closed `time_entries` (paged, **org-pinned** — prevents a dual-org worker's other-employer hours inflating pay) + approved holiday. Computes per-line gross/PAYE/NI/net + overtime(0)/holiday pay via `computePayrollLine`. Writes `payroll_runs` + `payroll_lines`; **rolls back the run if the lines insert fails** (no silent £0 run). CRUD: Create. Side-effects: none external. Prod: available. Limits: estimates only (see completeness note below).
  2. **Run totals** — per-run gross/net/count summed from paged `payroll_lines` (loud-read). Read.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Create (weekly/monthly run) | two forms | `createPayrollRun` | cycle/period_start/period_end | draft run + lines; →`/payroll/[id]` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Run link | history list | → `/payroll/[id]` | — | run detail | IMPLEMENTED |

---

### Page: Payroll run detail — route `/payroll/[id]` → app/(app)/payroll/[id]/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** admin-only (non-admin gets a message to /me, `page.tsx:53-63`). Org-pinned run + paged lines. **Who sees pay:** owner/admin — this is the full per-employee pay table incl. masked NI, gross, PAYE, employee NI, net, overtime, holiday, employee pension, take-home, employer cost.
- **Purpose:** review a run's lines + totals, record overtime on draft lines, finalise, export CSV, download payslips, prepare (held) RTI FPS.
- **What the user sees:** CSV/Finalise/Delete-draft header buttons; deterministic Payroll insights panel (no AI); summary stat tiles (hours/gross/PAYE/employee-NI/net); overtime+holiday tiles; NI-category check warnings; take-home refinement tiles; **employer-cost tiles (employer NI est, employer pension est, employer NI after Employment Allowance, total employment cost est)** with a long estimates disclaimer; per-line table; RTI (FPS) prepare section.
- **Features:**
  1. **Finalise run** — `finalisePayrollRun` (admin). Org-pinned; irreversible; stamps `payroll_line_id` onto each worker's window time entries (org-pinned, paged) → those timesheets become read-only; sets status=finalised. CRUD: Update. Side-effect: locks `time_entries`.
  2. **Delete draft** — `deletePayrollRun` (admin). Org-pinned read + delete; **refuses a finalised run** (immutable); cascades to lines. CRUD: Delete.
  3. **Record overtime** — `setPayrollLineOvertime` (admin, draft-only). Reprices gross/PAYE/NI/net from the same `computePayrollLine` authority preserving holiday hours; **append-only audit row** to `payroll_line_adjustments` (before→after + actor). CRUD: Update + audit insert.
  4. **Prepare RTI (FPS)** — `prepareFpsRunAction` (admin, finalised-only). Builds a FROZEN internal FPS record via `prepareFpsReturn`; **does NOT file to HMRC** (no submit/network path; recognition-gated — `RTI_NO_FILING_NOTICE`). CRUD: Create (internal record). Side-effect: none external.
  5. **Derived employer/employee overlays** — employer NI + pension derived on read at the run-period's rate table (`employerCostsForStoredLineWithPension`); employee take-home refined by tax profile + pension (`computeEmployeeDeductionsForStoredLine`); Employment Allowance shown as an "up to" estimate. Read/compute only.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Export CSV | header | GET `/api/payroll/[id]/csv` (new tab) | — | CSV download | IMPLEMENTED, NOT LIVE-VERIFIED |
| Finalise run | header (draft) | `finalisePayrollRun` | — | run locked; entries locked | IMPLEMENTED |
| Delete draft | header (draft) | `deletePayrollRun` | — | run+lines deleted (finalised refused) | IMPLEMENTED |
| Overtime hours/multiplier | per-line (draft) | `setPayrollLineOvertime` | hours/multiplier | line repriced + audited | IMPLEMENTED |
| PDF (payslip) | per-line | GET `/api/payroll/lines/[id]/pdf` (new tab) | — | payslip PDF | IMPLEMENTED |
| Prepare RTI (FPS) | RTI section (finalised) | `prepareFpsRunAction` | — | frozen FPS record; NOT filed | IMPLEMENTED (filing dark) |

---

### API: Payroll CSV — route `/api/payroll/[id]/csv` → app/api/payroll/[id]/csv/route.ts
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Admin-only (403 otherwise). Org-pinned run + paged lines (F-1) + loud 500 on read failure (so a bureau never gets a header-only "nobody was paid" CSV). Columns include name, **NI number (full, not masked — admin export)**, hours, rate, gross, PAYE, NI, salary sacrifice, student loan, employee pension, net, overtime, holiday, employer NI + pension. `Cache-Control: private, no-store`.

### API: Payslip PDF — route `/api/payroll/lines/[id]/pdf` → app/api/payroll/lines/[id]/pdf/route.ts
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Access = the line's own `user_id` (staff downloading their own) OR owner/admin; org-pinned by statement; 403 otherwise. **NI shown FULL to admins, MASKED to the self-downloading staff member** (`route.ts:80`). Refines figures by the employee's tax profile + pension.

### API: Public staff roster — route `/api/v1/staff` → app/api/v1/staff/route.ts
- **Status:** FLAGGED OFF — dark behind `FEATURE_PUBLIC_API_JOBS` (404 while off, per `guardPublicApiRequest`). API-key auth, `read:staff` scope, 429 budget, org-pinned service-role read. **Projection is identity-free: role + join date only — user_id/name/email/phone NOT selected, `users` never joined** (`lib/public-api/staff.ts`). No pay data exposed.

---

### Page: My day (staff self-view) — route `/me` → app/(app)/me/page.tsx
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** staff landing (also reachable by any member). **Who sees pay:** the caller's OWN `staff_compensation.hourly_pay` only (self-read RLS); own expected gross + take-home. No other person's data. **Employer NI/pension deliberately NOT shown here** (not a deduction from the worker's wages).
- **Purpose:** field-worker home — clock in/out, break, today/week hours, expected pay, today's rota, my jobs, my tasks, upcoming leave.
- **What the user sees:** big clock-in/out button (job + note on clock-in), Start/End break, 4 tiles (today/week hours, expected gross, expected take-home with PAYE·NI·SL·pension sub-caption), timesheet history (month), today's rota, my jobs, my tasks, upcoming leave.
- **Features:**
  1. **Clock in** — `clockIn` (me/actions.ts). Blocks if already open; **blocks if on approved leave** (loud-read, fails closed); inserts `time_entries` with optional job/note/GPS. CRUD: Create.
  2. **Clock out** — `clockOut`. Closes open entry, **auto-closes still-open breaks**. CRUD: Update.
  3. **Start/End break** — `startBreak`/`endBreak`. Mutates the `breaks` JSON array on the open entry. CRUD: Update.
  4. **Reads** — own pay/hours (paged, loud), rota today, leave upcoming, my jobs (`assigned_to = user.id`, excludes completed+cancelled, loud), my tasks (`job_checklists`, paged, loud). Own take-home refined by own tax profile + pension.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Clock in | primary (when out) | `clockIn` | optional job/note | open time entry | IMPLEMENTED, NOT LIVE-VERIFIED |
| Clock out | primary (when in) | `clockOut` | — | entry closed | IMPLEMENTED |
| Start break / End break | when clocked-in | `startBreak`/`endBreak` | — | break toggled | IMPLEMENTED |
| View job → / All jobs → / Request leave → / task links | tiles | navigate | — | target page | IMPLEMENTED |

Note: `clockIn`/`clockOut`/break reads check `user_id` without an explicit `org_id` pin (`me/actions.ts:35-40, 82-87` etc.) — a person is expected to have one open entry globally; the open-entry unique index backs this. The `/me` page reads ARE org-pinned. Flagged as a design choice, not verified cross-org.

---

## DOMAIN SUMMARY

**Counts** — Pages/routes audited: 11 (`/staff`, `/staff/[id]`, `/staff/[id]/timesheet`, `/staff/rota`, `/staff/rota/generate`, `/staff/rota/conflicts`, `/staff/leave`, `/payroll`, `/payroll/[id]`, `/me`) + 3 API routes (`/api/payroll/[id]/csv`, `/api/payroll/lines/[id]/pdf`, `/api/v1/staff`). Server-action files: `staff/actions.ts` (14 actions), `payroll/actions.ts` (5 actions), `me/actions.ts` (4 actions).

**Status tally** — LIVE & WORKING: 0 (no browser verification performed this pass). IMPLEMENTED, NOT LIVE-VERIFIED: ~10 pages + 2 API routes. FLAGGED OFF: 1 (`/api/v1/staff`, `FEATURE_PUBLIC_API_JOBS`). Partially/dark sub-features: calendar push on rota (dark, no-op), RTI FPS filing (prepared-only, recognition-gated). PLACEHOLDER: staff-list row-selection checkboxes (intentionally inert). BROKEN: none found.

**Hard-to-discover** — `/staff/rota/generate` and `/staff/rota/conflicts` (deterministic scheduler + conflict detector, substantial features) are NOT in nav; reachable only from the rota header. `/staff/[id]/timesheet` only via the detail-page button. Payroll insights + employer-cost tiles are rich but buried inside a run.

**Implemented, not in nav** — the two rota planner subpages (above); `/staff/[id]` and `/payroll/[id]` (expected — detail routes).

**Orphaned / dead code** — `upsertStaffNiNumber` (`lib/staff/secrets.ts:81`) and the `canonicaliseNiNumber` helper have **ZERO callers** anywhere in `app/`, `server/`, `lib/` (grep-confirmed). Consequently **there is no UI or import path to set an NI number** — NI only enters via direct DB write/migration backfill, yet it is surfaced on payslips + the bureau CSV. Real gap, not just dead code.

**Server-actions / API with no UI** — `resendStaffInvite` exists and is wired through the pending-invites panel (has UI). No other orphaned actions found in this domain. The NI write helper is the one no-UI capability.

**Pay-data access control (verdict)** — well-constructed and DB-enforced: (1) `staff_compensation` (migration 20261218) self-or-admin RLS with pay/emergency columns dropped from `users`; a co-worker sees "—"; the staff-list Hourly column is hidden entirely for non-admins. (2) `staff_secrets` NI admin-only, not even self-readable, masked for self on payslips, full for admins on CSV/PDF. (3) All payroll surfaces admin-gated AND org-pinned in-statement (defence against RLS admitting a dual-org owner's second company). (4) Public API roster is identity-free. No pay-visibility leak found in code.

**Payroll completeness (verified against code — supersedes the stale memory note "estimates only, no employer NI/pension")** — The memory note is **STALE**. Employer NI AND employer pension **ARE now modelled** (`lib/payroll/compute.ts:488-562, 658+`; migrations `20261142` pension, `20261155` payroll tax inputs), derived on read at the run-period's rate table, surfaced as "Total employment cost est" + Employment-Allowance offset, and included in the CSV — so labour margins are no longer structurally understated. Everything remains explicitly **estimate-grade** (standard 1257L code, 2025-26 thresholds, "confirm with your accountant before filing"), and HMRC **RTI filing stays dark** (FPS is prepared/frozen internally, never submitted). Holiday pay is baked into gross once (worked vs holiday days disjoint); overtime is an audited per-line draft input. Remaining honest limitation: under-21/apprentice/veteran NI nuances and pension opt-outs are only partially modelled (disclaimed on-page), and NI numbers have no entry UI (above).
