import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR1 (Registry-Native Authoring) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 1. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel
 * Contract Map §2): the Single Source of Authority Rule (13th), the Migration
 * Parity Rule (14th), the Behaviour Preservation Rule (15th), the Shadow
 * Validation Rule (16th), the Rollback Readiness Rule (17th), and the Evidence
 * Before Deletion Rule (18th — LR1 removes NOTHING).
 *
 * LR1 gives the registry a NATIVE write path while keeping the legacy model mirrored.
 * CI has no database here (the live behaviour is proven in the integration tier), so —
 * like the R1/R2 suites — we pin the CONTRACT against source text. These are the facts
 * that, if they ever silently flipped, would be a hole in LR1's safety:
 *   • the write is ATOMIC + service-role only (one SECURITY DEFINER RPC, search_path
 *     pinned, EXECUTE revoked from every JWT role) — no app-layer dual write, no role
 *     can reach it but the service role behind the superadmin gate;
 *   • the legacy mirror is PARITY-FAITHFUL — the authored set is split by catalogue kind
 *     (scopes vs everything else) and its UNION is what the legacy model resolves, so
 *     parity is preserved by construction (the Migration Parity Rule);
 *   • POSTURE IS PRESERVED — the mutation path never writes can_execute / requires_approval
 *     (no execution unlock — Directive 001); a fresh grant is seeded from the legacy
 *     posture with the EXACT normalisation, so it is born in parity;
 *   • the write module authors EXCLUSIVELY through the RPC (never a direct table write)
 *     and never throws;
 *   • the admin action is superadmin-gated, audited, and likewise never touches the
 *     execution lock;
 *   • NOTHING authorised-to-keep is removed — no legacy column dropped, the R2 parity
 *     tooling + the R4 switch remain (each later removal increment is separately authorised
 *     under the Evidence Before Deletion Rule; LR5.3 since retired the rollback control).
 *
 * Comment text (SQL line comments and TS block/line comments) is stripped first, so
 * the prose that DOCUMENTS the contract can neither satisfy a positive match nor trip
 * a negative one.
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

const MIG_REL = "supabase/migrations/20260808000000_capability_registry_native_authoring.sql";
const MODULE_REL = "server/sdk/registry-authoring.ts";
const ACTIONS_REL = "app/admin/ai-boardroom/actions.ts";
const PARITY_REL = "server/sdk/registry-parity.ts";
const R2_REL = "supabase/migrations/20260807000000_capability_registry_backfill.sql";

const exec = stripSql(read(MIG_REL));

/** The body of the authoring function (signature → first `$$;`). */
function authorFn(): string {
  const start = exec.indexOf(
    "create or replace function public.hq_author_employee_capabilities(",
  );
  expect(start, "authoring function not found").toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, "authoring function body not found").toBeGreaterThan(start);
  return exec.slice(start, end);
}

// =====================================================================
// 0. The contract files ship.
// =====================================================================

describe("registry LR1 — the authoring surface ships", () => {
  it("ships the migration, the write module, and is sequenced after R1/R2", () => {
    expect(existsSync(resolve(ROOT, MIG_REL)), MIG_REL).toBe(true);
    expect(existsSync(resolve(ROOT, MODULE_REL)), MODULE_REL).toBe(true);
    // R1 = …806, R2 = …807, LR1 = …808 — the schema + backfill exist before authoring.
    expect(MIG_REL).toMatch(/20260808000000_capability_registry_native_authoring\.sql$/);
    expect(existsSync(resolve(ROOT, "supabase/migrations/20260806000000_capability_registry.sql"))).toBe(true);
    expect(existsSync(resolve(ROOT, R2_REL))).toBe(true);
  });
});

// =====================================================================
// 1. The write is ATOMIC + service-role only (one SECURITY DEFINER RPC).
// =====================================================================

