import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — R2 (Backfill + Parity Gate) security invariants.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 10, steps 1–3). Governing rule: the Migration Parity Rule (Kernel
 * Contract Map §2, fourteenth standard).
 *
 * CI has no database here (live parity is proven in the integration tier), so — like
 * the R1 schema suite — we pin the backfill's CONTRACT against its source text. These
 * are the assertions that, if they ever silently flipped, would be a hole in the
 * migration's safety: the mirror writing back to the legacy source, the backfill
 * factoring tokens UP a scope level (which would grant authority the legacy model
 * never gave and break parity), the parity check drifting from the legacy resolution
 * formula, the fail-closed gate going missing, or R2 quietly growing into the
 * resolver / SDK / legacy-removal work the CEO fenced out of this slice.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments stripped)
 * so the prose that NAMES the resolver / the legacy columns / "do NOT" can't satisfy a
 * positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260807000000_capability_registry_backfill.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the model and the R2 boundary.
const stripComments = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const exec = stripComments(mig);

/** The body of the parity function (signature → first `$$;`). */
function parityFn(): string {
  const start = exec.indexOf("create or replace function public.hq_capability_registry_parity()");
  expect(start, "parity function not found").toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, "parity function body not found").toBeGreaterThan(start);
  return exec.slice(start, end);
}

