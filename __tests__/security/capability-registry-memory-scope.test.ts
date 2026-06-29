import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR2 (Registry-Native Memory Scope) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 2. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel
 * Contract Map §2): the Single Source of Authority Rule (13th), the Migration Parity
 * Rule (14th), the Behaviour Preservation Rule (15th), the Shadow Validation Rule
 * (16th), the Rollback Readiness Rule (17th), the Evidence Before Deletion Rule (18th),
 * and — the headline rule here — the Mirror Integrity Rule (19th): the derived legacy
 * column must never be edited directly; the mirror must be deterministic + atomic.
 *
 * LR2 closes the LAST direct legacy authoring path: memory_scope used to be written
 * straight to ai_employees by updateAiEmployeeConfig, leaving the registry grant to
 * drift. CI has no database here (the live behaviour is proven in the integration tier),
 * so — like the R1/R2/LR1 suites — we pin the CONTRACT against source text. These are
 * the facts that, if they ever silently flipped, would be a hole in LR2's safety:
 *   • the write is ATOMIC + service-role only (one SECURITY DEFINER RPC, search_path
 *     pinned, EXECUTE revoked from every JWT role) — no app-layer dual write;
 *   • memory_scope is VALIDATED against the fixed vocabulary as a clean envelope;
 *   • the grant is upserted MEMORY_SCOPE-ONLY and the legacy column is MIRRORED in the
 *     same transaction (deterministic + atomic — the Mirror Integrity Rule);
 *   • POSTURE IS PRESERVED — the mutation path never writes can_execute /
 *     requires_approval (no execution unlock — Directive 001); a fresh grant is seeded
 *     from the legacy posture + token union with the EXACT normalisation, born in parity;
 *   • the DIRECT legacy authoring path is GONE — updateAiEmployeeConfig no longer writes
 *     memory_scope (this is the LR2 removal: route the write through the registry);
 *   • the write module authors EXCLUSIVELY through the RPC (never a direct table write);
 *   • the admin action is superadmin-gated, audited, and never touches the execution lock;
 *   • NOTHING authorised-to-keep is removed — no legacy column dropped, the R2 parity
 *     tooling + the R4 switch remain (LR5.3 later retired the rollback control, separately
 *     authorised; the automatic fail-safe stays).
 *
 * Comment text (SQL line comments and TS block/line comments) is stripped first, so the
 * prose that DOCUMENTS the contract can neither satisfy a positive match nor trip a
 * negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

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

/** Strip SQL line comments (-- … EOL) so assertions test EXECUTABLE statements. */
const stripSql = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const MIG_REL = "supabase/migrations/20260809000000_capability_registry_native_memory_scope.sql";
const LR1_MIG_REL = "supabase/migrations/20260808000000_capability_registry_native_authoring.sql";
const MODULE_REL = "server/sdk/registry-authoring.ts";
const ACTIONS_REL = "app/admin/ai-boardroom/actions.ts";
const PARITY_REL = "server/sdk/registry-parity.ts";
const R2_REL = "supabase/migrations/20260807000000_capability_registry_backfill.sql";

const exec = stripSql(read(MIG_REL));

/** The body of the memory-scope authoring function (signature → first `$$;`). */
function authorFn(): string {
  const start = exec.indexOf(
    "create or replace function public.hq_author_employee_memory_scope(",
  );
  expect(start, "memory-scope authoring function not found").toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, "memory-scope authoring function body not found").toBeGreaterThan(start);
  return exec.slice(start, end);
}

/** Slice a named exported function from TS source up to the next `export ` (or EOF). */
function fnSlice(code: string, signature: string): string {
  const start = code.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const next = code.indexOf("\nexport ", start + signature.length);
  return next === -1 ? code.slice(start) : code.slice(start, next);
}

// =====================================================================
// 0. The contract files ship.
// =====================================================================

describe("registry LR2 — the memory-scope authoring surface ships", () => {
  it("ships the migration and is sequenced after R1/R2/LR1", () => {
    expect(existsSync(resolve(ROOT, MIG_REL)), MIG_REL).toBe(true);
    expect(existsSync(resolve(ROOT, MODULE_REL)), MODULE_REL).toBe(true);
    // R1 = …806, R2 = …807, LR1 = …808, LR2 = …809 — authoring exists before this.
    expect(MIG_REL).toMatch(/20260809000000_capability_registry_native_memory_scope\.sql$/);
    expect(existsSync(resolve(ROOT, LR1_MIG_REL))).toBe(true);
    expect(existsSync(resolve(ROOT, R2_REL))).toBe(true);
  });
});

