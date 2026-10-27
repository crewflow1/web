# Migration OS operator surface — runbook

**Status: FULL operator surface SHIPPED (super-admin, org-isolated) — READ (#939) + column REMAP (#940) + COMMIT/ROLLBACK (#941). All review-ready, not merged.**

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

## Navigation (post-merge fix)
The operator detail route is `/admin/imports/[id]?org=<targetOrgId>` (depth 3, matching the working customer wizard). An earlier `[orgId]/[id]` layout (depth 4) hit the documented Next 15.5 deep-route redirect drop — the commit/remap/rollback server work landed but the `?saved=` banner/navigation was unreliable — found by the local super-admin browser e2e. Collapsing the route to depth 3 restored reliable `redirect()`. Isolation is unchanged: `org` comes from the query and every data-layer call is pinned to it (wrong org → `not_found`). Guarded by `e2e/operator-imports.spec.ts` (read→remap→commit→rollback + non-super-admin 404).

## SHIPPED: operator column remap (staging-only) — PR #940
`operatorRemapColumns` + `getOperatorImportEntities` (`lib/admin/operator-imports.ts`) + the per-entity remap form on the detail page. Rewrites `import_rows.mapped` for still-open rows of one entity in the explicit target org; `requireHqPage()` first; every read + the update pinned `.eq("org_id", targetOrgId)`; status-gated to `detected`; overrides re-validated against the entity's canonical field allow-list. STAGING-ONLY (never live business tables) and reversible. Customer `"use server"` pipeline unchanged.

## SHIPPED: operator commit + rollback — PR #941
`operatorCommitImport` + `operatorRollbackImport` (`lib/admin/operator-imports.ts`) + confirm-gated Commit/Roll-back buttons on the detail page. The wizard's insert primitives (`insertOne`, `tableFor`, `skipReason`, the org-pinned resolvers) were extracted verbatim to `lib/imports/commit.ts` and are shared by both paths (one implementation, no drift). Operator ops authorise an EXPLICIT target org (`requireHqPage` first), pin `targetOrgId` on every read/insert/audit/delete, are status-gated (commit: `detected`, rollback: `committed`), keep partial-success per row, and do NOT fire the org's `import.completed` automation. Security ratchets (active-org-write-slice, loud-read shape ledger, migration-os-v3/cost-vat-rate/import-flow-fixes source contracts) were updated to follow the relocated code, not weakened.

### Original design note (for history)
`commitImport` (bulk INSERT into customers/invoices/jobs/…) and `rollbackImport` (bulk DELETE across 8 business tables) were hardwired to `requireOrgContext()`/`ctx.org.id`. Threading an explicit operator `targetOrgId` through them is cross-tenant-critical — a single missed pin is a cross-tenant write/delete — which is why it was built as its own focused, adversarially-reviewed PR. Plan as executed:
- Add operator-gated action wrappers that take an explicit `targetOrgId`, re-assert `requireHqApi()`/`isSuperAdminEmail`, and thread `targetOrgId` everywhere the customer path uses `ctx.org.id` (storage prefix, every `.eq`/insert, the service-role resolvers which already accept an org id).
- Mandatory tests: role-denial on every action + cross-org (an operator acting on org A cannot read/write org B), modelled on `__tests__/security/active-org-write-slice.test.ts`.
- Preview + dry-run + explicit confirm before any commit; audit trail; rollback parity.

## Product decision (non-blocking)
Direct operator access via explicit `targetOrgId` is implemented as the safe default. If the CEO prefers operator imports routed through the existing `app/admin/switch-to-customer` impersonation path instead, that is a product choice for the write slice — it does not block the read surface.

## Health / readiness
`/api/health` → `migrationOperator.operatorConfigured` reports whether the super-admin allowlist is non-empty (operators provisioned). Booleans only; no addresses leaked. See `lib/migration/readiness.ts`.
