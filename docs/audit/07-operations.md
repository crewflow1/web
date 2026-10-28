# CrewFlow Feature & Button Audit — 07 · Operations

Domain: **Operations** nav area (`_nav/nav-model.ts:196-214`, area `roles: ADMIN_ROLES`).
Method: READ-ONLY static inspection of `app/(app)/{operations,assets,fleet,stock,materials,sites,suppliers,purchase-orders}`. Browser verification NOT performed (authenticated multi-role prod access out of scope). Status legend + roles per `docs/audit/CONVENTIONS.md`. `ADMIN_ROLES = owner + admin`; only roles are owner/admin/staff.

**Nav gating caveat (whole domain):** the Operations area is `roles: ADMIN_ROLES`, so **staff never see any Operations link in the sidebar / command palette**. But almost every page file only calls `requireOrgContext()` (any member) — RLS, column-ACLs and in-page `isAdmin` checks are the real boundary. Staff can reach most routes by direct URL / deep-link / QR. Per-page role notes below record where the page adds an explicit gate vs. where it leans on RLS.

---

## Page: Operations overview — route `/operations`

### Page: Operations overview — route `/operations`
- **Status:** LIVE & WORKING. `force-dynamic` (`operations/page.tsx:28`); org-pinned via `buildOperationsSnapshot(ctx.org.id)` (`:55`).
- **Roles:** Nav-gated to owner/admin (area `ADMIN_ROLES`); page itself only `requireOrgContext()` (`:54`) so a staff member reaching it by URL would render. Per-role diff: the "Running costs" maintenance figure is masked for non-admins — hint reads "Visible to owners and admins only" (`:416-417`, `isAdmin` at `:61`); every other figure is role-identical.
- **Purpose:** The command centre — one screen answering "what needs me across everything I run": vehicle legal breaches, plant out of service, overdue inspections, overdue custody, schedule clashes, running costs.
- **What the user sees:** Header; (new-estate) an onboarding EmptyState + "What lands here" teaching card (`:63-112`); else up to two red exposure banners (in-service vehicles without valid MOT/insurance `:121-133`; assets failed a safety inspection and not cleared `:134-147`), 5 StatTiles (Off the road / Renewals due / Out of action / Inspections overdue / Clashes today `:153-221`), then SectionCards: Vehicle dates, Out of action, Inspections, Today and tomorrow, The estate, Overdue back, Running costs.
- **Features:**
  1. **Attention snapshot (read-only composite).** Problem: five operational risk classes scattered across five pages. Flow: `buildOperationsSnapshot` composes from the SAME domain libs the sub-pages use (fleet compliance `lib/fleet/compliance.ts`, conflicts `lib/schedule/conflicts.ts`, safety blocks `lib/assets/inspection-override.ts`, due-ness `lib/assets/inspection-schedule.ts`, custody `lib/assets/assignment.ts`, money `lib/fleet/fuel.ts`) so a number here can never disagree with its domain page. Data CRUD: READ only — "STRICTLY READ-ONLY. No form, no server action, no mutation" (`:39-40`). After-success: n/a. Side-effects: none. Connected: every tile/card deep-links into fleet/assets/staff surfaces. Prod: available. Deps/limits: `OPS_CARD_LIMIT` caps each card's preview; snapshot is org-pinned on top of RLS (`:42-44`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| 5 StatTiles | Grid | Navigate to `/fleet/vehicles`, `/fleet/compliance`, `/assets`, `/assets/inspections`, `/staff/rota/conflicts` | — | Filtered surface | LIVE |
| "see the list" (breach banner) | Banner | → `/fleet/compliance` | — | Compliance board | LIVE |
| "see what is blocked" | Banner | → `/assets/inspections` | — | Blocked list | LIVE |
| Card links (Compliance board / Asset register / All inspections / Schedule check / Holdings / Fuel and costs) | SectionCard headers | Navigate | — | Sub-surface | LIVE |
| Empty-state CTAs (Add a vehicle / Add plant or a tool / rota) | New-estate state | Navigate | — | Create flows | LIVE |

No write controls on this page by design.

---

## Assets — route group `/assets` (plant / equipment / PAT / LOLER / calibration)