/** A single SQL statement starting at `marker`, up to (and including) its terminator `;`. */
function statement(marker: string): string {
  const start = exec.indexOf(marker);
  expect(start, `statement '${marker}' not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf(";", start);
  expect(end, `statement '${marker}' terminator not found`).toBeGreaterThan(start);
  return exec.slice(start, end + 1);
}

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("capability registry R2 — migration is present", () => {
  it("the R2 backfill migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it("is sequenced AFTER the R1 schema migration", () => {
    // R1 = 20260806…, R2 = 20260807… — the schema must exist before it is filled.
    expect(MIG_REL).toMatch(/20260807000000_capability_registry_backfill\.sql$/);
    expect(existsSync(resolve(ROOT, "supabase/migrations/20260806000000_capability_registry.sql"))).toBe(true);
  });
});

// =====================================================================
// 1. POPULATE the catalogue from the live authority data
// =====================================================================

describe("capability registry R2 — catalogue population", () => {
  it("inserts definitions into hq_capabilities", () => {
    expect(exec).toMatch(/insert into public\.hq_capabilities/i);
  });

  it("draws every token from BOTH legacy sources — tools_allowed AND permissions.scopes", () => {
    const stmt = statement("insert into public.hq_capabilities");
    expect(stmt).toMatch(/unnest\(tools_allowed\)/i);
    expect(stmt).toMatch(/jsonb_array_elements_text\(permissions\s*->\s*'scopes'\)/i);
  });

  it("classifies kind deterministically (tool_permission precedence via bool_or)", () => {
    const stmt = statement("insert into public.hq_capabilities");
    expect(stmt).toMatch(/case when bool_or\(s\.is_tool\) then 'tool_permission' else 'scope' end/i);
  });

  it("is idempotent — ON CONFLICT (token) DO NOTHING", () => {
    const stmt = statement("insert into public.hq_capabilities");
    expect(stmt).toMatch(/on conflict \(token\) do nothing/i);
  });
});

// =====================================================================
// 2. POPULATE the grants as a FLAT MIRROR (the parity-safety property)
// =====================================================================

describe("capability registry R2 — grant population (flat mirror)", () => {
  it("inserts grants into hq_capability_grants", () => {
    expect(exec).toMatch(/insert into public\.hq_capability_grants/i);
  });

  it("EVERY backfilled grant is employee-scoped — no factoring UP a scope level", () => {
    // This is the load-bearing parity guarantee: the legacy resolution is flat and
    // per-employee, so the only backfill that preserves EXACT parity populates the
    // employee level alone. A global / organization / department grant would make
    // employees inherit their scope-mates' tokens and BREAK parity.
    const stmt = statement("insert into public.hq_capability_grants");
    expect(stmt).toMatch(/'employee'/);
    expect(stmt).not.toMatch(/'global'/);
    expect(stmt).not.toMatch(/'organization'/);
    expect(stmt).not.toMatch(/'department'/);
  });

  it("mirrors each employee's own resolved tokens (sorted-distinct of tools_allowed ∪ scopes)", () => {
    const stmt = statement("insert into public.hq_capability_grants");
    expect(stmt).toMatch(/array_agg\(distinct tok order by tok\)/i);
    expect(stmt).toMatch(/unnest\(e\.tools_allowed\)/i);
    expect(stmt).toMatch(/jsonb_array_elements_text\(e\.permissions\s*->\s*'scopes'\)/i);
  });

  it("mirrors posture with the EXACT legacy normalisation (=== true / !== false)", () => {
    const stmt = statement("insert into public.hq_capability_grants");
    // can_execute === true  → literal-true only
    expect(stmt).toMatch(/\(e\.permissions\s*->\s*'can_execute'\)\s*=\s*'true'::jsonb/i);
    // requires_approval !== false  → literal-false only
    expect(stmt).toMatch(/\(e\.permissions\s*->\s*'requires_approval'\)\s+is distinct from\s+'false'::jsonb/i);
  });

  it("mirrors memory_scope from the legacy column", () => {
    const stmt = statement("insert into public.hq_capability_grants");
    expect(stmt).toMatch(/e\.memory_scope/i);
  });

  it("does NOT populate registration or budget_default (not authority data — out of R2 scope)", () => {
    const stmt = statement("insert into public.hq_capability_grants");
    // The inserted column list must omit both; they stay at their R1 defaults.
    const columnList = stmt.slice(0, stmt.indexOf("select"));
    expect(columnList).not.toMatch(/registration/i);
    expect(columnList).not.toMatch(/budget_default/i);
  });

  it("is idempotent — guarded by NOT EXISTS on (employee, slug)", () => {
    const stmt = statement("insert into public.hq_capability_grants");
    expect(stmt).toMatch(/where not exists \(/i);
    expect(stmt).toMatch(/g\.scope_level = 'employee' and g\.scope_key = e\.slug/i);
  });
});

// =====================================================================
// 3. The parity function — continuously-verifiable, deterministic
// =====================================================================

describe("capability registry R2 — parity function", () => {
  it("creates public.hq_capability_registry_parity() returning parity_ok", () => {
    expect(exec).toMatch(/create or replace function public\.hq_capability_registry_parity\(\)/i);
    expect(parityFn()).toMatch(/parity_ok\s+boolean/i);
  });

  it("respects RLS:hq — SECURITY INVOKER (never DEFINER), so it cannot leak authority data", () => {
    expect(parityFn()).not.toMatch(/security definer/i);
  });

  it("derives the legacy set with the EXACT resolver formula", () => {
    const body = parityFn();
    // sorted-distinct(tools_allowed ∪ permissions.scopes), empties dropped
    expect(body).toMatch(/array_agg\(distinct tok order by tok\)/i);
    expect(body).toMatch(/unnest\(e\.tools_allowed\)/i);
    expect(body).toMatch(/jsonb_array_elements_text\(e\.permissions\s*->\s*'scopes'\)/i);
    expect(body).toMatch(/length\(tok\) > 0/i);
    // posture: can_execute === true / requires_approval !== false
    expect(body).toMatch(/\(e\.permissions\s*->\s*'can_execute'\)\s*=\s*'true'::jsonb/i);
    expect(body).toMatch(/\(e\.permissions\s*->\s*'requires_approval'\)\s+is distinct from\s+'false'::jsonb/i);
  });

  it("compares against the EMPLOYEE grant, dimension by dimension", () => {
    const body = parityFn();
    expect(body).toMatch(/g\.scope_level = 'employee' and g\.scope_key = l\.slug/i);
    expect(body).toMatch(/g\.tokens is not distinct from l\.tokens/i);
    expect(body).toMatch(/g\.can_execute = l\.can_execute/i);
    expect(body).toMatch(/g\.requires_approval = l\.requires_approval/i);
    expect(body).toMatch(/g\.memory_scope = l\.memory_scope/i);
    // A missing grant is a parity failure, never a silent pass.
    expect(body).toMatch(/g\.id is not null/i);
  });
});

// =====================================================================
// 4. The parity gate — fail closed at migration time
// =====================================================================

describe("capability registry R2 — fail-closed parity gate", () => {
  it("a DO block aborts the migration if ANY employee is out of parity", () => {
    expect(exec).toMatch(/do \$\$/i);
    expect(exec).toMatch(/from public\.hq_capability_registry_parity\(\)\s+p\s+where not p\.parity_ok/i);
    expect(exec).toMatch(/raise exception\s+'Capability Registry R2 backfill parity check FAILED/i);
    expect(exec).toMatch(/errcode = 'data_exception'/i);
  });
});

// =====================================================================
// 5. R2 boundary — the Migration Parity Rule embodied
// =====================================================================

describe("capability registry R2 — stays inside the authorised slice", () => {
  it("is a ONE-DIRECTIONAL mirror — it READS the legacy source but NEVER writes it", () => {
    // The legacy authority stays authoritative (Migration Parity Rule). The mirror is
    // never written back: no ALTER / UPDATE / DELETE / DROP against ai_employees.
    expect(exec).toMatch(/from public\.ai_employees/i); // it does read the source…
    expect(exec).not.toMatch(/alter table public\.ai_employees/i);
    expect(exec).not.toMatch(/update public\.ai_employees/i);
    expect(exec).not.toMatch(/delete from public\.ai_employees/i);
  });

  it("removes NO legacy authority — no DROP anywhere (mirror-then-drop is a later slice)", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|trigger)/i);
    expect(exec).not.toMatch(/alter table[\s\S]*?drop column/i);
  });

  it("introduces NO runtime resolver / SDK surface — verification tooling only", () => {
    expect(exec).not.toMatch(/resolvedcapabilityset/i);
    expect(exec).not.toMatch(/resolveemployee/i);
  });

  it("opens NOTHING to a JWT role — no policies, no anon/authenticated/public grants", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});
