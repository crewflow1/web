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

  it("is ADDITIVE — creates only the two new tables, alters no existing one", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(2);
    expect(exec).toMatch(/public\.membership_permissions/i);
    expect(exec).toMatch(/public\.permission_audit/i);
    expect(exec).not.toMatch(/\balter\s+table\s+public\.(?!membership_permissions|permission_audit)/i);
    expect(exec).not.toMatch(/\bdrop\s+table\b/i);
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

  it("R2 does NOT yet swap any gate — nothing outside the R2 modules adopts the capability API", () => {
    // Enforcement adoption is R4. If this fails, a gate was swapped early; move it
    // behind the R4 plan + its own tests. Dependency-free recursive source scan
    // over app/, server/ and lib/, for every capability symbol, excluding the R2
    // modules + tests themselves.
    const SELF = new Set([
      "server/auth/capabilities.ts",
      "lib/auth/capability-rules.ts",
      "server/services/permission-audit.ts",
    ]);
    const SYMBOLS =
      /\b(requireCapability|requireCapabilityApi|resolveCapabilityContext|loadCapabilities|canWith|grantAllows|recordPermissionEvent)\b/;
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
