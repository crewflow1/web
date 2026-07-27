import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR5.4B (Remove the Legacy Authority Columns) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 5.4B — the FINAL implementation increment
 * of the Capability Registry directive. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Authorising standards (Kernel Contract Map §2): the **Legacy Independence Rule (28th): physical
 * legacy structures may be removed only once completely independent of runtime execution**; the
 * **Data Removal Rule (26th): "physical deletion comes last"**; and the **Hidden Read Path Rule
 * (27th): every SQL reader migrated BEFORE the drop**.
 *
 * The objective of LR5.4B is PHYSICAL REMOVAL ONLY — no behavioural change. Increments LR5.1
 * (retire the mirror), LR5.2 (migrate the reads), LR5.3 (retire the rollback) and LR5.4A (migrate
 * the last hidden SQL reader) banked the five independence faces that AUTHORISE the drop; this
 * increment performs it. CI has no database here (the live behaviour is proven in the integration
 * tier), so — like every earlier increment's suite — we pin the CONTRACT against source text.
 * These are the facts that, if they ever silently flipped, would be a hole in LR5.4B:
 *   • the removal migration DROPS the legacy authority columns (tools_allowed, permissions) and
 *     the obsolete parity oracle, in dependency-then-removal order (the oracle drops FIRST — it
 *     names the columns — and memory_scope / department are NEVER dropped);
 *   • both authoring RPCs are RE-POINTED off the legacy columns — they read identity only and
 *     seed a fresh grant from the deny floor; the SURVIVING memory_scope mirror is preserved;
 *   • NO runtime surface references the removed columns or the removed shadow machinery — the
 *     pure law serves registry-or-floor (never legacy), the bridge has no parity comparator and
 *     no legacy fallback, the legacy resolvers are gone, the confidence audit reads slug+department;
 *   • the PRESERVE list is honoured — migration history, the production-confidence audit, and the
 *     surviving memory_scope / department all remain.
 *
 * Comment text (TS block/line + SQL `--`) is stripped first, so the prose that DOCUMENTS the
 * contract can neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JSX block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. {/* … */} JSX)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip SQL line comments (-- … EOL) so assertions test EXECUTABLE statements. */
const stripSql = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) if (m[1]) specs.push(m[1]);
  while ((m = bareRe.exec(code))) if (m[1]) specs.push(m[1]);
  return specs;
}

const MIGRATION = "supabase/migrations/20260812000000_lr5_4b_remove_legacy_authority_columns.sql";
const RESOLVER = "server/sdk/registry-resolver.ts";
const PARITY = "server/sdk/registry-parity.ts";
const CONFIDENCE = "server/sdk/registry-confidence.ts";
const TASKS = "server/sdk/tasks.ts";
const AIEMP = "server/services/ai-employees.ts";
const PAGE = "app/admin/ai-boardroom/[slug]/page.tsx";

const MIG_DIR = "supabase/migrations";
const LR1_MIG = `${MIG_DIR}/20260808000000_capability_registry_native_authoring.sql`;
const MEMSCOPE_MIG = `${MIG_DIR}/20260809000000_capability_registry_native_memory_scope.sql`;
const LR51_MIG = `${MIG_DIR}/20260810000000_capability_registry_retire_capability_mirror.sql`;

const mig = stripSql(read(MIGRATION));

// =====================================================================
// 0. The removal migration ships.
// =====================================================================

describe("registry LR5.4B — the removal migration ships", () => {
  it("ships the LR5.4B removal migration", () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });
});

// =====================================================================
// 1. The migration DROPS the legacy columns + the parity oracle, in
//    dependency-then-removal order (the Data Removal Rule, 26th).
// =====================================================================

describe("registry LR5.4B — the migration drops the legacy columns and the parity oracle", () => {
  it("DROPS the legacy authority columns tools_allowed + permissions", () => {
    expect(mig).toMatch(/alter\s+table\s+public\.ai_employees/i);
    expect(mig).toMatch(/drop\s+column\s+tools_allowed/i);
    expect(mig).toMatch(/drop\s+column\s+permissions/i);
  });

  it("DROPS the obsolete parity oracle hq_capability_registry_parity()", () => {
    expect(mig).toMatch(
      /drop\s+function\s+if\s+exists\s+public\.hq_capability_registry_parity\(\)/i,
    );
  });

  it("drops the parity oracle BEFORE the columns (it names them — dependency-then-removal)", () => {
    const oracle = mig.indexOf("drop function");
    const column = mig.indexOf("drop column tools_allowed");
    expect(oracle).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    expect(oracle).toBeLessThan(column);
  });

  it("NEVER drops the surviving memory_scope or department columns", () => {
    expect(mig).not.toMatch(/drop\s+column[^;]*\bmemory_scope\b/i);
    expect(mig).not.toMatch(/drop\s+column[^;]*\bdepartment\b/i);
  });
});

