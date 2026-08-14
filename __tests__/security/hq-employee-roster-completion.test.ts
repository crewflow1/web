import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Employee roster completion, security source-contracts (P2 HQ AI Operating System).
 *
 * The migration completes the ~30-employee roster with the 15 remaining named roles. This suite
 * pins the load-bearing safety rules at the source so a regression fails CI:
 *   • every new employee is present;
 *   • every new employee is DARK — its grant sits at the default-deny floor (can_execute=false,
 *     requires_approval=true), it holds NO send/commit/dispatch token, and it is wired to NO model
 *     (generative work stays governed and dark);
 *   • the migration is provably additive + idempotent — no new table/policy/function/trigger, no
 *     column drop, and every write is conflict-guarded.
 *
 * Checks run over `exec` (SQL line-comments stripped) so prose can neither satisfy a positive match
 * nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20261128000000_hq_employee_roster_completion.sql";
const exec = execOf(read(MIGRATION));

const NEW_EMPLOYEES = [
  "coo-ai",
  "cfo-ai",
  "onboarding-ai",
  "hr-ai",
  "legal-compliance-ai",
  "security-ai",
  "devops-ai",
  "database-ai",
  "api-ai",
  "monitoring-incident-ai",
  "orchestrator-ai",
  "memory-manager-ai",
  "workflow-ai",
  "notification-ai",
  "analytics-ai",
] as const;

// The 11 departments the ai_employees.department CHECK admits (20260712000000).
const ALLOWED_DEPARTMENTS = new Set([
  "executive",
  "engineering",
  "sales",
  "marketing",
  "design",
  "quality",
  "documentation",
  "product",
  "finance",
  "support",
  "operations",
]);

describe("employee roster completion — all 15 new employees are present", () => {
  for (const slug of NEW_EMPLOYEES) {
    it(`seeds ${slug}`, () => {
      expect(exec).toContain(`'${slug}'`);
    });
  }

  it("seeds a grant for every new employee (one hq_capability_grants row each)", () => {
    for (const slug of NEW_EMPLOYEES) {
      // each slug appears in the grants VALUES list as ('slug', 'scope')
      expect(exec).toMatch(new RegExp(`\\('${slug}',\\s*'(global|organization|department|employee|isolated)'\\)`));
    }
  });
});

describe("employee roster completion — every new employee is DARK (deny floor, no model)", () => {
  it("grants are inserted at the default-deny floor: can_execute FALSE, requires_approval TRUE", () => {
    // the set-based grant insert selects `false, true` for (can_execute, requires_approval)
    expect(exec).toMatch(/array\['read','draft','memory'\],\s*false,\s*true/);
    // the grant column list is (…, can_execute, requires_approval, memory_scope) in that order
    expect(exec).toMatch(/\(scope_level,\s*scope_key,\s*tokens,\s*can_execute,\s*requires_approval,\s*memory_scope\)/);
  });

  it("grants NO send / commit / book / dispatch / execute token — the safety contract is by ABSENCE", () => {
    for (const forbidden of ["send", "commit", "book", "dispatch", "execute"]) {
      expect(exec).not.toMatch(new RegExp(`'${forbidden}'`));
    }
  });

  it("wires NO model — the identity insert omits model_provider / model_name (generative dark)", () => {
    // the insert column list is (name, slug, role, department, description, icon, accent, status,
    // memory_scope, sort_order) — no model columns.
    expect(exec).toMatch(/insert into public\.ai_employees\s*\(\s*name,\s*slug,\s*role,\s*department,\s*description,\s*icon,\s*accent,\s*status,\s*memory_scope,\s*sort_order\s*\)/);
    expect(exec).not.toMatch(/model_provider|model_name/);
  });

  it("uses only departments the ai_employees CHECK admits", () => {
    // The departments this migration assigns — each must be in the CHECK set, and each must appear.
    const used = ["executive", "finance", "support", "operations", "engineering", "product"];
    for (const d of used) {
      expect(ALLOWED_DEPARTMENTS.has(d)).toBe(true);
      expect(exec).toContain(`'${d}'`);
    }
  });
});

describe("employee roster completion — provably additive + idempotent", () => {
  it("adds NO table, policy, function, or trigger", () => {
    expect(exec).not.toMatch(/create\s+table/i);
    expect(exec).not.toMatch(/create\s+policy/i);
    expect(exec).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(exec).not.toMatch(/create\s+trigger/i);
  });

  it("drops NO column and alters no table", () => {
    expect(exec).not.toMatch(/drop\s+column/i);
    expect(exec).not.toMatch(/alter\s+table/i);
  });

  it("every write is conflict-guarded (identity on conflict do nothing; grants where not exists)", () => {
    expect(exec).toMatch(/on conflict \(slug\) do nothing/);
    expect(exec).toMatch(/on conflict \(token\) do nothing/);
    expect(exec).toMatch(/where not exists/);
  });
});
