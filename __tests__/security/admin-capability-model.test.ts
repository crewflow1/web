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