// =====================================================================
// 2. Both authoring RPCs are RE-POINTED off the legacy columns; the
//    surviving memory_scope mirror is preserved (the Hidden Read Path Rule, 27th).
// =====================================================================

describe("registry LR5.4B — the authoring RPCs are re-pointed off the legacy columns", () => {
  it("re-points both authoring RPCs (capabilities + memory_scope)", () => {
    expect(mig).toMatch(
      /create\s+or\s+replace\s+function\s+public\.hq_author_employee_capabilities/i,
    );
    expect(mig).toMatch(
      /create\s+or\s+replace\s+function\s+public\.hq_author_employee_memory_scope/i,
    );
  });

  it("the capability RPC reads the SURVIVING memory_scope only (identity), seeds the deny floor", () => {
    expect(mig).toMatch(/select\s+memory_scope\s+into\s+v_memory_scope/i);
    expect(mig).toMatch(/v_can_execute\s*:=\s*false/i);
    expect(mig).toMatch(/v_requires_approval\s*:=\s*true/i);
  });

  it("the memory-scope RPC reads identity only and seeds a fresh grant at the deny floor", () => {
    expect(mig).toMatch(/select\s+e\.id\s+into\s+v_emp_id/i);
    // Fresh grant: EMPTY tokens, can_execute=false, requires_approval=true (the deny floor).
    expect(mig).toMatch(/\('employee',\s*p_slug,\s*'\{\}'::text\[\],\s*false,\s*true/);
  });

  it("PRESERVES the surviving memory_scope mirror (the dual write to ai_employees)", () => {
    expect(mig).toMatch(/update\s+public\.ai_employees\s+set\s+memory_scope\s*=\s*p_memory_scope/i);
  });

  it("no longer reads legacy authority through the dropped permissions views", () => {
    // The re-pointed RPCs read catalogue kind + identity, never the legacy permissions JSON view.
    expect(mig).not.toMatch(/permissions\.scopes/);
    expect(mig).not.toMatch(/permissions\.can_execute/);
    expect(mig).not.toMatch(/permissions\.requires_approval/);
  });
});

// =====================================================================
// 3. NO runtime surface references the removed columns or shadow machinery
//    (the directive: "verify no runtime references remain to the removed columns").
// =====================================================================

describe("registry LR5.4B — no runtime surface references the removed legacy authority", () => {
  it("the pure law serves registry-or-floor, never a legacy model", () => {
    const resolver = codeOf(read(RESOLVER));
    expect(resolver).toMatch(/basis: "floor"/);
    expect(resolver).not.toMatch(/basis: "legacy"/);
    expect(resolver).not.toMatch(/compareAuthority/);
  });

  it("the bridge has no parity comparator and no legacy fallback (the floor is the fail-safe)", () => {
    const parity = codeOf(read(PARITY));
    expect(parity).not.toMatch(/verifyRegistryParity/);
    expect(parity).not.toMatch(/legacyServedAuthority/);
    expect(parity).toMatch(/floorServedAuthority/);
    expect(importSpecifiers(parity)).not.toContain("@/lib/env");
  });

  it("the legacy resolvers are removed (the registry is the SOLE authority)", () => {
    const tasks = codeOf(read(TASKS));
    expect(tasks).not.toMatch(/resolveEmployeeCapabilities/);
    expect(tasks).not.toMatch(/resolveEmployeePosture/);
  });

  it("the confidence audit reads only slug + department (no legacy authority column)", () => {
    const confidence = codeOf(read(CONFIDENCE));
    expect(confidence).toMatch(/"slug, department"/);
    expect(confidence).not.toMatch(/tools_allowed/);
    expect(confidence).not.toMatch(/permissions/);
  });

  it("the employee model + admin page no longer read the removed columns", () => {
    const aiemp = codeOf(read(AIEMP));
    expect(aiemp).not.toMatch(/tools_allowed/);
    expect(aiemp).not.toMatch(/permissions/);
    const page = codeOf(read(PAGE));
    expect(page).not.toMatch(/e\.tools_allowed/);
    expect(page).not.toMatch(/e\.permissions\.scopes/);
    expect(page).not.toMatch(/e\.permissions\.requires_approval/);
  });
});

// =====================================================================
// 4. The PRESERVE list is honoured (the Data Removal Rule retains history +
//    production-confidence evidence; memory_scope / department survive).
// =====================================================================

describe("registry LR5.4B — the preserve list is honoured", () => {
  it("keeps the migration history intact (LR1 808, memory_scope 809, LR5.1 810 all present)", () => {
    expect(existsSync(resolve(ROOT, LR1_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, MEMSCOPE_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, LR51_MIG))).toBe(true);
  });

  it("preserves the production-confidence audit (the §4 evidence is retained)", () => {
    const confidence = codeOf(read(CONFIDENCE));
    expect(confidence).toMatch(/export async function auditRegistryConfidence/);
  });

  it("the surviving memory_scope column remains on the model", () => {
    const aiemp = codeOf(read(AIEMP));
    expect(aiemp).toMatch(/memory_scope/);
  });
});