// =====================================================================
// 1. The write is ATOMIC + service-role only (one SECURITY DEFINER RPC).
// =====================================================================

describe("registry LR2 — atomic, service-role-only memory-scope RPC", () => {
  it("is a SECURITY DEFINER function with a pinned empty search_path", () => {
    const body = authorFn();
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = ''/i);
  });

  it("locks EXECUTE down to service_role (revoked from every JWT role)", () => {
    expect(exec).toMatch(/revoke all on function public\.hq_author_employee_memory_scope/i);
    expect(exec).toMatch(/from public, anon, authenticated/i);
    expect(exec).toMatch(/grant execute on function public\.hq_author_employee_memory_scope/i);
    expect(exec).toMatch(/to service_role/i);
  });

  it("opens NOTHING to a JWT role — no policies, no anon/authenticated/public grants", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

// =====================================================================
// 2. The registry write — validate the scope, upsert the grant MEMORY_SCOPE-ONLY.
// =====================================================================

describe("registry LR2 — validates the scope then authors the grant", () => {
  const body = authorFn();

  it("VALIDATES memory_scope against the fixed vocabulary as a clean envelope", () => {
    // The grant + legacy CHECK constraints are the hard backstop; the RPC returns a
    // clean envelope instead of a raised constraint so the caller can branch.
    expect(body).toMatch(
      /not in \('isolated', 'department', 'organization', 'global'\)/i,
    );
    expect(body).toMatch(/'reason', 'invalid_memory_scope'/i);
  });

  it("authors the EMPLOYEE scope only — never factors authority UP a scope level", () => {
    expect(body).toMatch(/scope_level = 'employee' and scope_key = p_slug/i);
    expect(body).not.toMatch(/scope_level = 'global'/i);
    expect(body).not.toMatch(/scope_level = 'organization'/i);
    expect(body).not.toMatch(/scope_level = 'department'/i);
  });

  it("UPSERTS the grant MEMORY_SCOPE-ONLY — the update path sets only memory_scope", () => {
    expect(body).toMatch(/update public\.hq_capability_grants\s+set memory_scope = p_memory_scope/i);
    // It must NOT replace the token set (that is LR1's job; LR2 preserves tokens).
    expect(body).not.toMatch(/set tokens = /i);
  });
});

// =====================================================================
// 3. POSTURE IS PRESERVED — no execution unlock anywhere (Directive 001).
// =====================================================================

describe("registry LR2 — posture is preserved (no execution unlock)", () => {
  it("NEVER updates posture — no `set can_execute` / `set requires_approval`", () => {
    expect(exec).not.toMatch(/set\s+can_execute/i);
    expect(exec).not.toMatch(/set\s+requires_approval/i);
  });

  it("a FRESH grant is seeded from the legacy posture + token union, born in parity", () => {
    const body = authorFn();
    // posture: can_execute === true (literal-true only); requires_approval !== false.
    expect(body).toMatch(/\(v_permissions\s*->\s*'can_execute'\)\s*=\s*'true'::jsonb/i);
    expect(body).toMatch(/\(v_permissions\s*->\s*'requires_approval'\)\s+is distinct from\s+'false'::jsonb/i);
    // tokens: the same sorted-distinct union the R2 backfill + parity oracle use.
    expect(body).toMatch(/array_agg\(distinct tok order by tok\)/i);
  });
});

// =====================================================================
// 4. The legacy mirror is DETERMINISTIC + ATOMIC (the Mirror Integrity Rule).
// =====================================================================

describe("registry LR2 — deterministic, atomic legacy mirror", () => {
  const body = authorFn();

  it("mirrors the new memory_scope BACK to the legacy ai_employees column", () => {
    expect(body).toMatch(/update public\.ai_employees/i);
    expect(body).toMatch(/set memory_scope = p_memory_scope/i);
  });

  it("mirrors ONLY memory_scope on the legacy side — tokens + posture untouched", () => {
    // The legacy UPDATE writes one column; it must not also rewrite tools_allowed /
    // permissions (those are LR1's mirror; LR2 preserves them).
    const legacyUpdate = body.slice(body.indexOf("update public.ai_employees"));
    expect(legacyUpdate).not.toMatch(/tools_allowed\s*=/i);
    expect(legacyUpdate).not.toMatch(/permissions\s*=/i);
  });
});

// =====================================================================
// 5. The DIRECT legacy authoring path is GONE (the LR2 removal).
// =====================================================================

describe("registry LR2 — the direct legacy memory_scope write is removed", () => {
  const code = codeOf(read(ACTIONS_REL));

  it("updateAiEmployeeConfig NO LONGER writes memory_scope (routed through the registry)", () => {
    const config = fnSlice(code, "export async function updateAiEmployeeConfig");
    expect(config).not.toMatch(/memory_scope/i);
  });

  it("the config schema no longer carries memory_scope", () => {
    // The schema object literal must not declare a memory_scope field.
    const schema = code.slice(
      code.indexOf("const configSchema"),
      code.indexOf("export async function updateAiEmployeeConfig"),
    );
    expect(schema).not.toMatch(/memory_scope/i);
  });
});

// =====================================================================
// 6. The write module authors EXCLUSIVELY through the RPC, never throws.
// =====================================================================

describe("registry LR2 — the write module is fenced and RPC-only", () => {
  const code = codeOf(read(MODULE_REL));

  it("is server-only fenced (it holds the service-role client)", () => {
    expect(code).toContain("server-only");
  });

  it("authors memory_scope EXCLUSIVELY through the atomic RPC — no direct table write", () => {
    expect(code).toMatch(/\.rpc\.bind\(/);
    expect(code).toMatch(/hq_author_employee_memory_scope/);
    for (const forbidden of [".from(", ".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(code, `the write module must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exposes a STRICTLY non-throwing memory-scope author (discriminated result)", () => {
    const fn = fnSlice(code, "export async function authorEmployeeMemoryScope");
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch\b/);
    expect(fn).not.toMatch(/\bthrow\b/);
    expect(fn).toMatch(/ok: false/);
    expect(fn).toMatch(/ok: true/);
  });
});

// =====================================================================
// 7. The admin action is superadmin-gated, audited, posture-safe.
// =====================================================================

describe("registry LR2 — the admin write path is gated, audited, posture-safe", () => {
  const code = codeOf(read(ACTIONS_REL));
  const action = fnSlice(code, "export async function authorAiEmployeeMemoryScope");

  it("re-checks the superadmin gate (defence-in-depth past the /admin layout)", () => {
    expect(action).toMatch(/requireAdmin\(\)/);
  });

  it("authors through the write module (the one atomic seam)", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/registry-authoring");
    expect(action).toMatch(/authorEmployeeMemoryScope\(/);
  });

  it("writes the immutable audit trail (admin_activity_log) for the authoring act", () => {
    expect(action).toMatch(/recordAdminActivity\(/);
    expect(action).toMatch(/ai_employee\.memory_scope_authored/);
  });

  it("never touches the execution lock (the action authors memory_scope only)", () => {
    expect(action).not.toMatch(/can_execute/i);
  });
});

// =====================================================================
// 8. LR2 boundary — NOTHING authorised-to-keep is removed.
//    (CEO do-not list: no legacy columns, no removing rollback, no removing
//     parity tooling / migration monitoring, no changing runtime authority.)
// =====================================================================

describe("registry LR2 — removes nothing authorised-to-keep", () => {
  it("the migration drops NO schema — no DROP / ALTER … DROP COLUMN anywhere", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|trigger)/i);
    expect(exec).not.toMatch(/alter table[\s\S]*?drop column/i);
  });

  it("keeps the R2 parity tooling + backfill in place (parity + monitoring NOT removed)", () => {
    expect(existsSync(resolve(ROOT, R2_REL))).toBe(true);
    expect(read(R2_REL)).toMatch(/hq_capability_registry_parity/);
  });

  it("keeps the R4 runtime authority switch + shadow parity in place (authority unchanged)", () => {
    const parity = codeOf(read(PARITY_REL));
    expect(parity).toMatch(/export async function resolveServedCapabilities/);
    expect(parity).toMatch(/export async function verifyRegistryParity/);
    // memory_scope is still SERVED from the legacy model — runtime resolution unchanged.
    expect(parity).toMatch(/emp\.memory_scope/);
  });

  it("keeps the LR1 token authoring path intact (LR2 is additive)", () => {
    expect(existsSync(resolve(ROOT, LR1_MIG_REL))).toBe(true);
    const code = codeOf(read(MODULE_REL));
    expect(code).toMatch(/export async function authorEmployeeCapabilities/);
    expect(code).toMatch(/export async function authorEmployeeMemoryScope/);
  });
});
