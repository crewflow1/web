# Migration OS operator surface — runbook

**Status: READ surface SHIPPED (super-admin, org-isolated). Write slice DEFERRED (scoped below).**

## Why this exists
The import engine (`lib/imports/*`, `app/(app)/imports/actions.ts`) is powerful but the only surface was the **customer** wizard, scoped to the caller's own active org via `requireOrgContext()` + RLS. There was no way for a CrewFlow operator to see or assist with another org's migration. This adds an operator-only surface — **without** exposing advanced migration controls to ordinary customers.

## Authorization model (unchanged, reused)
Operator = **super-admin**, an env allowlist `CREWFLOW_SUPERADMIN_EMAILS` (not a DB role / JWT claim), enforced server-side by `server/auth/hq.ts` — `requireHqPage()` (pages → 404 for non-operators) / `requireHqApi()` (routes → 404). `app/admin/**` inherits the gate via `app/admin/layout.tsx`; each new page re-gates for defence in depth. Empty allowlist ⇒ nobody is an operator and the surface 404s for everyone.

## What shipped (read-only)
- `app/admin/imports/page.tsx` — operator selects ONE target org (`?org=<id>`) and sees that org's import sessions. Nothing is shown until an org is explicitly selected.
- `app/admin/imports/[orgId]/[id]/page.tsx` — read-only detail of one import of that org.
- `lib/admin/operator-imports.ts` — the data layer. The admin client bypasses RLS, so isolation is enforced **only here**, by two invariants on every function:
  1. `requireHqPage()` is the first act (non-operator 404s before any read).
  2. Every query is pinned `.eq("org_id", targetOrgId)`; the detail read requires **both** the org id and the row id, so another org's row can never be reached by guessing its id.
- Tests: `__tests__/security/operator-imports.test.ts` — non-operator reads nothing / never touches the admin client; reads are always org-pinned; a row outside the target org returns null; an empty org id runs no query.

## Deferred: the operator WRITE slice (its own reviewed PR)
Operator **remap / commit / rollback against a target org** is intentionally **not** in this PR. The customer write pipeline (`createImport` → `uploadImportFiles` → `overrideColumnMapping` → `commitImport` → `rollbackImport`) is hardwired to `requireOrgContext()` and stamps `ctx.org.id` on every storage path, insert and select. Threading an explicit operator `targetOrgId` through it is a security-critical change where a single missed pin is a cross-tenant write — so it must be its own focused, adversarially-reviewed PR, not bundled here. Plan:
- Add operator-gated action wrappers that take an explicit `targetOrgId`, re-assert `requireHqApi()`/`isSuperAdminEmail`, and thread `targetOrgId` everywhere the customer path uses `ctx.org.id` (storage prefix, every `.eq`/insert, the service-role resolvers which already accept an org id).
- Mandatory tests: role-denial on every action + cross-org (an operator acting on org A cannot read/write org B), modelled on `__tests__/security/active-org-write-slice.test.ts`.
- Preview + dry-run + explicit confirm before any commit; audit trail; rollback parity.

## Product decision (non-blocking)
Direct operator access via explicit `targetOrgId` is implemented as the safe default. If the CEO prefers operator imports routed through the existing `app/admin/switch-to-customer` impersonation path instead, that is a product choice for the write slice — it does not block the read surface.

## Health / readiness
`/api/health` → `migrationOperator.operatorConfigured` reports whether the super-admin allowlist is non-empty (operators provisioned). Booleans only; no addresses leaked. See `lib/migration/readiness.ts`.
