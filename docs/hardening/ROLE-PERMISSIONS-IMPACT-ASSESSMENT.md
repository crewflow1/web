# CrewFlow — Role & Permissions Policy: Impact Assessment

**Date:** 2026-10-28 · prod `aedb9279` / tip `20261240000000` · Inputs: `findings/05-enforcement-surface.md`, `findings/06-staff-data-model.md`, live prod read-only counts.
**Status:** ASSESSMENT — no schema/RLS/code changed. Produced before any access-policy change, per founder directive. Implementation is phased (R1–R5) with approval gates on every migration.

---

## 0. Verdict
The policy is **implementable and phaseable**, but it is a **large architecture change**, not a patch: a net-new per-admin capability system and a net-new staff assigned-jobs data boundary, touching **163 enforcement files**, ~13 RLS policies, and requiring **4+ additive migrations** and a new UI.

**Lockout risk in current production is near-zero:** prod has **1 owner, 0 admins, 0 staff** (2 orgs, 2 users). No existing user loses access from any phase; the owner is untouched throughout. The validated-migration + rollback + admin→full-perms backfill are still built (correct for the future and for any non-prod environment), but they affect **0 rows today**.

**Recommended order:** ship the safe, migration-free staff-denial gates first (R1), then build the admin capability foundation (R2) and staff assigned-jobs boundary (R5) behind explicit founder approval of each migration.

---

## 1. Current state (evidence-based)

### Roles & model
- `memberships(id, org_id, user_id, role, created_at)` — **no permissions column**; `role ∈ {owner, admin, staff}`. `isManagementRole = owner||admin` (`server/auth/session.ts:457`).
- **Admin == owner** across almost the entire product. Only **2** owner-exclusive gates exist (GDPR erase, data-retention erase). **No ownership-transfer flow.**
- **Member management** (`staff/actions.ts`: `inviteStaff`/`resendStaffInvite`/`updateStaffRole`/`removeStaff`) gated `owner||admin`; real boundary is `memberships` RLS `is_org_admin` (also owner||admin). **Any admin can appoint/remove admins today.**
- **No org-side audit** of membership/permission/ownership changes (no trigger on `memberships`).

### Enforcement surface (what must migrate to capabilities)
- **83** call sites via the 4 session helpers (`requireManagementRole` ×54, `requireManagementApi` ×19, `requireManagementContext` ×9 layouts, `isManagementRole` ×1).
- **~126 inline `role === "owner"||"admin"` checks across ~120 files** (local `requireAdmin`/`isAdmin`/`isManager` copies) — same binary gate, bypassing the helper. **163 distinct enforcement files total.**
- **Gaps already (now policy-decided to close):** inbox/comms (`requireOrgContext` only), Operations area, Site & Safety **admin registers** (not the all-roles field tools), `recordSupplierBill` + inspection-template publish/archive (member-writable).
- **CRITICAL (discovered during R1 implementation):** a guard-coverage sweep of the staff-denied segments found **~100 server actions across ~25 files run on `requireOrgContext` only (no management check)** — i.e. member-writable today: `assets/*` (incl. `inspection-actions` ×7, `template-actions` ×11, `qr-actions`), `fleet/*`, `stock` partial, `suppliers/actions`, `purchase-orders/*` (incl. `recordSupplierBill`), `sites`, `compliance`, `site-reports` (×12), `health-safety/*` (×10 incl. `permits`, `signoff`, `worker-links`), `inbox/*`. This is a far larger member-writable surface than the audit's POLICY-01/04 implied. **It is NOT a blunt management-gate target** because the Site & Safety domain is MIXED: RAMS/permit authoring is management, but **operative sign-off** (`health-safety/signoff-actions.ts`), and possibly **asset inspections**, **site reports**, and **goods receiving**, are plausibly STAFF field actions on assigned jobs. A segment-level gate would either break those staff flows or leave partial enforcement. → Staff-denial must be done **per-action** under the capability + assigned-jobs model (R4/R5), with the founder adjudicating the field-flow actions (open decision #6).

