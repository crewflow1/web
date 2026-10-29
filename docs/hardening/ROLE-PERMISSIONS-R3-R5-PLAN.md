# Role & Permissions — R3–R5 Detailed Implementation Plan

**Depends on:** R2 (admin capability foundation, PR pending) merged + `membership_permissions`/`permission_audit` applied + types regenerated.
**Status:** PLAN. No R3–R5 code changes enforcement until R2 is merged + approved. Every access-changing migration (R5) is held for explicit founder approval with a validated apply + rollback.

Founder decisions now locked (from the 2026-10-29 directive):
- Taxonomy = module × {View, Create, Edit, Approve, Delete, Export, Manage}, default-deny, no self-escalation. ✅
- `job_assignments` is the staff access model; a rota entry does **not** grant job access. ✅
- Staff never see confidential pricing even on assigned jobs. ✅
- Staff DO get "necessary safety sign-offs/site reports relating to **assigned** jobs." ✅ (resolves part of the field-flow question)
- Ownership transfer: design strong reauth + both-party confirm + audit + recovery; **do not activate without separate approval.** ✅

Still open (flag before changing access): see §R4/§R5 "open" callouts — mainly asset inspections/QR and goods-receiving (staff-on-assigned vs management), and whether staff get a limited team-rota view or self-only.

---

## R3 — Owner authority, ownership transfer (design), admin permissions UI

### R3.1 Owner-only member & admin management (code; access-policy change, no migration)
Today `staff/actions.ts` (inviteStaff/resendStaffInvite/updateStaffRole/removeStaff) is gated `owner||admin`, and the `memberships` RLS `is_org_admin` policy is also owner||admin → **any admin can appoint/remove admins**. Target: only the OWNER may appoint/remove admins or change the admin⇄staff role, and only the owner may edit admin permissions.
- Code: add an owner-only guard (`ctx.membership.role === "owner"`) to `updateStaffRole` (when target role is/was admin) and to any admin-permission mutation. Inviting a plain `staff` can remain owner||admin (admins can add field staff) unless the founder wants invites owner-only too (**open: who may invite staff?** — lean: admin with `staff:manage` capability).
- RLS: tighten the `memberships` UPDATE/DELETE policy so role changes touching `admin` require owner. (This is an access-policy RLS change → migration M-owner; held for approval.)
- Admin cannot edit the owner: block any mutation whose target membership is the owner (server + RLS).
- Audit every event via `recordPermissionEvent`.

### R3.2 Admin permissions UI (code; owner-only)
- A `/settings/team/[membershipId]/permissions` (owner-only) editor: module × action grid, reading `CAP_MODULES`/`CAP_ACTIONS`, writing `membership_permissions` via owner-gated server actions (admin client), auditing each change, and offering "replace wildcard with specific grants."
- Default-deny on invite: a new admin starts with **no** grants (the wildcard is only the backfill for pre-existing admins).
- Stale re-eval: `can()` reads live grants per request, so a revocation takes effect on the admin's next action (no token invalidation needed) — add a test proving revoke → immediate deny.