describe("registry LR1 — atomic, service-role-only authoring RPC", () => {
  it("is a SECURITY DEFINER function with a pinned empty search_path", () => {
    const body = authorFn();
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = ''/i);
  });

  it("locks EXECUTE down to service_role (revoked from every JWT role)", () => {
    expect(exec).toMatch(/revoke all on function public\.hq_author_employee_capabilities/i);
    expect(exec).toMatch(/from public, anon, authenticated/i);
    expect(exec).toMatch(/grant execute on function public\.hq_author_employee_capabilities/i);
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
// 2. The registry write — define tokens, upsert the grant TOKENS-ONLY.
// =====================================================================

describe("registry LR1 — defines tokens then authors the grant", () => {
  const body = authorFn();

  it("DEFINES requested tokens in the catalogue, idempotently", () => {
    expect(body).toMatch(/insert into public\.hq_capabilities/i);
    expect(body).toMatch(/on conflict \(token\) do nothing/i);
  });

  it("normalises the requested set to sorted-distinct (the grant's stored normal form)", () => {
    expect(body).toMatch(/array_agg\(distinct t order by t\)/i);
  });

  it("authors the EMPLOYEE scope only — never factors authority UP a scope level", () => {
    // Authoring writes the subject's own grant; a global/org/department write would
    // grant authority the legacy model never gave and break parity.
    expect(body).toMatch(/scope_level = 'employee' and scope_key = p_slug/i);
    expect(body).not.toMatch(/scope_level = 'global'/i);
    expect(body).not.toMatch(/scope_level = 'organization'/i);
    expect(body).not.toMatch(/scope_level = 'department'/i);
  });

  it("UPSERTS the grant TOKENS-ONLY — the update path sets only tokens", () => {
    expect(body).toMatch(/update public\.hq_capability_grants\s+set tokens = v_tokens/i);
  });
});

// =====================================================================
// 3. POSTURE IS PRESERVED — no execution unlock anywhere (Directive 001).
// =====================================================================

describe("registry LR1 — posture is preserved (no execution unlock)", () => {
  it("NEVER updates posture — no `set can_execute` / `set requires_approval` in the migration", () => {
    // Posture is only ever set via the column list of a FRESH grant insert (below),
    // never mutated on an existing grant or on the legacy mirror.
    expect(exec).not.toMatch(/set\s+can_execute/i);
    expect(exec).not.toMatch(/set\s+requires_approval/i);
  });

  it("a FRESH grant is seeded from the legacy posture with the EXACT normalisation", () => {
    const body = authorFn();
    // can_execute === true → literal-true only; requires_approval !== false → ratchet.
    expect(body).toMatch(/\(v_permissions\s*->\s*'can_execute'\)\s*=\s*'true'::jsonb/i);
    expect(body).toMatch(/\(v_permissions\s*->\s*'requires_approval'\)\s+is distinct from\s+'false'::jsonb/i);
  });
});

// =====================================================================
// 4. The legacy mirror is PARITY-FAITHFUL — split by kind, posture untouched.
// =====================================================================

describe("registry LR1 — parity-faithful legacy mirror", () => {
  const body = authorFn();

  it("splits the authored set by catalogue KIND (scopes vs everything else)", () => {
    // The two halves PARTITION the authored set, so their UNION === the grant tokens.
    expect(body).toMatch(/filter \(where c\.kind <> 'scope'\)/i);
    expect(body).toMatch(/filter \(where c\.kind\s*=\s*'scope'\)/i);
  });

  it("mirrors BACK to the legacy ai_employees columns (continued dual write)", () => {
    expect(body).toMatch(/update public\.ai_employees/i);
    expect(body).toMatch(/tools_allowed = v_tool_tokens/i);
    expect(body).toMatch(/jsonb_build_object\(\s*'scopes',\s*to_jsonb\(v_scope_tokens\)/i);
  });

  it("MERGES permissions (`||`) so can_execute / requires_approval survive the mirror", () => {
    expect(body).toMatch(/permissions\s*=\s*coalesce\(permissions, '\{\}'::jsonb\)\s*\|\|/i);
  });
});

// =====================================================================
// 5. The write module authors EXCLUSIVELY through the RPC, never throws.
// =====================================================================

describe("registry LR1 — the write module is fenced and RPC-only", () => {
  const code = codeOf(read(MODULE_REL));

  it("is server-only fenced (it holds the service-role client)", () => {
    expect(code).toContain("server-only");
  });

  it("authors EXCLUSIVELY through the atomic RPC — no direct table write", () => {
    // The .rpc().bind() idiom the HQ services use (event-spine.ts), targeting the
    // single atomic authoring entry point — never a .from()/.insert()/.update().
    expect(code).toMatch(/\.rpc\.bind\(/);
    expect(code).toMatch(/hq_author_employee_capabilities/);
    for (const forbidden of [".from(", ".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(code, `the write module must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is STRICTLY non-throwing (returns a discriminated result, never rejects)", () => {
    expect(code).toMatch(/try\s*\{/);
    expect(code).toMatch(/catch\b/);
    expect(code).not.toMatch(/\bthrow\b/);
    expect(code).toMatch(/ok: false/);
    expect(code).toMatch(/ok: true/);
  });
});

// =====================================================================
// 6. The admin action is superadmin-gated, audited, posture-safe.
// =====================================================================

describe("registry LR1 — the admin write path is gated, audited, posture-safe", () => {
  const code = codeOf(read(ACTIONS_REL));
  const action = (() => {
    const start = code.indexOf("export async function authorAiEmployeeCapabilities");
    expect(start, "authorAiEmployeeCapabilities action not found").toBeGreaterThanOrEqual(0);
    return code.slice(start);
  })();

  it("re-checks the superadmin gate (defence-in-depth past the /admin layout)", () => {
    expect(action).toMatch(/requireAdmin\(\)/);
  });

  it("authors through the write module (the one atomic seam)", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/registry-authoring");
    expect(action).toMatch(/authorEmployeeCapabilities\(/);
  });

  it("writes the immutable audit trail (admin_activity_log) for the authoring act", () => {
    expect(action).toMatch(/recordAdminActivity\(/);
    expect(action).toMatch(/ai_employee\.capabilities_authored/);
  });

  it("never touches the execution lock (the action authors the token SET only)", () => {
    expect(action).not.toMatch(/can_execute/i);
  });
});

// =====================================================================
// 7. LR1 boundary — NOTHING authorised-to-keep is removed.
//    (CEO do-not list: no legacy columns, no stopping parity, no retiring
//     rollback, no changing runtime authority, no deleting migration tooling.)
// =====================================================================

describe("registry LR1 — removes nothing (Evidence Before Deletion Rule)", () => {
  it("the migration drops NO schema — no DROP / ALTER … DROP COLUMN anywhere", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|trigger)/i);
    expect(exec).not.toMatch(/alter table[\s\S]*?drop column/i);
  });

  it("keeps the R2 parity tooling in place (parity verification NOT stopped)", () => {
    expect(existsSync(resolve(ROOT, R2_REL))).toBe(true);
    expect(read(R2_REL)).toMatch(/hq_capability_registry_parity/);
  });

  it("keeps the R4 runtime authority switch in place; the shadow parity is retired (LR5.4B)", () => {
    const parity = codeOf(read(PARITY_REL));
    expect(parity).toMatch(/export async function resolveServedCapabilities/);
    // LR1 itself removed nothing. The shadow-parity verification (verifyRegistryParity) was SINCE
    // retired by LR5.4B (the Data Removal Rule, 26th): with the legacy authority columns gone there
    // is no baseline left to compare the registry against, so the comparator no longer exists.
    expect(parity).not.toMatch(/verifyRegistryParity/);
  });
});