### Staff / jobs data layer
- **No real assignment relation.** `jobs.assigned_to` = single nullable FK (one primary assignee, no crew). `rota_entries(user_id, job_id)` is scheduling (admin-write, `job_id` nullable), not an ACL. **A `job_assignments` many-to-many relation is a prerequisite.**
- **`jobs` RLS SELECT = org-wide member** (`org_id in (current_org_ids())`), no job dimension. ~11 child tables (`job_documents`, `job_document_versions`, job-photos storage, `job_progress_observations`, `snags`, `site_diary_entries`, `site_reports`, `job_checklists`, `material_requests`, `time_entries` SELECT, `rota_entries`) are likewise org-wide.
- **Commercial hiding is UI-only, NOT data-layer.** `finances`, `quotes`/`quote_line_items`, `invoices`, `job_budgets`, `job_billing_*` have org-wide member SELECT → a staff JWT could read pricing directly via PostgREST. Meeting "no confidential pricing even on assigned jobs" requires moving this into RLS (largest/riskiest part; model = `staff_compensation` self-or-admin, mig `20261218`).
- **Self-scoped data half-ready:** `leave_requests`/`time_entries` writes own-scoped, but rota/clock/leave **SELECT** org-wide (team awareness) → tighten to self+admin.
- **Storage enforceable:** signed URLs mint via the RLS-scoped client + per-request job load (choke point); the assignee gate rides on the tightened table RLS.
- **Compatibility:** `/jobs` list, `/jobs/calendar`, global search assume org-wide visibility → will need staff-aware changes; tightening rota/leave SELECT removes today's team-awareness UX.

---

## 2. Target architecture

### 2.1 Owner (Role 1)
- Full access in own org (unchanged). **Owner-only** (net-new): appoint/remove admins, grant/edit/revoke admin permissions, transfer ownership (separately secured — confirm + re-auth/step-up). Never crosses org/HQ (already enforced).

### 2.2 Custom-permission admin (Role 2) — net-new
- Coarse `role='admin'` stays. **Fine-grained grants** in a new `membership_permissions` table: `(membership_id, module, action, granted_by, granted_at)`, `module ∈ {jobs, sales, quotes, money, invoices, expenses, cis, reports, operations, stock, suppliers, fleet, assets, sites, materials, staff, rota, payroll, site_safety, documents, inbox, settings, integrations, ai, …}`, `action ∈ {view, create, edit, approve, delete, export, manage}`.
- Server helper `can(ctx, module, action)`: **owner → always true; admin → consult grants; staff → false** for management capabilities. Replaces `isManagementRole` at all 163 points (incrementally).
- **Default: no permissions** for a new admin. **Backfill:** every EXISTING admin gets all grants on cutover (no behavior change) — 0 rows in prod.
- Admin **cannot** grant itself, edit the owner, or exceed its own grants. Enforced server-side + RLS on `membership_permissions` (owner-write-only).
- **Stale-auth re-evaluation:** `can()` reads current grants per request (React.cache per request), so a revocation takes effect on the admin's next action — no stale token window. Session not required to be invalidated; authorization is re-derived, not cached in the JWT.

### 2.3 Staff (Role 3) — tighten to assigned-jobs
- **New `job_assignments(org_id, job_id, user_id, assigned_by, assigned_at)`** many-to-many ACL (distinct from rota scheduling). A SECURITY-DEFINER helper `assigned_job_ids()` (like `current_org_ids()`).
- Rewrite staff SELECT RLS on `jobs` + ~11 child tables to `management OR job_id IN (assigned_job_ids())`.
- **Commercial tables** (`finances`, `quotes`, `quote_line_items`, `invoices`, `job_budgets`, `job_billing_*`): staff SELECT denied at RLS (management-only), even for assigned jobs.
- rota/clock/leave SELECT → self+admin.
- `/jobs` list, calendar, search → staff see only assigned.

### 2.4 Audit (net-new)
- `permission_audit` (org-scoped) OR triggers on `memberships` + `membership_permissions` + an ownership-transfer log. Records actor, target, before/after, timestamp. Org-side (not the HQ `admin_activity_log`).

---

