import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { detectUnsafeClientTables } from "./migration-data-api-grant-guard.test";

/**
 * Admin capability model (R2) — trust-boundary source contracts.
 *
 * The migration is ADDITIVE + DARK and the two new tables are SERVICE-ROLE-ONLY.
 * These pins prove that from the source, so a later edit that opens a client
 * door or changes enforcement before R4 fails CI.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261241000000_admin_capability_model.sql";
const RULES = "lib/auth/capability-rules.ts";
const SERVER = "server/auth/capabilities.ts";
const AUDIT = "server/services/permission-audit.ts";

const execOf = (sql: string) =>
  sql
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");

describe("migration hygiene", () => {
  const sql = read(MIGRATION);
  const exec = execOf(sql);

  it("exists in its reserved slot after the current tip", () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
    expect("20261241000000" > "20261240000000").toBe(true);
  });

  it("is ADDITIVE — 2 new tables + only a safe unique constraint on memberships", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(2);
    expect(exec).toMatch(/public\.membership_permissions/i);
    expect(exec).toMatch(/public\.permission_audit/i);
    // Nothing is dropped and no column/constraint is removed or altered.
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
    expect(exec).not.toMatch(/alter\s+table[\s\S]*?\b(drop|alter\s+column)\b/i);
    // The ONLY change to an existing table is an additive unique constraint on
    // memberships (the composite-FK target); every other alter is on a new table.
    const alters = exec.match(/alter\s+table\s+public\.(\w+)/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toMatch(/membership_permissions|permission_audit|memberships/);
    }
    expect(exec).toMatch(
      /alter\s+table\s+public\.memberships\s+add\s+constraint\s+memberships_id_org_key\s+unique\s*\(\s*id,\s*org_id\s*\)/i,
    );
  });

  it("references memberships by a COMPOSITE (id, org_id) FK (same-org integrity)", () => {
    expect(exec).toMatch(
      /foreign key\s*\(\s*membership_id,\s*org_id\s*\)\s*references\s+public\.memberships\s*\(\s*id,\s*org_id\s*\)/i,
    );
  });

  it("both tables are SERVICE-ROLE-ONLY: RLS on, client grants revoked, no client policy", () => {
    for (const t of ["membership_permissions", "permission_audit"]) {
      expect(exec, `${t} RLS`).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
      expect(exec, `${t} revoke`).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+public\\.${t}\\s+from\\s+public,\\s*anon,\\s*authenticated`,
          "i",
        ),
      );
    }
    // No CREATE POLICY at all → nothing client-reachable.
    expect(exec).not.toMatch(/create\s+policy/i);
  });

  it("passes the Data-API grant guard (no client-reachable table without a grant)", () => {
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });

  it("action CHECK is exactly the seven actions plus the wildcard", () => {
    expect(exec).toMatch(
      /action\s+in\s*\(\s*'view',\s*'create',\s*'edit',\s*'approve',\s*'delete',\s*'export',\s*'manage',\s*'\*'\s*\)/i,
    );
  });

  it("backfill grants EXISTING admins a wildcard so cutover changes no access, idempotently", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.membership_permissions/i);
    expect(exec).toMatch(/where\s+m\.role\s*=\s*'admin'/i);
    expect(exec).toMatch(/'\*',\s*'\*'/); // the wildcard grant
    expect(exec).toMatch(/on\s+conflict[\s\S]*do\s+nothing/i);
  });

  it("documents a rollback", () => {
    expect(sql).toMatch(/ROLLBACK/i);
    expect(sql).toMatch(/drop table if exists public\.membership_permissions/i);
  });
});

describe("helpers are server-only and enforcement is NOT yet wired (dark)", () => {
  it("the server capability module is server-only", () => {
    expect(read(SERVER)).toMatch(/^import\s+"server-only";/m);
    expect(read(AUDIT)).toMatch(/^import\s+"server-only";/m);
  });

  it("the pure rules module has NO server/DB/Next imports (client-safe)", () => {
    // Strip comments first — the file's own prose explains what it avoids.
    const code = read(RULES)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/import\s+"server-only"/);
    expect(code).not.toMatch(/createAdminClient|next\/navigation|@\/lib\/supabase/);
  });

  it("grants are read via the ADMIN client, never a client grant on the table", () => {
    expect(read(SERVER)).toMatch(/createAdminClient\(\)/);
    expect(read(SERVER)).toMatch(/from\("membership_permissions"\)/);
  });

  it("capability-API adoption is confined to the reviewed R2/R3 surface", () => {
    // The capability API is adopted deliberately, phase by phase. This guard
    // catches UNreviewed adoption: any new file using it must be added here with
    // its PR. R2 = the modules themselves; R3 = owner-controlled admin/staff
    // management (staff/actions.ts + permission-actions.ts). R4 will extend this
    // list as each module's gates are swapped to can(), per PR. Dependency-free
    // recursive scan over app/, server/, lib/ for every capability symbol.
    const SELF = new Set([
      // R2 — the capability modules themselves.
      "server/auth/capabilities.ts",
      "lib/auth/capability-rules.ts",
      "server/services/permission-audit.ts",
      // R3 — owner-controlled admin appointment + staff:manage + grant editor.
      "app/(app)/staff/actions.ts",
      // Company settings: saving organisation details needs settings:manage (owner
      // always) — the write itself goes through the service role after that gate.
      "app/(app)/settings/actions.ts",
      "app/(app)/staff/permission-actions.ts",
      // R4 — capability enforcement, financial modules (invoices first).
      "app/(app)/invoices/layout.tsx",
      "app/(app)/invoices/page.tsx",
      "app/api/invoices/route.ts",
      "app/api/invoices/[id]/route.ts",
      "app/api/invoices/export/route.ts",
      "app/api/invoices/[id]/pdf/route.ts",
      "app/api/invoices/[id]/remind/route.ts",
      "app/api/invoices/[id]/send/route.ts",
      // R4 — payments module.
      "app/(app)/payments/layout.tsx",
      "app/(app)/payments/actions.ts",
      "app/(app)/payments/allocate-actions.ts",
      "app/(app)/invoices/[id]/payment-actions.ts",
      "app/(app)/invoices/[id]/proof-actions.ts",
      // R4 — expenses module.
      "app/(app)/expenses/layout.tsx",
      "app/(app)/expenses/page.tsx",
      "app/(app)/expenses/actions.ts",
      "app/(app)/expenses/budgets/actions.ts",
      // R4 — costs module (the /finances route; "Costs" is its UI label). Only
      // the cost LEDGER is gated — cost ENTRY (/finances/new + POST) stays
      // member-open by design, so those files hold no capability symbol.
      "app/(app)/finances/page.tsx",
      "app/api/finances/route.ts",
      "app/api/finances/[id]/route.ts",
      "app/api/finances/export/route.ts",
      // R4 — CIS module. Layout gates the pages (cis:view); the 6 server actions
      // use hasCapability (FormState forms); the 3 API routes use
      // requireCapabilityApi (export for CSVs/return, view for the statement PDF).
      "app/(app)/cis/layout.tsx",
      "app/(app)/cis/actions.ts",
      "app/api/cis/returns/[id]/export.csv/route.ts",
      "app/api/cis/statements/[id]/pdf/route.ts",
      "app/api/cis/statements/export.csv/route.ts",
      // R4 — tax module (VAT / CIS300 / PAYE dashboard + HMRC prepare/submit).
      // No member-open surface; page view + the 3 throw-style actions + the
      // quarterly-PDF route. Submitting to HMRC → manage (highest-trust).
      "app/(app)/tax/page.tsx",
      "app/(app)/tax/actions.ts",
      "app/api/tax/quarterly-pdf/route.ts",
      // R4 — reports module. Layout gates the pages (reports:view); accounting +
      // subscribe actions use hasCapability (export/manage); the index + CSV API
      // routes use requireCapabilityApi (view/export); the per-report export route
      // keeps member access for non-management reports and gates the management-
      // only ones on reports:export.
      "app/(app)/reports/layout.tsx",
      "app/(app)/reports/accounting/actions.ts",
      "app/(app)/reports/subscribe/actions.ts",
      "app/api/reports/route.ts",
      "app/api/reports/export/route.ts",
      "app/api/reports/[report]/export/route.ts",
      // R4 — cash module (the /cash position page; no API, no actions, no layout).
      "app/(app)/cash/page.tsx",
      // R4 — quotes module. Layout + list page gate quotes:view; the 12 management
      // actions use requireCapabilityFor (create/edit/approve/delete); the PDF
      // route is view, the send route is edit. Customer token actions
      // (accept/declineQuoteByToken) are NOT capability-gated by design.
      "app/(app)/quotes/layout.tsx",
      "app/(app)/quotes/page.tsx",
      "app/(app)/quotes/actions.ts",
      // #1035 extracted the variation/EoT management actions here; same reviewed
      // R4-quote capability surface as actions.ts (requireCapabilityFor-gated).
      "app/(app)/quotes/variation-actions.ts",
      "app/api/quotes/[id]/pdf/route.ts",
      "app/api/quotes/[id]/send/route.ts",
      // R4 — customers module. Layout + list page gate customers:view; 5 actions
      // use requireCapabilityFor (create/edit/export/delete); the statement PDF
      // route gates customers:view.
      "app/(app)/customers/layout.tsx",
      "app/(app)/customers/page.tsx",
      "app/(app)/customers/actions.ts",
      "app/api/customers/[id]/statement/pdf/route.ts",
      // R4 — leads module. Layout + list page gate leads:view; 7 actions use
      // requireCapabilityFor (create/edit/delete). No API routes.
      "app/(app)/leads/layout.tsx",
      "app/(app)/leads/page.tsx",
      "app/(app)/leads/actions.ts",
      // R4 — price_book module (the estimating rate library; a money boundary —
      // staff never see prices). Layout + list page gate on price_book:view, the
      // [id] editor on price_book:edit, and the 7 server actions on create/edit/
      // delete via requireCapabilityFor; the list page uses canWith for affordances.
      "app/(app)/price-book/layout.tsx",
      "app/(app)/price-book/page.tsx",
      "app/(app)/price-book/[id]/page.tsx",
      "app/(app)/price-book/actions.ts",
      // R4 — inbox module (customer comms; staff off-limits). Layout gates the
      // subtree (inbox:view); the 5 server actions use requireCapabilityFor —
      // create (reply / start conversation), edit (triage / open-close), approve
      // (clear the AI review queue).
      "app/(app)/inbox/layout.tsx",
      "app/(app)/inbox/actions.ts",
      "app/(app)/inbox/conversations/actions.ts",
      "app/(app)/inbox/review/actions.ts",
      // R4 — insights intelligence surface. /insights is management business
      // intelligence over financial data, and /api/ai/question answers over the
      // same financial snapshot — both gated on reports:view (the data-visibility
      // boundary), since the AI inherits the user's permission to that data.
      "app/(app)/insights/page.tsx",
      "app/api/ai/question/route.ts",
      // R4 — job invoicing surfaces (billing + valuations). Both are the job's
      // "get paid" workflow and map to the invoices capability: view to read the
      // page, create/edit/approve on the actions (generate = create, certify =
      // approve, amend/submit/cancel/link = edit).
      "app/(app)/jobs/[id]/billing/page.tsx",
      "app/(app)/jobs/[id]/billing/actions.ts",
      "app/(app)/jobs/[id]/valuations/page.tsx",
      "app/(app)/jobs/[id]/valuation-actions.ts",
      // R4 — variation requests. reviewVariationRequest (accept/reject a
      // customer-change request → variation order) gates quotes:approve;
      // createVariationRequest stays member-open (staff field intake).
      "app/(app)/jobs/[id]/variation-request-actions.ts",
      // R5 — assignment reconciliation. assignWorker/removeWorker gate
      // jobs:manage before routing an assignment change through the admin-only
      // reconciliation RPCs (set_job_primary_assignment / add_job_worker /
      // remove_job_worker); jobs/actions.ts createJob gates the create itself
      // on jobs:create (D-17, 20261365000000) and the *assignee* up-front
      // (F2: hasCapability("jobs","manage")) so a non-admin can never
      // silently create an unassigned/mis-assigned job. Legitimate R5 capability
      // enforcement, not early adoption of the dark R2/R3 surface.
      "app/(app)/jobs/[id]/assignment-actions.ts",
      "app/(app)/jobs/actions.ts",
      // R4 — settings/billing (self-serve tenant plan mgmt; DARK). Page gates
      // settings:view; openBillingPortal + changePlan gate settings:manage.
      "app/(app)/settings/billing/page.tsx",
      "app/(app)/settings/billing/actions.ts",
      // Feature 2 — document-to-form autofill. The import server action gates the
      // operator for the TARGET record's create permission, mirroring each create
      // action exactly (hasCapability for customer/lead; canManageStaff for staff;
      // org-admin for site; member otherwise) — so an import can never bypass the
      // create authorisation. Legitimate per-record create gating, not early
      // adoption of the dark R2/R3 surface.
      "server/services/document-autofill.ts",
      // The registry is pure data (per-form auth mode) and names the create
      // guards (requireCapabilityFor / hasCapability / canManageStaff) only in
      // its explanatory comments; it calls nothing.
      "lib/imports/autofill/registry.ts",
      // Auto-rota persistence — "Approve & save" the generated plan. The write
      // action (persistGeneratedRota, in staff/actions.ts above) gates on
      // rota:create via requireCapabilityFor; the generate page uses hasCapability
      // only to SHOW/HIDE the approve panel (nav-hiding is never the boundary —
      // the server action + RLS admin WITH CHECK are). Legitimate owner/admin
      // write gating, not early adoption of a dark module surface.
      "app/(app)/staff/rota/generate/page.tsx",
      // Least-privilege enforcement (2026-11-14, founder rules in AGENT-RULES §8):
      // the Operations modules are CAPABILITY surfaces — segment layouts require
      // <module>:view, every server action re-checks <module>:<verb>, and the
      // private-column readers check the capability before a service-role read.
      // Decision table: docs/programme/security-least-privilege/.
      "app/(app)/a/layout.tsx",
      "app/(app)/assets/actions.ts",
      "app/(app)/assets/assignment-actions.ts",
      "app/(app)/assets/calibration-actions.ts",
      "app/(app)/assets/depreciation-actions.ts",
      "app/(app)/assets/inspection-actions.ts",
      "app/(app)/assets/layout.tsx",
      "app/(app)/assets/maintenance-actions.ts",
      "app/(app)/assets/override-actions.ts",
      "app/(app)/assets/qr-actions.ts",
      "app/(app)/assets/schedule-actions.ts",
      "app/(app)/assets/service-schedule-actions.ts",
      "app/(app)/assets/template-actions.ts",
      "app/(app)/fleet/actions.ts",
      "app/(app)/fleet/compliance-actions.ts",
      "app/(app)/fleet/fuel-actions.ts",
      "app/(app)/fleet/layout.tsx",
      "app/(app)/operations/layout.tsx",
      "app/(app)/purchase-orders/actions.ts",
      "app/(app)/purchase-orders/layout.tsx",
      "app/(app)/purchase-orders/receiving-actions.ts",
      "app/(app)/sites/actions.ts",
      "app/(app)/sites/layout.tsx",
      "app/(app)/stock/actions.ts",
      "app/(app)/stock/layout.tsx",
      "app/(app)/stock/reorder-actions.ts",
      "app/(app)/stock/stocktake-actions.ts",
      "app/(app)/stock/van-actions.ts",
      "app/(app)/suppliers/actions.ts",
      "app/(app)/suppliers/layout.tsx",
      "app/(app)/variations/layout.tsx",
      // D-17 (2026-11-15): reviewed adopters — field-baseline gates, the 18 under-restricted routes,
      // and the management-only child routes. Each file is a guard, not a bypass.
      "app/(app)/assets/calibration/layout.tsx",
      "app/(app)/assets/holdings/layout.tsx",
      "app/(app)/assets/new/layout.tsx",
      "app/(app)/assets/page.tsx",
      "app/(app)/assets/templates/layout.tsx",
      "app/(app)/compliance/layout.tsx",
      "app/(app)/documents/layout.tsx",
      "app/(app)/expenses/[id]/layout.tsx",
      "app/(app)/expenses/budgets/layout.tsx",
      "app/(app)/fleet/compliance/layout.tsx",
      "app/(app)/fleet/page.tsx",
      "app/(app)/fleet/vehicles/new/layout.tsx",
      "app/(app)/fleet/vehicles/[id]/edit/layout.tsx",
      "app/(app)/health-safety/actions.ts",
      "app/(app)/health-safety/permits/actions.ts",
      "app/(app)/health-safety/worker-links/layout.tsx",
      "app/(app)/jobs/new/layout.tsx",
      "app/(app)/jobs/templates/layout.tsx",
      "app/(app)/purchase-orders/matching/layout.tsx",
      "app/(app)/purchase-orders/new/layout.tsx",
      "app/(app)/purchase-orders/page.tsx",
      "app/(app)/staff/rota/conflicts/layout.tsx",
      "app/(app)/staff/rota/generate/layout.tsx",
      "app/(app)/stock/items/[id]/edit/layout.tsx",
      "app/(app)/stock/items/new/layout.tsx",
      "app/(app)/stock/replenishment/layout.tsx",
      "app/(app)/stock/stocktake/new/layout.tsx",
      "app/(app)/stock/valuation/layout.tsx",
      "app/api/assets/[id]/label/pdf/route.ts",
      "server/services/private-columns.ts",
      // D-17 job creation (20261365000000): these pages use hasCapability(jobs, create)
      // ONLY to show/hide the "add job" entry points (presentation; the boundary is the
      // /jobs/new segment guard, createJob and the jobs INSERT policy).
      "app/(app)/dashboard/page.tsx",
      "app/(app)/customers/[id]/page.tsx",
      // Final launch audit F8 (2026-11-17): page-level COPIES of each segment layout's
      // gate. A layout's gate does not stop the page beneath it rendering in parallel,
      // so these pages call the same requireCapability/requireAnyCapability first.
      // Same capability as the layout — no new authority. Census:
      // __tests__/security/segment-gate-page-level.test.ts.
      "app/(app)/a/[token]/page.tsx",
      "app/(app)/assets/calibration/page.tsx",
      "app/(app)/assets/holdings/page.tsx",
      "app/(app)/assets/new/page.tsx",
      "app/(app)/assets/templates/[id]/page.tsx",
      "app/(app)/assets/templates/new/page.tsx",
      "app/(app)/assets/templates/page.tsx",
      "app/(app)/cis/page.tsx",
      "app/(app)/cis/statements/[id]/page.tsx",
      "app/(app)/compliance/[id]/page.tsx",
      "app/(app)/compliance/new/page.tsx",
      "app/(app)/compliance/page.tsx",
      "app/(app)/customers/new/page.tsx",
      "app/(app)/documents/page.tsx",
      "app/(app)/expenses/[id]/page.tsx",
      "app/(app)/expenses/budgets/page.tsx",
      "app/(app)/fleet/compliance/page.tsx",
      "app/(app)/fleet/vehicles/[id]/edit/page.tsx",
      "app/(app)/fleet/vehicles/new/page.tsx",
      "app/(app)/health-safety/worker-links/page.tsx",
      "app/(app)/inbox/audit/page.tsx",
      "app/(app)/inbox/conversations/[id]/page.tsx",
      "app/(app)/inbox/conversations/new/page.tsx",
      "app/(app)/inbox/conversations/page.tsx",
      "app/(app)/inbox/page.tsx",
      "app/(app)/inbox/review/page.tsx",
      "app/(app)/invoices/[id]/page.tsx",
      "app/(app)/invoices/new/page.tsx",
      "app/(app)/jobs/new/page.tsx",
      "app/(app)/jobs/templates/[id]/page.tsx",
      "app/(app)/jobs/templates/new/page.tsx",
      "app/(app)/jobs/templates/page.tsx",
      "app/(app)/leads/[id]/page.tsx",
      "app/(app)/leads/new/page.tsx",
      "app/(app)/operations/page.tsx",
      "app/(app)/payments/new/page.tsx",
      "app/(app)/payments/page.tsx",
      "app/(app)/payments/reconcile/[id]/page.tsx",
      "app/(app)/purchase-orders/matching/page.tsx",
      "app/(app)/purchase-orders/new/page.tsx",
      "app/(app)/quotes/[id]/page.tsx",
      "app/(app)/quotes/new/page.tsx",
      "app/(app)/reports/ageing/page.tsx",
      "app/(app)/reports/cashflow/page.tsx",
      "app/(app)/reports/page.tsx",
      "app/(app)/reports/pipeline/page.tsx",
      "app/(app)/reports/profit/page.tsx",
      "app/(app)/reports/retention/page.tsx",
      "app/(app)/reports/utilisation/page.tsx",
      "app/(app)/sites/[id]/page.tsx",
      "app/(app)/sites/new/page.tsx",
      "app/(app)/sites/page.tsx",
      "app/(app)/staff/rota/conflicts/page.tsx",
      "app/(app)/stock/items/[id]/edit/page.tsx",
      "app/(app)/stock/items/new/page.tsx",
      "app/(app)/stock/replenishment/page.tsx",
      "app/(app)/stock/stocktake/new/page.tsx",
      "app/(app)/stock/valuation/page.tsx",
      "app/(app)/suppliers/[id]/cis/page.tsx",
      "app/(app)/suppliers/[id]/page.tsx",
      "app/(app)/suppliers/[id]/payments/page.tsx",
      "app/(app)/suppliers/[id]/performance/page.tsx",
      "app/(app)/suppliers/compare/page.tsx",
      "app/(app)/suppliers/new/page.tsx",
      "app/(app)/suppliers/page.tsx",
      "app/(app)/variations/page.tsx",
    ]);
    const SYMBOLS =
      /\b(requireCapability|requireCapabilityApi|requireCapabilityFor|hasCapability|resolveCapabilityContext|loadCapabilities|canWith|grantAllows|recordPermissionEvent)\b/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = resolve(dir, e.name);
        const rel = p.slice(ROOT.length + 1);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !rel.includes("__tests__") && !SELF.has(rel)) {
          if (SYMBOLS.test(readFileSync(p, "utf8"))) offenders.push(rel);
        }
      }
    };
    for (const root of ["app", "server", "lib"]) walk(resolve(ROOT, root));
    expect(offenders, `unexpected early capability adoption: ${offenders.join(", ")}`).toEqual([]);
  });
});