### Page: Asset register (list) — route `/assets`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** Any member (`requireOrgContext()`, `assets/page.tsx:60`); nav-gated to admins. No per-role diff.
- **Purpose:** The org-scoped register of every van/machine/tool, one row per asset.
- **What the user sees:** Header with 6 actions (Holdings, Inspections, Templates, Calibration, Scan, + Add asset), a status filter bar (All + 6 statuses), a card list (status/ownership pills, category, name, spec, serial/reg, View), count footer "N assets shown · M active" (`:211-213`), 🚜 empty state.
- **Features:**
  1. **Asset list.** One read of `assets` (10 cols), `created_at` desc, `limit(1000)`, org-pinned (`:69-88`); optional `?status=` validated vs `ASSET_STATUSES` (`:64-67`); loud read (throws `:90`). CRUD: READ `assets`. Side-effects: none. Deps/limits: **1000-row cap, no F-1 pagination** — a large fleet silently truncates (contrast `/assets/calibration`).
  2. **Saved/error banners** from `?saved`/`?error` via SAVED_MAP/ERROR_MAP (`:41-51`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Add asset | Header | → `/assets/new` | — | New-asset form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Holdings / Inspections / Templates / Calibration / Scan | Header | Navigate to sub-routes | — | Navigates | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status filter pills (All + 6) | Nav bar | `/assets?status=…` | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | Each row | → `/assets/[id]` | — | Detail | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Add asset — route `/assets/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** Any member (`new/page.tsx:21`); `createAsset` does not gate on role (RLS governs).
- **Purpose:** Create an asset with identity, finance and hire fields.
- **What the user sees:** `StateForm`: Name (required), Category (datalist), Ownership, Manufacturer/Model/Serial/Registration/reference, Supplier select (org-pinned `:45-48`), Finance fieldset, Hire fieldset, Notes; Add asset / Cancel.
- **Features:**
  1. **Create asset.** `StateForm action={createAsset}` → Zod `createAssetSchema` (`schema.ts:91-113`) → insert `assets` with `created_by` (`actions.ts:99-125`). CRUD: CREATE `assets`; READ `suppliers`. After-success: `recordAdminActivity("asset.created")` then redirect `/assets/[id]?saved=created` (`:131-140`). Side-effects: admin-activity audit only. Deps/limits: supplier-read failure throws the whole page (`:49`), not panel-scoped.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add asset (submit) | Form | `createAsset` insert | Name required | Redirect to new detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Form | → `/assets` | — | List | IMPLEMENTED, NOT LIVE-VERIFIED |
| Supplier / hire company | Form | Select org suppliers | — | Sets `supplier_id` | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Asset detail — route `/assets/[id]` (+ tabs `_custody` `_inspections` `_safety` `_maintenance` `_service-schedules` `_calibration` `_depreciation` `_schedules` `_timeline`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** Any member reads + acts on most sections. **Owner/admin only** (`canDelete`, `page.tsx:172`): Delete asset, maintenance Costs sub-panel, service-schedule add/pause/delete, inspection-schedule add/pause/delete, depreciation save/clear, calibration delete, override record/revoke. Member-open: status change, custody check-out/return/transfer, QR generate/revoke, ad-hoc & templated inspections, maintenance report/transition, calibration record, re-inspection.
- **Purpose:** The single asset's command centre — identity, status, custody, QR label, inspections, safety blocks, maintenance, service & inspection schedules, calibration certs, depreciation, unified history, attachments.
- **What the user sees:** Header + pills, details card, Status button row, Safety blocks (red, conditional), Custody, QR identity, Inspections, Maintenance, Service schedules, Calibration certificates, Depreciation, Inspection schedules, History timeline, Attachments, Delete (admin). ~13 org-pinned reads; most throw on error, job + template pickers are panel-scoped via `PickerNotice` (`:247,352,670,722,751`).
- **Features (condensed):**
  1. **Status change** (`updateAssetStatus`, `actions.ts:143-175`) — 6 count-gated status buttons; audit `asset.status_changed`.
  2. **Custody** (`_custody.tsx` + `assignment-actions.ts`) — check-out (insert `asset_assignments`), return (count-gated on `status='open'`), transfer (atomic RPC `transfer_asset_assignment`, `:188`). DB partial-unique index + guard trigger (23505/23514) is the real gate; site destination validated by `tg_site_reference_org_integrity`. Audit per event.
  3. **QR identity** (`qr-actions.ts`) — generate/regenerate via atomic RPC `rotate_asset_qr_identity`; revoke count-gated; opaque crypto token; Print label/sheet → `/api/assets/[id]/label/pdf`.
  4. **Inspections** (`_inspections.tsx` + `inspection-actions.ts`) — start-from-template (published only, `:330`), ad-hoc draft, issue, discard; immutability trigger makes issued rows write-once.
  5. **Safety blocks** (`_safety.tsx`) — per current blocking fail: Record re-inspection, Create repair case (member), Record/Revoke override (admin, reason ≥10 chars); honest "operational override", never "cleared".
  6. **Maintenance** (`_maintenance.tsx` + `maintenance-actions.ts`) — report/plan, legal state-machine transitions (`canTransitionCase`, DB guard `20261002`), reopen, admin-only Costs upsert; side-effects: `emitNotifications` (maintenance.reported, ready_for_return_to_service), schedule writeback on complete.
  7. **Service schedules** (`_service-schedules.tsx`) — admin add/pause/delete; cron generates cases.
  8. **Calibration certificates** (`_calibration.tsx` + `calibration-actions.ts`) — member record external-lab cert (CrewFlow never issues), admin delete; next-due re-arms linked schedule via DB trigger.
  9. **Depreciation** (`_depreciation.tsx`) — admin save/clear; NBV computed on read, nothing derived stored.
  10. **Inspection schedules** (`_schedules.tsx`) — admin add/pause/delete; cron raises due inspections.
  11. **History timeline** (`_timeline.tsx`) — composed server-side (capped 30); scans write nothing so are absent by design (`:539`).
  12. **Attachments** — universal `AttachmentsPanel targetTable="assets"`.
  - **Banned pattern:** NOT present — all actions return `FormState` + navigate via `StateForm`/`redirectTo`; deliberately no `revalidatePath`/`redirect()` on the deep route (documented `actions.ts:16-30`).
- **Buttons & controls (selected):**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Status pills (6) | Status card | `updateAssetStatus` count-gated | status | `?saved=status` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Check out / Return / Transfer | Custody | insert/close/RPC | destination (job/staff/site/location) | `?saved=checked_out/returned/transferred` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate/Regenerate/Revoke QR | QR card | RPC / count-gated | — | `?saved=qr…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Print label / Print sheet | QR card | → `/api/assets/[id]/label/pdf[?copies=12]` | active QR | PDF (new tab) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Start inspection / Record / Issue / Discard | Inspections | template/ad-hoc flows | template or title | run page / `?saved=inspection` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record re-inspection / Create repair case | Safety blocks | new draft / prefilled case | — | `?saved=…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record/Revoke override (admin) | Safety blocks | dual-gated | reason ≥10 chars | `?saved=override[_revoked]` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Report fault / Move to / Reopen | Maintenance | report / `transitionMaintenanceCase` | to-state | notify + `?saved=case_…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save costs (admin) | Maintenance | `upsertCaseCosts` admin-only | £ fields | `?saved=case_costs` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add/Pause/Remove service & inspection schedule (admin) | Schedule cards | create/toggle/delete | type/cadence/due | `?saved=schedule…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record cert / Delete cert (admin) | Calibration | record / delete | cert#, by, date, result | `?saved=calibration…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save/Clear depreciation (admin) | Depreciation | save/clear policy | cost, start, life/rate | `?saved=depreciation…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete asset (admin) | Footer | `deleteAsset` role-checked | — | `/assets?saved=deleted` | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Inspection run — route `/assets/[id]/inspections/[inspectionId]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** Any member (`page.tsx:65`); org-pinned by id+asset_id+org (`:87-90`).
- **Purpose:** Execute a templated checklist against the frozen template snapshot; save progress or complete+lock.
- **What the user sees:** Breadcrumb, status line, banners, checklist rendered from `template_snapshot` (pass/fail, yes/no, choice, number/meter, date, acknowledgement, text; per-item comment/signature), AttachmentsPanel.
- **Features:**
  1. **Run checklist.** Save progress (`saveInspectionAnswers`, draft-only count-gated) or Complete (`completeTemplatedInspection`) — validates required/fail-comments/signatures, derives outcome (`deriveOutcome`), issues atomically, writes back `last_completed_at` to the generating schedule. **Side-effect:** `emitNotifications("inspection.failed_safety", priority urgent)` when a safety-critical fail is derived (`inspection-actions.ts:506-523`). CRUD: UPDATE `asset_inspections`; immutability trigger freezes issued row.
  - **Banned pattern:** Uses `useActionState` BUT navigates via `window.location.assign` (`_run-form.tsx:38-47`) — the mandated fix, not the banned `revalidatePath` pattern.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Complete inspection | Run form | validate + issue | all required answers, fail comments, signatures | `?saved=issued`, record locked | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save progress | Run form | `saveInspectionAnswers` | — | `?saved=progress` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Attachments | Below form | universal pipeline | file | Evidence attached | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Inspections overview — route `/assets/inspections`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **Hard-to-discover** (header button only).
- **Roles:** Any member.
- **Purpose:** Fleet-wide "what's overdue, what's due, which assets are blocked".
- **What the user sees:** 3 stat tiles (Overdue / Due-open / Blocked), red Blocked-assets section, Overdue/Due lists linking to run pages.
- **Features:** Due backlog (draft inspections with `due_at`, limit 100, split overdue/upcoming); safety picture (issued safety-critical + overrides, grouped per asset via `currentSafetyBlocks`). All reads loud. Side-effects: none.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Asset link (blocked) | Blocked section | → `/assets/[id]` | — | Detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Inspection link | Due/Overdue lists | → run page | — | Run | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Calibration register — route `/assets/calibration`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Header-button only.
- **Roles:** Any member.
- **Purpose:** Org-wide read-only table of every calibration cert, worst-expiry first.
- **What the user sees:** Expired/due-soon counts, table (Asset, Certificate, Calibrated by, Cal date, Next due + state pill, Result), 📏 empty state. No create here (made from asset page).
- **Features:** F-1 paginated via `fetchAllRows` stable `(calibration_date desc, id)` (`:57-90`) — the only assets list route that paginates safely; classified by `classifyCalibrationExpiry`, sorted by `EXPIRY_RANK`. READ. Side-effects: none.
- **Buttons & controls:** Asset link → `/assets/[id]` (IMPLEMENTED, NOT LIVE-VERIFIED).

### Page: Holdings — route `/assets/holdings`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Header-button only.
- **Roles:** Any member.
- **Purpose:** "Who has what right now" — open custody grouped by holder kind.
- **What the user sees:** 4 grouped sections (Staff-held / On jobs / On vehicles / Depots-repair-suppliers), asset→holder, since-date, due-back/overdue pill, view-job link.
- **Features:** One read of `asset_assignments` status=open, limit 300, explicit FK hints `assets!asset_assignments_asset_id_fkey` + `users!…_assignee_id_fkey` (a bare embed → PGRST201 since fleet added a second assets FK, `:57-69`). Loud. Side-effects: none.
- **Buttons & controls:** Asset link → detail; "view job" → `/jobs/[id]` (IMPLEMENTED, NOT LIVE-VERIFIED).

### Page: Scan — route `/assets/scan` (+ `_scanner.tsx`)
- **Status:** PARTIALLY IMPLEMENTED — camera path depends on browser `BarcodeDetector`; manual fallback always works.
- **Roles:** Any member (`scan/page.tsx:14`).
- **Purpose:** In-app QR scanner; resolve a printed label to an asset.
- **What the user sees:** "Scan with the camera" (video + Start/Stop) and "Enter the code" manual box. Chrome/Android use native `BarcodeDetector`; iOS Safari etc. shows "can't scan in-app" + manual entry.
- **Features:** Client-only — `tokenFromScan` extracts token (path `/a/<token>` only), `router.push(scanPath(token))` → `/a/[token]` resolves behind auth+RLS+active-org. No DB write. `_scan.ts` wraps `resolveScannedAssetForOrg` (every failure → `null`, no enumeration). Side-effect: camera stream (released on unmount).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Start / Stop camera | Camera panel | getUserMedia + detect loop | camera permission | Navigates on decode | PARTIALLY IMPLEMENTED (browser-gated) |
| Open asset (manual) | Code panel | `tokenFromScan` → navigate | token/label URL | → `/a/[token]` or inline error | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Inspection templates library — route `/assets/templates` (+ `new`, `[id]`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Header-button only.
- **Roles:** Any member — **template-actions have NO admin gate**, only `requireOrgContext()` (see finding). So any staff member can create, edit, publish or archive a safety-inspection checklist.
- **Purpose:** Checklist library (one face-row per family), new-draft create, and a full version/publish/archive editor.
- **What the user sees:** Library: search + status filter + table + 📋 empty state. New: Name/Description/Level/Categories → Create draft. Editor: status/version pills, lifecycle buttons (Publish / New version / Clone / Archive), publish-problem checklist, section/item editors (draft-only), version history.
- **Features:** family library grouped to published-preferred face row; `createTemplate` (new `family_id` v1 draft); lifecycle `publishTemplate`/`createNextVersion`/`cloneTemplate`/`archiveTemplate`; definition edits (`addSection`/`addItem`/move/remove) write draft `definition` JSON; completed inspections keep their exact recorded version. Side-effects: audits only.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New template | Library | → `/assets/templates/new` | — | New form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Search / status pills | Library | query-param filter | — | Re-renders | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create draft | New | `createTemplate` | name | → editor | IMPLEMENTED, NOT LIVE-VERIFIED |
| Publish / New version / Clone / Archive | Editor | lifecycle actions | ≥1 section w/ item (publish) | `?saved=…` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add/Remove/Move section & item | Editor (draft) | draft-def writes | title/type | Updated def | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Fleet — route group `/fleet` (vehicles / vans / MOT / compliance / fuel)

Common: no route-level role gate anywhere in `app/(app)/fleet` — all routes reachable by owner/admin/staff (only `requireOrgContext()`); enforcement delegated to DB (maintenance-cost masking + admin-only compliance/fuel-delete RLS). Banned hang pattern correctly avoided (FormState + `window.location.assign`, `state-form.tsx:43`, `vehicle-form.tsx:68`; no `revalidatePath`).

### Page: Fleet overview — route `/fleet`
- **Status:** LIVE & WORKING. `force-dynamic` (`page.tsx:10`); org-pinned `loadFleetOverview` (`:29`).
- **Roles:** Any member. Per-role diff: Maintenance cost row masked to £0 for non-admins (RLS on `asset_maintenance_case_costs`; hint `:225-228`).
- **Purpose:** One-screen fleet command centre — counts, legal-breach alert, compliance attention, costs, fuel efficiency, 6-vehicle preview.
- **What the user sees:** Header nav (Compliance / Fuel & costs / Vehicle register / + Add vehicle), banners, red legal-breach banner, 🚐 empty state, 4 stat tiles, compliance attention list (first 8), running-costs + fuel-efficiency cards, vehicles preview (first 6).
- **Features (read-only):** legal-breach count (in-service vehicles with expired MOT/insurance); stat tiles link to filtered views; compliance attention (`state` overdue/due_soon); running costs = fuel + repairs only; fuel efficiency (mpg or honest "—", refuses to fabricate). READ only; side-effects none; deterministic `assessCompliance` date maths.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Compliance / Fuel & costs / Vehicle register | Header | Navigate | — | Sub-pages | LIVE |
| + Add vehicle | Header | → `/fleet/vehicles/new` | — | New-vehicle form | LIVE |
| Stat tiles (x4) | Grid | → filtered views (incl. `?status=off_road`) | — | List/board | LIVE |
| Attention / preview rows | Cards | → vehicle `#compliance` / detail | — | Detail | LIVE |

### Page: Vehicle register — route `/fleet/vehicles`
- **Status:** LIVE & WORKING. `force-dynamic` (`:17`); org-pinned (`:54-55`).
- **Roles:** Any member; no field diffs.
- **Purpose:** Full paged, searchable, status-filterable vehicle list.
- **What the user sees:** Header (Overview / Add vehicle), availability filter pills with counts, search form, mobile cards / desktop table, pagination footer.
- **Features:** search (`?q=` TS filter over name/make/model/VIN/depot/class + plate match via `normaliseRegistration`); status pills vs `OPERATIONAL_STATUSES`; pagination PAGE_SIZE 25; worst-compliance pill per row. F-1 safe via `fetchAllRows` (avoids 1000 clamp). READ.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Overview / + Add vehicle | Header | Navigate | — | Overview / form | LIVE |
| Filter pills (All/In service/Off road/In workshop) | Nav | `?status=` | — | Filtered | LIVE |
| Search input + Search | Toolbar | GET `?q=` | free text | Filtered | LIVE |
| Row / card link | Table/cards | → detail | — | Detail | LIVE |
| Previous / Next / Clear filters | Footer | Navigate | — | Page change | LIVE |

### Page: Fleet compliance — route `/fleet/compliance`
- **Status:** LIVE & WORKING. `force-dynamic` (`:9`). Explicitly DETECTION-ONLY — no provider, sends nothing (`:18-21,196-200`).
- **Roles:** Any member; no diff.
- **Purpose:** Worst-first board of every MOT/insurance/road-tax/service date.
- **What the user sees:** Red breach banner, 4 stats (Legal breach/Overdue/Due soon/Current), view pills, responsive table (Vehicle/Obligation/Due/Availability/Status), footer "Nothing here sends a reminder".
- **Features:** `loadFleetCompliance` partitions breaches/overdue/dueSoon/current; view toggle `?view=`. READ only; deterministic; no SMS/email. Connected: daily briefing surfaces urgent items.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Fleet overview | Header | → `/fleet` | — | Overview | LIVE |
| View pills | Nav | `?view=` | — | Filtered rows | LIVE |
| Vehicle row link | Table | → vehicle `#compliance` | — | Detail (record here) | LIVE |

### Page: Fuel & running costs — route `/fleet/fuel`
- **Status:** LIVE & WORKING. `force-dynamic` (`:9`). Explicitly NOT a finances ledger (`:16-22`).
- **Roles:** Any member; Maintenance stat masked for non-admins (`:79-81`).
- **Purpose:** Fleet-wide fuel spend, litres, consumption, per-vehicle breakdown.
- **What the user sees:** Header (Fleet overview / "Log a fill"), 4 stats, ⛽ empty state, Fleet-consumption card (mpg or "—"), By-vehicle table.
- **Features:** fuel analytics from `overview.fuel`; mpg only between two brim-full fills + odometer, else "—" (refuses fabrication); does NOT post to `/finances`. READ.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Fleet overview | Header | → `/fleet` | — | Overview | LIVE |
| **Log a fill** | Header | → `/fleet/vehicles` (register) | — | Register | LIVE but **misleading** — does NOT open a fuel form; the only fuel-entry form is on vehicle detail |
| Vehicle row link | By-vehicle table | → vehicle `#fuel` | — | Detail + form | LIVE |

### Page: Vehicle detail — route `/fleet/vehicles/[id]`
- **Status:** LIVE & WORKING. `force-dynamic` (`:41`); foreign id → `notFound()`. Telematics section: IMPLEMENTED reader over DARK data (graceful empty state).
- **Roles:** Any member views. Per-role diffs enforced at DB, not hidden in UI: "Add renewal date"/"Record done"/"Stop tracking" forms shown to everyone but `asset_service_schedules` writes are admin-only RLS — a member's write returns zero rows → "Only an owner or admin can do that" (`compliance-actions.ts:117,199`; page even says "owner/admin setting" `:578`). **UX smell: members see write forms they cannot use.**
- **Purpose:** Vehicle hub — identity, custody (from asset engine), telematics (read), compliance (read + inline record/add/stop), maintenance cases (read), fuel (read + inline log), inspections (read), details.
- **What the user sees:** Breadcrumb, title + plate + pills, Asset record + Edit buttons, banners, 4 stats, 7 SectionCards (Who has it, Location & telematics, Compliance, Maintenance & repairs, Fuel, Inspections, Details).
- **Features:**
  1. **Compliance: add renewal date** — `StateForm` → `saveComplianceSchedule` INSERT `asset_service_schedules` (`:135-149`); HQ audit; `window.location.assign` to `?saved=scheduled#compliance`. Admin-only RLS.
  2. **Compliance: record as done** — RPC `record_fleet_compliance_completion` (atomic case-complete + roll schedule forward, `:225-297`); writes `asset_maintenance_cases` + updates schedule; admin-only.
  3. **Compliance: stop tracking** — `deactivateComplianceSchedule` (count-gated admin).
  4. **Fuel: log fill** — inline `StateForm` → `createFuelLog` INSERT `asset_fuel_logs` (`fuel-actions.ts:49-130`); date+cost required; composite FK blocks cross-org; **does NOT post to finances**; HQ audit. Member-open.
  5. **Telematics (READ, DARK)** — `loadVehicleTelematics` reads `telematics_readings` (empty today); shows latest GPS fix (OSM link) + last-10 track when populated. No connect button on this page.
  6. **Custody / Maintenance / Inspections** — READ; action links push to `/assets/{id}`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Asset record / Edit | Header | → `/assets/{id}` / `/edit` | — | Asset / edit | LIVE |
| Add a renewal date | Compliance | INSERT schedule | type, next_due | `?saved=scheduled` | LIVE (admin-gated at DB) |
| Record it as done | Compliance per-row | RPC completion | completed_on, work_performed | `?saved=completed` | LIVE (admin-gated) |
| Stop tracking | Compliance per-row | deactivate | — | `?saved=schedule_stopped` | LIVE (admin-gated) |
| Log fill | Fuel | INSERT fuel log | date, cost | `?saved=fuel_logged` | LIVE (members) |
| Filled to the brim (checkbox) | Fuel | sets is_full_fill | — | Affects mpg | LIVE |
| Issue or transfer / Raise a case / Inspect | Card headers | → `/assets/{id}` | — | Asset flows | LIVE |
| View on map | Telematics | external OSM link | GPS fix | Map | LIVE when data exists (dark now) |

### Page: Add a vehicle — route `/fleet/vehicles/new`
- **Status:** LIVE & WORKING. `force-dynamic` (`:9`).
- **Roles:** Any member; RLS governs. `createVehicle` → RPC `save_fleet_vehicle` writes both `assets` + `fleet_vehicles`.
- **Purpose:** Create a vehicle (which creates the underlying asset too).
- **What the user sees:** Breadcrumb, `VehicleForm` (shared add/edit) with org-pinned suppliers + sites.
- **Features:** Only `name` required; org-integrity trigger refuses cross-org `home_site_id`; after-success `window.location.assign('/fleet/vehicles/{id}?saved=created')`; HQ audit `fleet.vehicle.created`.
- **Buttons & controls:** Add vehicle (submit) → detail; Cancel → register; ownership/fuel/class/availability/finance/home-site selects (all LIVE).

### Page: Edit vehicle — route `/fleet/vehicles/[id]/edit`
- **Status:** LIVE & WORKING. `force-dynamic` (`:15`); foreign → `notFound()`.
- **Roles:** Any member opens; `updateVehicle`/`removeVehicleProfile` org-pinned; delete count-gated → member refusal "Only an owner or admin can do that".
- **Purpose:** Edit all fields incl. **operational status (off-road/workshop — set ONLY here)**; remove fleet profile without destroying the asset.
- **What the user sees:** Prefilled `VehicleForm` + "Remove from the fleet" section.
- **Features:** update RPC `save_fleet_vehicle` (`p_asset_id=id`), `asset_disposed` guard refuses in-service on disposed asset; remove profile DELETEs `fleet_vehicles` only (asset + history retained). HQ audits.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | Form | UPDATE vehicle+asset | name | `?saved=updated` | LIVE |
| Availability select | Form | sets operational_status | — | Persisted | LIVE |
| Remove vehicle profile | Danger section | DELETE `fleet_vehicles` | — | `?saved=removed` | LIVE (admin-gated at DB) |
| "the asset record" link | Danger section | → `/assets/{id}` | — | Asset page | LIVE |

---

## Stock — route group `/stock` (inventory / warehouse / stocktake / vans / replenishment / valuation)

Common: every stock write runs through a `SECURITY INVOKER` RPC (never a client insert) under live RLS. Banned `revalidatePath+useActionState` hang pattern **absent everywhere** — all success paths use `FormState.redirectTo` → `window.location.assign` (documented `actions.ts:124-150`; verified `_move-forms.tsx:116-120`, `_form.tsx:70-72`, `_open-form.tsx:26-29`, `_count-panel.tsx:77-79`, `_replenishment-form.tsx:49-51`, `_van-forms.tsx:27-31`). Write-path guard details in the sub-summary.

### Page: Stock overview — route `/stock`
- **Status:** LIVE & WORKING (`page.tsx`, `force-dynamic` `:12`).
- **Roles:** All roles read identical tiles; linked sub-surfaces self-gate (replenishment admin-only).
- **Purpose:** Operational command centre — what you hold, where, what moved.
- **What the user sees:** Header (6 nav buttons), saved banner, `AccountingNote`, empty-state teaching card, else 4 tiles (Items tracked / Out of stock / Low / Places holding), attention list, per-location holdings, recent 12 movements.
- **Features (read-only):** attention worklist (`active && (out||low)`); per-location holdings fold; recent movements (newest 12). No writes.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Stocktake / Replenishment / Valuation / Van stock / All items | Header | Navigate | — | Sub-route | LIVE |
| + Add item | Header | → `/stock/items/new` | — | Form | LIVE |
| Review & re-order | Attention card | → `/stock/replenishment` | — | Admin-gated page | LIVE |
| Item / location / movement links | Lists | Navigate | — | Detail | LIVE |

### Page: Stock items list — route `/stock/items`
- **Status:** LIVE & WORKING.
- **Roles:** All roles read.
- **Purpose:** Catalogue register. Org-pinned; TS pagination PAGE_SIZE 25; bound `STOCK_ITEM_LIMIT=1000`.
- **What the user sees:** Header, `AccountingNote`, In-use/Retired tabs (when any retired), mobile cards / desktop 5-col table, Prev/Next pager.
- **Features:** retired filter `?show=retired`; pagination slice + summary. READ.
- **Buttons & controls:** Overview; + Add item; In use/Retired tabs; Previous/Next; item name link (all LIVE).

### Page: Add item — route `/stock/items/new` (+ `_form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** `createStockItem` has **no admin gate** (`actions.ts:154-195`) — any member.
- **Purpose:** Add a catalogue item (one shared form for add+edit).
- **What the user sees:** name (req), unit (req datalist), SKU, barcode, reorder_level, target_level, reorder_quantity, preferred_supplier (F-1 preserved-option), supplier_reference, description, notes. **No price/cost field** by design.
- **Features:** CREATE `stock_items` (`itemColumns` + `created_by`); audit `stock_item.created`; redirect to detail. `active` deliberately not a field.
- **Buttons & controls:** Add item (submit) → detail; Cancel → list (LIVE).

### Page: Item detail — route `/stock/items/[id]` (+ `_move-forms.tsx`)
- **Status:** LIVE & WORKING. Four-segments-deep route — hard-nav guard correctly applied.
- **Roles:** Read: all. Issue + Transfer + Correct: member-level. **Count (adjust)** tab: admin-only — `canAdjust={isAdmin}` hides the tab (`page.tsx:95,206`; `_move-forms.tsx:63,108`); DB `record_stock_adjustment` is the real gate. Retire/reinstate: member-level (RLS).
- **Purpose:** One item — derived balances, per-site holdings, append-only history, move panel, retire.
- **What the user sees:** 3 tiles (On hand / Reorder at / Target), `AccountingNote`, tabbed `MoveStockPanel` (Issue/Move/Count), "Where it is", "History" (reversed badges + per-row Reverse), Retire/Put-back card.
- **Features:**
  1. **Issue out** — live arithmetic blocks negative pre-submit; RPC `record_stock_issue`; DB advisory lock + balance-floor refusal; CREATE `stock_movements` (issue); optional `job_id` provenance; **posts no finances**; audit; `?saved=issued`.
  2. **Move (transfer)** — RPC `record_stock_transfer`; writes conserving `transfer_out`+`transfer_in` sharing `transfer_group_id`; needs 2 distinct sites; audit.
  3. **Count (adjust)** — admin-only; RPC `record_stock_adjustment` (DB `is_org_admin` 42501 gate + reason required + delta≠0 + downward floor).
  4. **Reverse movement (Correct)** — member-level; RPC `record_stock_correction`; DB refuses correcting a transfer leg (points to compensating transfer), correction-of-correction, double-correction; best-effort `reconcileFulfilmentForMovement` seam.
  5. **Retire / reinstate** — `setStockItemActive` count-gated; no hard delete.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Edit | Header | → `/edit` | — | Edit form | LIVE |
| Issue | Issue tab | `issueStock` | site, qty>0, [job] | Movement | LIVE |
| Move stock | Move tab | `transferStock` | from≠to, qty≤balance | 2-leg transfer | LIVE |
| Record the count | Count tab | `adjustStock` | site, counted, reason | Adjustment | LIVE (admin) |
| Reverse this | History row | `correctStockMovement` | reason | Reversing row | LIVE |
| Retire item / Put back in use | Retire card | `setStockItemActive` | — | Toggle active | LIVE |

### Page: Edit item — route `/stock/items/[id]/edit`
- **Status:** LIVE & WORKING.
- **Roles:** Member-level (`updateStockItem` count-gated, no admin check); foreign-org 404s.
- **Purpose:** Edit catalogue fields (not quantities).
- **Features:** UPDATE `stock_items`; count===0 → "not in this organisation"; audit; success banner (no redirect).
- **Buttons & controls:** Save changes; Cancel/back (LIVE).

### Page: Location detail — route `/stock/locations/[id]`
- **Status:** LIVE & WORKING. READ-ONLY. Also serves as the van detail page.
- **Roles:** All read; foreign-org site 404s.
- **Purpose:** Site-shaped view of the same ledger (jobs are never locations).
- **What the user sees:** Header + Site details link, `AccountingNote`, "What is here", "What has moved through" (recent 60).
- **Features:** READ fold; negative balances red. No writes.
- **Buttons & controls:** ← Stock; Site details → `/sites/[id]`; item links (LIVE).

### Page: Replenishment — route `/stock/replenishment` (+ `_replenishment-form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** **Owner/admin only** — whole surface AND action gated (`page.tsx:39,59-75`; `reorder-actions.ts:104-107`). Staff see an "ask an owner/admin" card, not a 404.
- **Purpose:** Below-reorder worklist → raise a DRAFT material request. Quantities re-derived server-side (client ids untrusted); **no order/no cost sent**.
- **What the user sees:** "Nothing to re-order" card or pickable checklist (all ticked) with select-all + "+qty" + basis label.
- **Features:** parse+dedupe uuid ids; re-derive suggestions; CREATE via shared material-request core (writes `material_requests`+lines as draft); redirect `/materials/requests/{id}?saved=1`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Select all / Deselect all | Header row | toggle set | — | Selection | LIVE |
| Per-item checkbox | Rows | toggle | — | Selection | LIVE |
| Create material request | Footer | `createReplenishmentRequest` | ≥1 item | Draft MR, redirect | LIVE (admin) |

### Page: Stocktake list — route `/stock/stocktake`
- **Status:** LIVE & WORKING.
- **Roles:** All roles read/list. F-1 paged, loud.
- **Purpose:** Every count newest-first with status pill.
- **Buttons & controls:** + New stocktake; ← Stock; session link (LIVE).

### Page: New stocktake — route `/stock/stocktake/new` (+ `_open-form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Member-level (`openStocktakeSession` no admin gate). Needs ≥1 site.
- **Purpose:** Pick a site, open session — DB snapshots every item's expected qty into frozen lines.
- **Features:** RPC `open_stocktake_session` inserts session + snapshot `stocktake_lines` (`expected_qty` frozen forever); audit; redirect to detail.
- **Buttons & controls:** Freeze & start; Cancel (LIVE).

### Page: Stocktake detail — route `/stock/stocktake/[id]` (+ `_count-panel.tsx`, `_variance-lines.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Read: all. Start counting + Record count: member. **Post variances: admin-only** — button only if `isAdmin` (`page.tsx:168-183`); action re-checks + DB `post_stocktake_session` `is_org_admin` 42501 gate. Cancel: member.
- **Purpose:** Lifecycle open→counting→posted/cancelled; summary tiles; scan/pick count panel; variance sheet.
- **What the user sees:** Status pill, tiles (Items/Counted/Not counted/Variances net), lifecycle cards, `VarianceLines` table. **No value column** ("D1 undecided" `:9-11`).
- **Features:**
  1. **Start counting** — `start_stocktake_counting` (open→counting only).
  2. **Record count (scan/pick)** — native `BarcodeDetector` → `resolveScannedItem` server lookup (org-pinned, value untrusted); iOS Safari fallback to `<select>`; RPC `record_stocktake_count` (DB refuses item not in snapshot, enforces status=counting + non-negative).
  3. **Post variances** — admin-only; `post_stocktake_session` posts each variance THROUGH `record_stock_adjustment` (inherits admin gate/floor/lock/write-path marker); disabled when counted===0.
  4. **Cancel** — optional reason.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Start counting | Open card | `startStocktakeCounting` | session_id | status→counting | LIVE |
| Scan a barcode / Stop camera | Count panel | `BarcodeDetector` | camera perm | item selected | LIVE (Chrome/Android; iOS Safari unsupported msg) |
| Save count | Count panel | `recordStocktakeCount` | item, counted | Line updated | LIVE |
| Post N variances to stock | Counting card | `postStocktakeSession` | session_id | Adjustments posted | LIVE (admin) |
| Cancel stocktake | Open/counting | `cancelStocktakeSession` | session_id | status→cancelled | LIVE |

### Page: Valuation — route `/stock/valuation`
- **Status:** LIVE & WORKING, READ-ONLY, but **doctrine inconsistency** (see summary).
- **Roles:** All roles read.
- **Purpose:** **Weighted-average cost** valuation (qty × wavg from posted-GRN delivery prices). The ONLY stock surface rendering money.
- **What the user sees:** Narrative, 3 tiles (Total stock value / Items in stock / Items with unpriced stock), valuation-by-item table, unpriced footnote.
- **Features:** READ fold; uncosted qty shown amber + excluded so totals never inflated. No writes.
- **Buttons & controls:** Stock breadcrumb (LIVE).

### Page: Van stock — route `/stock/vans` (+ `_van-forms.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Read: all. Load/Return: member-level (`moveVanStock`). **Enable van: admin-only** — `canEnable` hides card (`page.tsx:48,152`); DB `sites_insert`=`is_org_admin`.
- **Purpose:** A van is a `sites` row `kind='vehicle'`; reuses the SAME ledger + `/stock/locations/[id]` detail.
- **What the user sees:** Header, `AccountingNote`, empty state, "Vans holding stock" list, "Move stock" tabbed panel (Load/Return), "Set a van up for stock" card (admin).
- **Features:** enable → RPC `ensure_vehicle_stock_location` (writes only a `sites` row); load/return → `record_stock_transfer` (inherits lock/floor/conservation/write-path marker). Audits.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Set up for stock | Enable card | `enableVanStock` | vehicle, [name] | sites row, redirect | LIVE (admin) |
| Load onto van / Return to depot | Move panel | `issueToVan`/`returnFromVan` | van, depot, item, qty>0 | Transfer | LIVE |
| Van links / ← Stock | Lists/header | Navigate | — | Location / `/stock` | LIVE |

---

## Materials — route group `/materials/requests`

### Page: Material requests queue — route `/materials/requests`
- **Status:** LIVE & WORKING. `force-dynamic` (`page.tsx:34`); active-org pinned inside `loadMaterialRequestQueue` (`:181`).
- **Roles:** Any member (`requireOrgContext()`, `:171`); nav-gated to admins. Filters: a "Mine" filter uses `user.id`. No per-role field diff on the list.
- **Purpose:** The office queue — "what has site asked for, and where each request has got to". Defaults to OPEN set (submitted/approved/part-fulfilled).
- **What the user sees:** Header + "+ New request"; blue "N waiting for a decision" status strip; filter pills (Open / Awaiting approval / Being sourced / All / Overdue / Mine / one-job); request cards (number, status pill, urgent pill, "Past needed-by" pill, job link or "Yard/van stock", Asked by / Needed / Lines / Outstanding); empty state.
- **Features:**
  1. **Filtered queue.** Status set parsed from `?status=` (`parseStatuses` `:43-50`); `?job`, `?requester=me`, `?overdue=1` filters; `overdue` computed by the service (`lib/material-requests/fulfilment`) so badge and filter can't disagree. CRUD: READ `material_requests` (+ lines/job/requester). Side-effects: none. Filters are plain searchParam links (shareable, survives refresh).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New request / Raise a request | Header / empty | → `/materials/requests/new` | — | New form | LIVE |
| Filter pills (6 + one-job ✕) | Filter nav | searchParam filter | — | Filtered list | LIVE |
| Request number link | Card | → `/materials/requests/[id]` | — | Detail | LIVE |
| Job link | Card | → `/jobs/[id]` | — | Job | LIVE |

### Page: New material request — route `/materials/requests/new` (+ `_request-form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Any member (`:42`). Reached from job Materials panel (`?job=` fixes the job) or office queue (yard/van, job nullable).
- **Purpose:** Raise a materials request; office approves or comes back.
- **What the user sees:** Breadcrumb, optional job picker `<details>` (server-rendered `<select>`, slices 12), `MaterialRequestForm` with line items, priority, needed-by.
- **Features:**
  1. **Create (draft) + optional submit.** Job picker paged with `fetchAllRows` (F-1), org-pinned, loud (`:60-72`). `intent=submit` creates and submits in one action. Create delegated to `createMaterialRequestDraftRecord` (the SAME core the **offline write queue** replays through — `material_request.create` is offline-writable, `lib/offline/registry.ts`); identity handed to the form is the SERVER-resolved one (never a client marker on a shared tablet). CRUD: CREATE `material_requests` + `material_request_lines` (born draft per `20261066`). **Side-effects on submit:** `emitNotifications` fan-out to admins (`material_request.submitted`, in-app) + `notifyAdminsOfMaterialRequest` (email, never throws) (`actions.ts:195-219`). After-success: redirect `/materials/requests/{id}?saved=1`. Connected: stock replenishment feeds drafts here; job Materials panel. Banned pattern avoided (redirectTo, no revalidatePath — file header `:52-63`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send request / Save draft (intent) | Form | `createMaterialRequest` | ≥1 line | Draft (+submit) → detail | LIVE |
| Which job is this for? | Picker `<details>` | sets `?job=` | — | Pins job | LIVE |
| Add/remove line | Form | client row add/remove | description/qty | Updates lines | LIVE |
| Cancel / ← Back | Form | → job or queue | — | Navigates | LIVE |

### Page: Material request detail — route `/materials/requests/[id]`
- **Status:** LIVE & WORKING.
- **Roles:** Any member reads + can submit/cancel own. **Approve/Reject (`decideMaterialRequest`): owner/admin only** (`actions.ts:396`). **Raise PO (`createPoDraftFromRequest`): owner/admin only** (`:553`). Issue-from-stock (`fulfilRequestLineFromStock`): member-level. Buttons derived from `materialRequestActions(status,{isAdmin,isOwnRequest})` (`page.tsx:70`) so the UI never shows a button the DB would refuse.
- **Purpose:** Operate one request — lifecycle, per-line fulfilment from stock, convert to PO.
- **What the user sees:** Header + status, raised/decided provenance, rejection reason, per-line table with "Issue from stock" forms (when approved & stock available), action bar (Send request / Approve / Reject / Raise a purchase order / Cancel).
- **Features:**
  1. **Submit** (`submitMaterialRequest`) — draft→submitted, server-pinned provenance + admin notification fan-out. Not offline-writable.
  2. **Decide** (`decideMaterialRequest`) — admin-only; `approved`/`rejected` (+ reason); **side-effects:** `notifyRequester` in-app + email `material_request.{approved|rejected}` (`:222-257,457`).
  3. **Cancel** (`cancelMaterialRequest`) — stands the request down (confirm dialog).
  4. **Raise PO from request** (`createPoDraftFromRequest`) — admin-only; creates a **draft** PO (never 'sent', `:603`) inheriting lines; redirect to `/purchase-orders/{id}?saved=1`.
  5. **Issue line from stock** (`fulfilRequestLineFromStock`) — member; routes through `issueStockToRequestLine` → the single blessed stock-issue RPC; the two DERIVED statuses (`partially_fulfilled`/`fulfilled`) are applied ONLY by `advance_material_request_fulfilment` (`20261067`), never by this file (DB trigger refuses any other path, `:34-37`).
  - Banned pattern avoided throughout (every action `formSuccess({redirectTo})`, no revalidatePath).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send request | Action bar (draft, own) | `submitMaterialRequest` | — | →submitted, notify admins | LIVE |
| Approve | Action bar (submitted) | `decideMaterialRequest` approved | — | notify requester (in-app+email) | LIVE (admin) |
| Reject | Action bar (submitted) | `decideMaterialRequest` rejected | reason | notify requester | LIVE (admin) |
| Raise a purchase order | Action bar (approved) | `createPoDraftFromRequest` | — | Draft PO → PO detail | LIVE (admin) |
| Issue from stock | Per line (approved) | `fulfilRequestLineFromStock` | qty | Stock issue + fulfilment advance | LIVE |
| Cancel this request | Action bar | `cancelMaterialRequest` (confirm) | — | →cancelled | LIVE |

---

## Sites — route group `/sites` (depots / yards / own locations)

Note: NOT customer job sites (job addresses live on the job). Create/edit/retire/delete are admin-only (shown via `isAdmin` gate + enforced by RLS count-gating + active-org pin). `setSiteActive`/`deleteSite` are plain void form actions using `redirect`+`revalidatePath` (depth-2 route — not the banned deep-swap case); `createSite`/`updateSite` use `StateForm` + `formSuccess`.

### Page: Sites register — route `/sites`
- **Status:** LIVE & WORKING. `force-dynamic` (`:15`); org-pinned `listSitesForOrg` (`:46`).
- **Roles:** All members read; "+ Add site" shown to admin only (`:67`).
- **Purpose:** Register of the company's own locations (depots/yards/warehouses/offices/containers/lock-ups).
- **What the user sees:** Header + conditional Add site; saved banner; 🏚️ empty state + "What naming a site unlocks" teaching card; else In-use and Retired tables (Name/Kind/Where/In use by counts).
- **Features:** parallel read of sites + `loadSiteUsageForOrg` (vehicle/custody counts per site); sorted `compareSites`; active/retired split. READ.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Add site (admin) | Header / empty | → `/sites/new` | — | New form | LIVE (admin-only visible) |
| See the fleet | Empty secondary | → `/fleet/vehicles` | — | Fleet | LIVE |
| Site name link | Rows | → `/sites/[id]` | — | Detail | LIVE |

### Page: Add site — route `/sites/new` (+ `_form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** **Admin only** — non-admins redirected to `/sites` (`new/page.tsx:16-17`). `createSite` relies on RLS `sites_insert` (admin-gated).
- **Purpose:** Create a named site.
- **What the user sees:** `SiteForm` (name, kind, address, postcode, gate code, hours, notes).
- **Features:** CREATE `sites` (org_id + `created_by`); `recordAdminActivity("site.created")`; `revalidatePath("/sites")` + redirect to list; `friendlySiteError` on failure.
- **Buttons & controls:** Save site → list; Cancel → `/sites` (LIVE).

### Page: Site detail — route `/sites/[id]`
- **Status:** LIVE & WORKING. Foreign-org site → `notFound()` (`:57`).
- **Roles:** All members read; **edit form, deactivate/reactivate, delete shown to admin only** (`isAdmin` `:61`, gates at `:131,160,170,199`). Actions enforce via RLS count-gating + active-org pin (member write → "That site isn't in this organisation any more" / `forbidden` / `delete_denied`).
- **Purpose:** Edit one site; retire (ordinary) or delete (only when unreferenced).
- **What the user sees:** Details + usage summary (N vehicles / N custody records); admin edit `StateForm`; admin deactivate/reactivate form; admin delete form (disabled with "Not available: N vehicles…" when referenced).
- **Features:**
  1. **Update site** (`updateSite.bind(null,id)`) — UPDATE `sites` count-gated + active-org pin (`actions.ts:138-192`); audit `site.updated`.
  2. **Deactivate/reactivate** (`setSiteActive`) — retire drops it from pickers but keeps every historic link; count → `forbidden` if not admin; audit; redirect `?saved=reactivated|deactivated`.
  3. **Delete** (`deleteSite`) — DELETE count-gated; FK `in_use` blocks a referenced site; `delete_denied` if not admin; redirect `/sites?saved=deleted`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes (admin) | Edit form | `updateSite` | name, kind | `successMessage` | LIVE (admin) |
| Deactivate / Reactivate (admin) | Toggle form | `setSiteActive` | hidden active flag | `?saved=…` | LIVE (admin) |
| Delete site (admin) | Danger form | `deleteSite` | — | deleted / `in_use` refusal | LIVE (admin; blocked if referenced) |

---

## Suppliers — route group `/suppliers`

FEATURE_MERCHANTS: **no supplier surface references it** (only PO detail does). ADMIN sub-gates on CIS + payments.

### Page: Suppliers list — route `/suppliers`
- **Status:** LIVE & WORKING.
- **Roles:** Any member reads (`page.tsx:46`); no per-role diff.
- **Purpose:** Address book of "people and companies you pay," feeding expenses/costs.
- **What the user sees:** Header (+ Add supplier; Compare performance when rows>0); `DataTable` (name/category/email/phone) or `EmptyState`.
- **Features:** `listSuppliersForOrg` org-pinned, ordered newest, capped `SUPPLIER_LIST_LIMIT` (hard cap, not F-1 — very large rosters truncate silently). READ.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Add supplier | Header / empty | → `/suppliers/new` | — | New form | LIVE |
| Compare performance | Header (rows>0) | → `/suppliers/compare` | — | Comparison | LIVE |
| Row / name link | Rows | → `/suppliers/[id]` | — | Detail/edit | LIVE |
| DataTable sort/filter | Table | client sort + filter | — | Reorders rows | LIVE |

### Page: New supplier — route `/suppliers/new` (+ `_form.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Any member (RLS `suppliers_insert` governs the write).
- **Purpose:** Create a supplier.
- **Features:** `createSupplier` (`actions.ts:27-82`) → CREATE `suppliers`; `payment_terms_days` blank → NULL (read applies disclosed 30-day default); audit `supplier.created`; `revalidatePath` + redirect to list.
- **Buttons & controls:** Save supplier → list; Cancel → `/suppliers` (LIVE).

### Page: Supplier detail / edit — route `/suppliers/[id]`
- **Status:** LIVE & WORKING.
- **Roles:** Member sees edit form, performance counts, bills (no settlement pills), attachments, delete form. **Admin additionally** sees CIS panel (`:161-191`), money-out ledger tiles (`:193-229`), bill settlement pills — gated on role (non-admin RLS empties payment reads silently).
- **Purpose:** Edit a supplier + hub to CIS/payments/performance; show money position + bills.
- **Features:**
  1. **Load** — `loadSupplierForOrg` + `notFound()` (foreign-org = missing).
  2. **Composed money + measured reads** via `Promise.all` (`getSupplierLedger` + `getSupplierPerformance`).
  3. **Update** (`updateSupplier.bind(null,id)`) — UPDATE active-org pinned + `count:"exact"`; count===0 → "isn't in this organisation any more." (No audit on update — note: create audits, update doesn't.)
  4. **Delete** (`deleteSupplier`) — active-org pinned DELETE; FK from `supplier_payments` blocks a paid supplier → `delete_failed`; count===0 → `delete_denied`. **Delete button rendered unconditionally** (`:333-349`), not `isAdmin`-gated — a non-admin sees it and gets an RLS refusal on submit (cosmetic).
  5. **Attachments** — `targetTable="suppliers"`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | Edit form | `updateSupplier` | name | Updates row | LIVE |
| Set up / Manage CIS | CIS card (admin) | → `/suppliers/[id]/cis` | — | CIS page | LIVE (admin-only) |
| Record payment | Money-out (admin) | → `/suppliers/[id]/payments` | — | Payments | LIVE (admin-only) |
| Full record | Performance card | → `/suppliers/[id]/performance` | — | Performance | LIVE |
| Delete supplier | Red block (all roles) | `deleteSupplier` | — | Deletes or refuses (FK/role) | LIVE (non-admin refused by RLS; button not hidden) |
| Attachments | Panel | upload to `suppliers` | file | Stored | LIVE |

### Page: Supplier CIS — route `/suppliers/[id]/cis` (+ `_forms.tsx`, `actions.ts`)
- **Status:** LIVE & WORKING (manual verification path); **HMRC-online path FLAGGED OFF** (`isHmrcConnectable()` false in prod, `:141,255-270`).
- **Roles:** **Admin only** — non-admin gets a refusal card; every action re-checks `isManager` (`actions.ts:46,69,102,148,192`); admin-only RLS on `cis_subcontractors`.
- **Purpose:** Manage a subcontractor's CIS identity + HMRC verification state (deduction-rate authority).
- **What the user sees:** Status summary, "On record" identifiers (**masked UTR, no reveal control** `:213-228`), verification recorder, re-verify flag, identity form.
- **Features:**
  1. **Save CIS profile** (`saveCisProfile`) — upsert `cis_subcontractors`; UTR **write-only** (blank keeps stored); audit stores only `has_utr`.
  2. **Record manual verification** (`saveCisVerification`) — deduction rate **derived from HMRC outcome, not an input**.
  3. **HMRC online verify (DARK)** (`verifyCisWithHmrc`) — belt-and-braces `isHmrcConnectable()` refuse before any read/network; button only renders when connectable (never in prod).
  4. **Flag for re-verification** (`requestCisReverification`) — clears deduction rate until HMRC reconfirms.
  - Side-effects: admin-activity audit on all four; no email/SMS/payment; HMRC network only when connectable.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save CIS details | Identity form | `saveCisProfile` | legal_name | Upserts profile | LIVE (admin) |
| Record verification | Verification form | `saveCisVerification` | result, date (needs stored UTR) | Sets status + derived rate | LIVE (admin) |
| Verify with HMRC | HMRC panel | `verifyCisWithHmrc` | — | Honest "not connected" refusal | FLAGGED OFF (`isHmrcConnectable`) |
| Flag for re-verification | Amber block | `requestCisReverification` | reason (opt) | Clears rate | LIVE (admin) |

### Page: Supplier payments — route `/suppliers/[id]/payments` (+ `_forms.tsx`, `actions.ts`)
- **Status:** LIVE & WORKING (H2-CIS M2/M3).
- **Roles:** **Admin only** — non-admin refusal card; actions re-check `isManager`; `is_org_admin` inside `record_supplier_payment` RPC is the real gate.
- **Purpose:** Money-OUT ledger — record/void supplier payments, with a CIS deduction engine for verified subcontractors.
- **What the user sees:** Position tiles (Billed/Paid/Outstanding/CIS withheld/Net cash/Job cost-ex-VAT), amber "CIS is HMRC's, not a saving" banner, CIS engine (labour-split + worked CIS payment) for verified subs else plain M2 form, Bills list, Payment history with frozen CIS snapshots + void.
- **Features:**
  1. **Record plain payment** (`recordPayment`) — CREATE `supplier_payments` + allocations; fail-closed 10s dedupe; audit. **Writes nothing to `finances`** (`:28-31`) — recording cash cannot change job cost/margin.
  2. **Save bill CIS basis (M3)** (`saveBillDetails`) — `cis_bill_details` (labour/materials/CITB/VAT split); locked once a live CIS allocation names the bill.
  3. **Record CIS payment (M3)** (`recordCisPaymentAction`) → `record_cis_supplier_payment` RPC — rate/basis/deduction **derived server-side, never typed**; `expected_rate` is a check-only assertion refusing a rate changed between render and submit; fail-closed dedupe; `resolveCisRate` refuses a lapsed/pre-outcome verification (re-verify link, no guessing 20/30%).
  4. **Void payment** (`voidPayment`) — UPDATE (void, keeps row); mandatory reason.
  - Side-effects: audit on all; no finances write; no email/SMS; deductions feed downstream HMRC-return generators (M4/M5). `useActionState`+`revalidatePath` but returns success WITHOUT navigation → sidesteps the banned deep-swap hang.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Record payment | M2 form | `recordPayment` | gross, date | Payment + allocations | LIVE (admin) |
| Save CIS details (per bill) | M3 split form | `saveBillDetails` | materials/CITB/VAT | Freezes basis | LIVE (admin) |
| Record CIS payment | M3 form | `recordCisPaymentAction` | date, allocations (rate derived) | CIS payment, deduction locked | LIVE (admin, verified subs only) |
| Void | History row | `voidPayment` | reason | Voids, keeps record | LIVE (admin) |

### Page: Supplier performance — route `/suppliers/[id]/performance`
- **Status:** LIVE & WORKING. `force-dynamic`. **READ-ONLY** (no form/mutation).
- **Roles:** Any member sees delivery/price/evidence/"not measured"; **admin additionally** sees Settlement section + CIS standing card (role-gated, `:203`).
- **Purpose:** One supplier's MEASURED record — counts only, "no score, no grade, no forecast".
- **Features:** `getSupplierPerformance` + `loadSupplierForOrg` org-pinned (stops blending across an owner's two companies); reads `purchase_orders`/`goods_received_notes`/`finances`/`supplier_payments`; honest empty state ("not a clean record — an empty one").
- **Buttons & controls:** Compare suppliers; Manage CIS (admin); View orders/bills; Raise a purchase order; evidence row → PO (all LIVE).

### Page: Compare suppliers — route `/suppliers/compare`
- **Status:** LIVE & WORKING. `force-dynamic`.
- **Roles:** Any member (settlement shows counts only — safe for members).
- **Purpose:** Side-by-side buying decision; deliberately NO "best supplier" ranking — sort by one named column.
- **Features:** `listSuppliersForOrg` + `listSupplierPerformance` org-pinned, capped `COMPARISON_SUPPLIER_LIMIT`; empty records sort LAST, unrated ratios sort UNKNOWN (∞), never 0; URL-driven `?sort=`. READ. Intelligence rollup `lib/intelligence/supplier-performance.ts` composes over-billing (≥20%) and slow-settlement (≥25%) heuristic flags — consumed by HQ/dashboard, **no dedicated suppliers-domain UI**.
- **Buttons & controls:** Sort-by chips (5); supplier name → performance; Add a supplier (all LIVE).

---

## Purchase orders — route group `/purchase-orders` (PO / GRN / 3-way match)

FEATURE_MERCHANTS gates ONLY the PO detail electronic-submit affordance (dark in every env; two-switch invariant `lib/integrations/merchants/connect.ts:79-118`).

### Page: PO register — route `/purchase-orders`
- **Status:** LIVE & WORKING.
- **Roles:** Any member; no per-role diff on the list.
- **Purpose:** Register of committed spend showing where each order is up to.
- **What the user sees:** Header (Bill matching, + New PO), desktop table + mobile cards, status pills, delivery badge, empty state.
- **Features:** F-1 paged via `fetchAllRows` (fixes a prior `.limit(500)` drop), active-org pinned, loud; receipt badges via one chunked `countPostedReceipts`. READ.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Bill matching | Header | → `/purchase-orders/matching` | — | 3-way queue (no count badge by design) | LIVE |
| + New PO | Header | → `/purchase-orders/new` | — | Builder | LIVE |
| Row → order | Table/card | → `/purchase-orders/[id]` | — | Detail | LIVE |

### Page: New PO — route `/purchase-orders/new` (+ `_builder.tsx`)
- **Status:** LIVE & WORKING.
- **Roles:** Any member reaches it; **command-palette "new-po" is `roles: ADMIN`** (`commands.ts:57`) — palette hides it from staff, but the page/action allow any member (mismatch).
- **Purpose:** Raise a PO against a supplier (+ optional job) with VAT-rated line items.
- **What the user sees:** Supplier/job selects, reference, expected date, dynamic line rows with live GBP totals, notes, subtotal/VAT/total.
- **Features:** org-pinned F-1 options; `createPurchaseOrder` — `next_po_number` RPC, inserts `purchase_orders` (draft) + line items (**two-step, not atomic** — a line-insert failure after the header leaves a header with no lines but returns error); audit; revalidate. Picker-null defence `withPreservedOption`. On depth-2 `/new` uses `router.push` (not the banned deep route).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Supplier / Job selects | Form | sets ids (optional) | — | — | LIVE |
| + Add line / ✕ remove | Line items | client add/remove | — | Recomputes totals | LIVE |
| VAT rate select | Each line | `PO_VAT_RATES` | — | Updates line total | LIVE |
| Create purchase order | Submit | `createPurchaseOrder` | ≥1 described line | Inserts PO+lines → detail | LIVE |

### Page: PO detail — route `/purchase-orders/[id]` (+ `_bill-form`, `_receive-form`, `_receive-into-stock`, `_void-form`)
- **Status:** LIVE & WORKING. Merchant-submit FLAGGED OFF.
- **Roles:** Any member reads, receives deliveries, records bills, sets status, receives-into-stock. **Admin only:** Delete (shown only when `isAdmin && !hasAnyReceipt`, `:658`). Merchant submit shown only when merchants connected (never in prod).
- **Purpose:** Operate one order end-to-end: status, deliveries (GRN), receive-into-stock, supplier bills, edit, delete, electronic merchant submission.
- **What the user sees:** Breadcrumb, status pill, banners, status-transition buttons, (dark) merchant submit form, Deliveries section (position + Receive form + GRN list with attachments/void/into-stock), line-item summary, Supplier-bills section (Committed/Billed/Remaining + RecordBillForm), editable builder (draft/sent + no receipts), Delete (admin, no receipts).
- **Features:**
  1. **Load PO** — active-org pinned + `maybeSingle`; comment warns an unpinned read would let a dual-org member WRITE against the other company's order.
  2. **Status transitions** (`setPurchaseOrderStatus`) — `canTransitionPo` guard; once a delivery is posted only `cancelled` is a manual move (DB trigger owns derived status); plain `<form>` redirect-based.
  3. **Receive GRN** (`receiveDelivery` → `post_goods_received_note` RPC, SECURITY INVOKER, atomic, advisory lock, over-receipt refused) — client preview blocks over-receipt; **hard-nav `window.location.assign`** (`_receive-form.tsx:42-48`). CRUD: `goods_received_notes`/lines CREATE + PO status UPDATE. **No finances write.**
  4. **Receive into stock** (`receiveIntoStock`, imported from `../../stock/actions`) — human picks stock item; qty comes from the GRN line inside the RPC; idempotent (partial unique index); **DEPOT-ONLY** — hidden for job-tagged POs (`page.tsx:463-467`, prevents double-count, mig `20261212`). Stock movement CREATE (quantity only, no finances).
  5. **Void delivery** (`voidDelivery` → `void_goods_received_note` RPC) — mandatory reason; walks status back in the same txn.
  6. **Record supplier bill** (`recordSupplierBill`) — **the single `finances` posting side-effect of the PO domain**: inserts `finances` inheriting PO job+supplier, active-org pinned + independent job re-check, fail-closed 10s dedupe; revalidates PO+job+`/finances`. **Available to any member (no admin gate).**
  7. **Edit PO** (`updatePurchaseOrder`) — only draft/sent AND no receipts; line delete+reinsert refused once a GRN exists (DB composite FK).
  8. **Delete PO** (`deletePurchaseOrder`) — admin (RLS) + active-org pin + count; refused if any receipt exists.
  9. **Merchant submit (DARK)** (`submitPurchaseOrderToMerchantAction`) — form shown only for connected merchants; dark-cheap (no query while flag off); refuses `skipped_dark`/`not_connected` before any network/ledger write.
  - Side-effects: audit on every mutation; finances write only on bill; stock movement on into-stock; no email/SMS/AI; merchant network only when activated.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Mark sent/received/cancelled | Status row | `setPurchaseOrderStatus` | status | Transitions (guarded) | LIVE |
| Send to merchant | Merchant form | `submitPurchaseOrderToMerchantAction` | provider | Dark refusal in prod | FLAGGED OFF (FEATURE_MERCHANTS) |
| Receive delivery | Deliveries | `receiveDelivery` | qty per line | GRN posted, hard-nav | LIVE |
| All arrived / All N | Receive form | client fill helpers | — | Fills quantities | LIVE |
| Put into stock | Posted GRN line (non-job PO) | `receiveIntoStock` | stock item + site | Stock movement (qty only) | LIVE (depot-only; hidden for job POs) |
| Void this delivery | Posted GRN | `voidDelivery` | reason | Voids, status walks back | LIVE |
| Record bill | Supplier bills | `recordSupplierBill` | amount, VAT | Posts to `finances` | LIVE (any member) |
| Save changes (edit) | Builder | `updatePurchaseOrder` | lines | Updates (draft/sent, no receipts) | LIVE |
| Delete purchase order | Bottom | `deletePurchaseOrder` (confirm) | confirm | Deletes or refuses | LIVE (admin + no receipts) |
| Attachments (GRN photo) | Each posted GRN | upload, frozen | file | Evidence stored, no removal | LIVE |

### Page: Bill matching / 3-way match — route `/purchase-orders/matching`
- **Status:** LIVE & WORKING. `force-dynamic`. **READ-ONLY** (no form/action/write).
- **Roles:** Any member.
- **Purpose:** The 3-way match queue — PO (ordered) vs GRN (delivered) vs bill (invoiced) — surfacing discrepancies for a human to chase. No posting/credit/adjustment.
- **What the user sees:** 3 tiles (Over-billed / Billed-not-received / Received-not-billed — **never summed**), a "£X invoiced that orders don't justify" sentence (`moneyOutAtRisk`, the only double-count-free figure), per-order discrepancy cards (Ordered/Delivered/Invoiced + evidence links), unlinked-bills section.
- **Features:** `loadPoMatchingQueue` org-pinned loud; NO tolerance (every variance to the penny — threshold is an untaken CEO decision); cancelled-order note + voided-GRN exclusion in `lib/purchase-orders/matching.ts`. READ.
- **Buttons & controls:** Open order / order number → detail; Job → `/jobs/[id]`; delivery note links; See all costs → `/finances`; All orders (all LIVE).

---

## DOMAIN SUMMARY — Operations

**Pages audited: 44 routes across 8 nav entries.**
- Operations overview: 1
- Assets: 11 (`/assets`, `/new`, `/[id]`, `/[id]/inspections/[inspectionId]`, `/inspections`, `/calibration`, `/holdings`, `/scan`, `/templates`, `/templates/new`, `/templates/[id]`) — the 9 `_*.tsx` detail tabs are sections of `/assets/[id]`, not routes.
- Fleet: 7 (`/fleet`, `/vehicles`, `/vehicles/new`, `/vehicles/[id]`, `/vehicles/[id]/edit`, `/compliance`, `/fuel`).
- Stock: 12 route pages (`/stock`, `/items`, `/items/new`, `/items/[id]`, `/items/[id]/edit`, `/locations/[id]`, `/replenishment`, `/stocktake`, `/stocktake/new`, `/stocktake/[id]`, `/valuation`, `/vans`).
- Materials: 3 (`/materials/requests`, `/new`, `/[id]`).
- Sites: 3 (`/sites`, `/new`, `/[id]`).
- Suppliers: 7 (`/suppliers`, `/new`, `/[id]`, `/[id]/cis`, `/[id]/payments`, `/[id]/performance`, `/compare`).
- Purchase orders: 4 (`/purchase-orders`, `/new`, `/[id]`, `/matching`).

**Status tally:**
- LIVE & WORKING: ~31 (all of fleet, stock, materials, sites, suppliers list/new/detail/performance/compare, all PO pages, operations overview).
- IMPLEMENTED, NOT LIVE-VERIFIED: ~12 (the entire assets domain — classified conservatively; no browser verification, though code is complete and corroborated by extensive guards/tests).
- PARTIALLY IMPLEMENTED: 1 (`/assets/scan` — camera path browser-gated, manual fallback always works).
- FLAGGED OFF (sub-features, not whole pages): 3 — HMRC-online CIS verify (`isHmrcConnectable()`, suppliers CIS); merchant electronic PO submit (`FEATURE_MERCHANTS`, PO detail); telematics connect (`FEATURE_TELEMATICS_CONNECT`, has NO UI entry point at all).
- PLACEHOLDER / BROKEN: none found.

**Banned revalidatePath+useActionState hang pattern:** NOT present anywhere in the domain. Assets/stock/materials/fleet deep routes all use `FormState.redirectTo` → `window.location.assign` (the mandated fix); suppliers CIS/payments return success without navigating; sites void-actions use redirect at depth-2. Clean.

**Hard-to-discover routes (reachable only via in-page buttons/links, no nav entry):**
- Assets: `/holdings`, `/inspections`, `/calibration`, `/scan`, `/templates(+new,[id])` — all header-button-only.
- Stock: `/valuation`, `/replenishment`, `/vans`, `/stocktake` — overview-header-button-only.
- Fleet: `/compliance`, `/fuel` — in-page only.
- Suppliers: `/cis`, `/payments`, `/performance`, `/compare` — card/link only.
- PO: `/matching` — header link only.
- Whole domain: **staff have zero sidebar access** (Operations area is ADMIN_ROLES) yet most routes only require org membership — staff reach them by URL/QR only.

**Implemented, not in nav (connected routes outside this domain):** `/a/[token]` (QR scan landing, authed + active-org scoped); `/api/assets/[id]/label/pdf` (QR label PDF).

**Orphaned / dead code:**
- `deleteFuelLog` (`fleet/fuel-actions.ts:133-173`) — fully implemented server action with **NO UI reference**; no delete control exists on any fuel list.
- `createFuelLog`'s `return_to=fuel` branch + `driver_id`/`notes` fields — never populated by any fleet form (latent input paths).
- No dead pages found.

**Server-actions / API with no direct domain UI:** `receiveIntoStock` (lives in `stock/actions.ts`, invoked only from PO detail); `resolveScannedItem` / `_scan.ts` resolvers (consumed by scanners); `lib/intelligence/supplier-performance.ts` rollup (consumed by HQ/dashboard, not a suppliers page); `/api/cron/maintenance-reminders-drain` (cron). Notification/email emitters: inspection safety-fail (`emitNotifications`), maintenance report/ready, material-request submit/decide (in-app + email).

**Financial-posting side-effects (whole domain):** exactly ONE path writes to `finances` — `recordSupplierBill` on PO detail (member-open). GRN receiving, receive-into-stock, stock issue/transfer/adjust, supplier payments (incl. CIS), fuel logs, and PO creation all explicitly write NO finances row. Stock valuation is a non-posting management report.

**Dark / flagged operations integrations:**
- `NEXT_PUBLIC_FEATURE_MERCHANTS` (default false, `lib/env.ts:600`) — merchant EDI (JP Corry/Jewson/Travis Perkins/Haldane Fisher), two-switch invariant, only referenced by PO detail; dark-cheap.
- `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` (default false, `lib/env.ts:565`) — Samsara/Verizon OAuth connect substrate; triple-gated; **no UI entry point in fleet** (detail page only READS empty `telematics_readings`).
- `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS` (default false, `lib/env.ts:513`) — gates only the proactive maintenance-reminder SEND engine (`lib/maintenance/readiness.ts`); the schedule UI/data is live, only outbound email is dark (also requires `getEmailReadiness().outboundReady`).
- HMRC-online CIS verify (`isHmrcConnectable()`) — dark seam confined to suppliers CIS; manual verification path is live.

**Notable findings (beyond the brief):**
1. **Inspection-template lifecycle is fully member-open** — `assets/template-actions.ts` has zero role checks, so any staff member can create, publish or archive a safety-inspection checklist, unlike every schedule/depreciation/override action which dual-gate admin. Worth confirming intent.
2. **`/assets` list caps at `limit(1000)` with no F-1 pagination** — a large fleet silently truncates (the sibling `/assets/calibration` paginates correctly).
3. **`recordSupplierBill` (posts actual cost to `finances`) is member-open** on PO detail, while CIS/payments writes are admin-gated — an asymmetry worth a product decision.
4. **Fleet "Log a fill" button misleads** — it links to the vehicle register, not a fuel form; the only fuel-entry form is on vehicle detail.
5. **Fleet compliance/fuel/vehicle-detail show admin-only write forms to members** (compliance schedules) — the writes fail at RLS with "Only an owner or admin", but the affordance is shown; minor UX smell.
6. **Stock valuation D1 doctrine inconsistency** — `/stock/valuation` declares "D1 DECIDED = weighted-average cost" and renders money, while every sibling stock file still asserts "D1 undecided / stock has no value". Behaviour is internally consistent (valuation is a non-posting report), but the status comments contradict; matches the MEMORY note that D1 was still open. CEO reconciliation, not a code defect.
7. **`deleteSupplier` + command-palette "new-po"** role mismatches (delete button not `isAdmin`-hidden; palette gates PO-new to admin while page allows any member) — cosmetic, RLS is the real boundary.
8. **PO create is two-step non-atomic** — a line-insert failure after the header leaves an orphan header (returns error but header persists).