## 3. Required migrations (all additive; rollback noted)
| # | Migration | Risk | Rollback |
|---|---|---|---|
| M1 | `membership_permissions` table + RLS (owner-write) + `can()` SQL helper + backfill admins→all | additive; 0 admin rows in prod | drop table + helper; app falls back to `isManagementRole` if helper absent (feature-flagged read) |
| M2 | `job_assignments` table + `assigned_job_ids()` helper + backfill `jobs.assigned_to` → assignment rows | additive | drop table + helper |
| M3 | staff SELECT RLS rewrite on `jobs` + ~11 child tables (management OR assigned) | **access-policy** — behaviour change for staff | each policy is `create or replace`; rollback restores the org-wide policy (kept in the migration's down-notes) |
| M4 | commercial-table staff SELECT denial (`finances`/`quotes`/`invoices`/`budgets`/`billing`) | **access-policy** | restore member SELECT |
| M5 | rota/clock/leave SELECT → self+admin + `permission_audit`/triggers | access-policy + additive | restore + drop |

No migration **removes** a column or table; all are `create [or replace]`. Prod has 0 staff/admin, so M3/M4/M5 change **0 users' live experience** today — but they are still gated on founder approval + a validated apply + a stated rollback, per directive.

---

## 4. Phased narrow-PR plan
| Phase | Scope | Migration? | Risk | Gate |
|---|---|---|---|---|
| **R1** | ✅ **SHIPPED PR #951** — but SCOPED DOWN to **Inbox only** (page layout + all 3 action files). The broader Operations/Site&Safety gate was pulled from R1 once the mixed-domain + ~100-ungated-actions finding landed (see §1); those move to R4/R5 per-action. | No | Low (prod 0 staff; owner/admin unaffected) | shipped under standing hardening; in review |
| **R2** | Admin capability foundation: M1 + `can()` helper + `permission_audit` + backfill. No enforcement swap yet. | M1 | Low (additive, 0 rows) | **Founder approval of design + migration** |
| **R3** | Owner-only member/admin management + ownership-transfer (secured) + the admin **permissions UI**. | No (uses M1) | Medium (owner-only carve-out) | Founder approval |
| **R4** | Swap the 163 enforcement points `isManagementRole`→`can(module,action)`, incrementally per module, each with tests. | No | Medium (breadth) | Per-module PRs |
| **R5** | Staff assigned-jobs boundary: M2–M5 + `/jobs` list/calendar/search staff-aware + commercial RLS. | M2–M5 | **High** (data-layer boundary) | **Founder approval of each migration + validated apply + rollback** |

R1 is shippable now. R2–R5 are built behind approval; nothing merges/deploys without explicit founder sign-off on each access migration.

---

## 5. Regression test matrix (the founder's 10 + isolation)
Owner full access · admin permission combinations · admin permission **revocation** (stale re-eval) · admin cannot self-grant/edit-owner · staff access to assigned work · staff denied unassigned jobs · staff denied management routes/actions · cross-org isolation · direct-URL attempts · direct API/RPC attempts · document/photo access restriction · ownership-transfer security. Each phase ships its slice of this matrix across unit + integration(real-Postgres RLS) + security + e2e tiers. The Phase-8 harness already seeds owner/staff/HQ; it will gain an **admin** session + a **second staff with different assignments** for the matrix.

---

## 6. Open decisions needing founder input (before R2/R5)
1. **"Assigned" semantics:** is a staff member assigned via the new `job_assignments` ACL only, or should existing `jobs.assigned_to` + `rota_entries` auto-populate it? (Recommend: `job_assignments` is the ACL; backfill from `assigned_to`; rota does NOT grant access.)
2. **Team-awareness UX:** tightening rota/leave SELECT to self+admin removes staff seeing who else is working/off. Keep a limited team-rota view for staff, or fully self-only? (Policy says "their own rota" → recommend self-only; confirm.)
3. **Module/action taxonomy:** approve the module list + the 7 actions (View/Create/Edit/Approve/Delete/Export/Manage) as the admin grant surface.
4. **Ownership transfer:** acceptable security step (email confirm + password re-entry? MFA step-up where available?).
5. **Commercial on assigned jobs:** confirm staff see job scope/progress/docs/photos but **zero** pricing/margins/valuations even on assigned jobs (drives the M4 RLS denial).
6. **Field-flow actions (NEW — from the ~100-ungated-actions finding):** which of these are STAFF actions on assigned jobs vs management-only? — operative **RAMS/permit sign-off** (`health-safety/signoff-actions`), **asset inspections** (`assets/inspection-actions`), **asset QR scan** (`assets/qr-actions`), **site reports** (`site-reports/actions`), **goods receiving** (`purchase-orders/receiving-actions`). The founder's staff-allow list (rota/clock/holiday + progress/notes/docs/photos on assigned jobs) does not explicitly name these; each needs a management-vs-staff ruling before R4/R5 can gate the action correctly. Recommendation lean: sign-off = staff (on assigned jobs); inspections/QR/site-reports/receiving = management unless tied to a staff's assigned job.

---

## 7. What ships now vs what waits
- **Now (R1):** migration-free server gates closing the decided staff-denial gaps — a narrow PR, independent review, green CI.
- **Held for founder approval:** M1–M5 and the capability/assignment architecture (R2–R5). I will build and test them on branches and present each for approval before any merge/apply; no access-policy migration deploys without explicit sign-off + validated apply + rollback.