### R3.3 Ownership transfer — DESIGN ONLY (do not activate without separate approval)
A two-party, reauthenticated, audited, recoverable flow:
1. **Initiate** (current owner, reauth'd): owner re-enters password (and MFA step-up if `require_mfa`), selects an existing admin/member as successor. Writes an `ownership_transfer` request row (pending, expires in N hours) + `permission_audit('ownership_transfer_requested')`. No role change yet.
2. **Accept** (successor, reauth'd): successor confirms (reauth), within the window. Only then, in ONE transaction: successor→owner, initiator→admin (retaining full grants), request→completed, `permission_audit('ownership_transfer_completed')`.
3. **Safety:** cannot demote the last owner except via a completed transfer; the initiator stays admin (not locked out); a pending request is cancellable by either party (`ownership_transfer_cancelled`); requests expire. Recovery: HQ super-admin can reassign ownership out-of-band (existing impersonation + a service-role path) if both parties are lost — documented runbook.
4. **Gate:** the whole workflow ships **dark behind a flag** and is **not activated** without separate founder approval (per directive). Schema (`ownership_transfers` table) is additive (migration M-transfer, held).

---

## R4 — Swap the 163 enforcement points to `can(module, action)`

Mechanical but breadth-risky; **incremental, one module-group per PR**, each with a role-matrix test. Order by sensitivity (money first — highest value, clearest policy):
1. **Money** (invoices, payments, expenses, costs, cis, tax, reports, cash) — `requireManagementApi`/`requireManagementContext` → `requireCapabilityApi("<module>", action)`. Owner unaffected; admin now needs the grant.
2. **Sales** (quotes, leads, customers, price_book, reviews) + the AI quote-writer (R2-safe already gated to management; swap to `quotes` capability).
3. **Operations** (assets, fleet, stock, suppliers, purchase_orders, sites, materials) — close the ~100 member-writable actions found in `findings/05` to `can("<module>", action)`. **Open:** asset inspections/QR, goods-receiving — staff-on-assigned vs management (founder ruling).
4. **Site & Safety** — authoring/registers → management capability; **operative sign-off + site reports on ASSIGNED jobs → staff** (per founder). This is where R4 meets R5 (the assigned-job check).
5. **Settings/integrations/staff/payroll** — `settings`/`staff`/`payroll` capabilities; billing stays management (R2 PR #947 already gated it; swap to `settings:manage`).
6. **Inbox** — swap R1's `requireManagementRole` to `inbox` capability.
7. **Search + exports** — `api/search` `canSeeMoney` and every export path consult `can("<module>", "export"|"view")`.

Each PR: (a) swap the gates, (b) keep nav hints in sync, (c) a security test asserting an admin WITHOUT the grant is denied and WITH it is allowed, and the owner always passes. No migration (pure code). The backfill wildcard means existing admins keep working throughout.

---

## R5 — Staff assigned-jobs boundary (the data-layer program; migrations, held for approval)

### M2 — `job_assignments` (additive)
`job_assignments(id, org_id, job_id, user_id, assigned_by, assigned_at, unique(job_id,user_id))` — the many-to-many ACL. A SECURITY-DEFINER helper `assigned_job_ids()` (mirrors `current_org_ids()`, guards on `auth.uid()`). **Backfill** from `jobs.assigned_to` (the single primary assignee) into `job_assignments`. Rota is NOT backfilled (founder: rota ≠ access). UI to add/remove assignees (management capability).

### M3 — staff SELECT RLS on jobs + children (access-policy; HELD)
Rewrite SELECT so a staff member sees a row only if `is_management OR job_id IN (assigned_job_ids())`, on: `jobs`, `job_documents`, `job_document_versions`, `job_progress_observations`, `snags`, `site_diary_entries`, `site_reports`, `job_checklists`, `material_requests`, and job-scoped `time_entries`. Management keeps org-wide. Each policy `create or replace`; rollback restores the org-wide policy (kept in the migration's down-notes). Storage: the signed-URL choke points already load the job per request, so the assignee gate rides on the tightened table RLS (confirm job-photos + job-docs paths).

### M4 — commercial-data staff denial (access-policy; HELD)
Staff SELECT denied at RLS on `finances`, `quotes`, `quote_line_items`, `invoices`, `job_budgets`, `job_billing_*` — management-only, even on assigned jobs (model = `staff_compensation` self-or-admin). This is the riskiest change (today these are member-readable); it is also the one that closes the "staff JWT can read pricing via PostgREST" gap in `findings/06`.

### M5 — self-scope rota/clock/leave + the UI (access-policy; HELD)
rota/clock/leave SELECT → self + management. **Open:** keep a limited team-rota view for staff, or self-only (policy says "their own" → lean self-only). Then make `/jobs` list, `/jobs/calendar`, and global search staff-aware (query only assigned jobs) so they don't error or leak job/customer existence.

### R5 test matrix (the founder's list, end-to-end, real-PG + e2e)
staff sees assigned job + its progress/notes/docs/photos/sign-off/site-report; staff DENIED an unassigned job (SELECT returns nothing via the user JWT, API 404, direct PostgREST empty); staff DENIED all commercial fields on an assigned job; staff self-only rota/clock/leave; cross-org isolation; direct-URL/API/RPC attempts; document+photo access tied to assignment; and management unaffected.

---

## Approval gates (what must NOT merge/deploy without explicit founder sign-off)
- **R2 migration** `20261241000000` apply to prod (additive; held per directive).
- **R3** `memberships` RLS owner-only tightening (M-owner) + the ownership-transfer schema (M-transfer, and the workflow stays dark/unactivated).
- **R5** migrations M2–M5 (assigned-jobs + commercial RLS + rota self-scope) — each with a validated apply + rollback.
Code-only R4 gate-swaps follow the standing branch→PR→review→approved-merge workflow (no migration), but because they change effective admin access they are called out for founder awareness per PR.

## Open policy questions to resolve before the dependent phase
1. Who may invite plain **staff** — owner-only, or an admin with `staff:manage`? (blocks R3.1)
2. **Asset inspections / QR scan** and **goods receiving** — staff-on-assigned or management? (blocks R4 step 3)
3. **Team-rota visibility** for staff — limited team view or strictly self-only? (blocks R5 M5)
