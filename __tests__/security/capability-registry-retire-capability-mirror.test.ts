import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR5.1 (Retire the Capability Mirror) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 5.1. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel
 * Contract Map §2): the Single Source of Authority Rule (13th), the Behaviour
 * Preservation Rule (15th), the Rollback Readiness Rule (17th), the Evidence Before
 * Deletion Rule (18th), the Retirement Readiness Rule (22nd — this increment runs only
 * after the readiness gate was met) and — first and foremost — the **Removal Sequencing
 * Rule (23rd): "first remove writes."** LR5.1 is that first step.
 *
 * LR1 (the immutable 808) gave the registry a native write path while keeping the legacy
 * model mirrored; LR5.1 REDEFINES that RPC to STOP writing the mirror, so
 * ai_employees.tools_allowed / permissions go INERT (frozen at their last value, written by
 * nothing, still readable). CI has no database here (the live behaviour is proven in the
 * integration tier), so — like the R1/R2/LR1 suites — we pin the CONTRACT against source
 * text. These are the facts that, if they ever silently flipped, would be a hole in LR5.1's
 * safety:
 *   • the AUTHORITATIVE write is UNCHANGED — still one ATOMIC, service-role-only
 *     SECURITY DEFINER RPC (search_path pinned, EXECUTE revoked from every JWT role) that
 *     defines tokens and upserts the EMPLOYEE-scoped grant TOKENS-ONLY;
 *   • POSTURE IS PRESERVED — the path never writes can_execute / requires_approval, and a
 *     fresh grant is still seeded from the legacy posture with the EXACT normalisation;
 *   • THE MIRROR IS RETIRED — the body writes NOTHING back to ai_employees (no
 *     `update ai_employees`, no `tools_allowed =`, no permissions merge); yet it STILL
 *     computes the parity-faithful kind split and STILL reports it in the return envelope
 *     (the split backs the admin activity log, it is simply no longer written to a column);
 *   • NOTHING ELSE authorised-to-keep is removed — no legacy column dropped; the LR1 mirror
 *     stays pinned in the IMMUTABLE 808; the memory_scope mirror (809), the R2 parity
 *     tooling, the R4 runtime switch, the rollback control and the confidence audit all
 *     remain (each later removal increment is separately authorised under the Removal
 *     Sequencing Rule — "then remove rollback … then remove stored legacy data").
 *
 * Comment text (SQL line comments and TS block/line comments) is stripped first, so the
 * prose that DOCUMENTS the contract can neither satisfy a positive match nor trip a
 * negative one (LR5.1's header, for instance, NAMES the mirror it removes).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
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

const MIG_REL = "supabase/migrations/20260810000000_capability_registry_retire_capability_mirror.sql";
const LR1_MIG_REL = "supabase/migrations/20260808000000_capability_registry_native_authoring.sql";
const MEMSCOPE_MIG_REL = "supabase/migrations/20260809000000_capability_registry_native_memory_scope.sql";
const R2_REL = "supabase/migrations/20260807000000_capability_registry_backfill.sql";
const PARITY_REL = "server/sdk/registry-parity.ts";
const CONFIDENCE_REL = "server/sdk/registry-confidence.ts";
const ENV_REL = "lib/env.ts";

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
// 0. The contract ships, sequenced AFTER LR1.
// =====================================================================

describe("registry LR5.1 — the mirror-retirement migration ships", () => {
  it("ships the migration and is sequenced after LR1 (808) and the memory_scope mirror (809)", () => {
    expect(existsSync(resolve(ROOT, MIG_REL)), MIG_REL).toBe(true);
    expect(MIG_REL).toMatch(/20260810000000_capability_registry_retire_capability_mirror\.sql$/);
    // LR1 = …808, memory_scope mirror = …809, LR5.1 = …810 — the write path it redefines
    // (and the sibling mirror it deliberately leaves alone) exist before it.
    expect(existsSync(resolve(ROOT, LR1_MIG_REL))).toBe(true);
    expect(existsSync(resolve(ROOT, MEMSCOPE_MIG_REL))).toBe(true);
  });

  it("redefines the SAME authoring entry point (create or replace, not a new function)", () => {
    expect(exec).toMatch(/create or replace function public\.hq_author_employee_capabilities\(/i);
  });
});

// =====================================================================
// 1. The write is STILL atomic + service-role only (security posture unchanged).
// =====================================================================

describe("registry LR5.1 — atomic, service-role-only authoring RPC (unchanged)", () => {
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
// 2. The AUTHORITATIVE registry write is PRESERVED.
// =====================================================================

describe("registry LR5.1 — the authoritative grant write is preserved", () => {
  const body = authorFn();

  it("STILL defines requested tokens in the catalogue, idempotently", () => {
    expect(body).toMatch(/insert into public\.hq_capabilities/i);
    expect(body).toMatch(/on conflict \(token\) do nothing/i);
  });

  it("STILL normalises the requested set to sorted-distinct (the grant's stored normal form)", () => {
    expect(body).toMatch(/array_agg\(distinct t order by t\)/i);
  });

  it("STILL authors the EMPLOYEE scope only — never factors authority UP a scope level", () => {
    expect(body).toMatch(/scope_level = 'employee' and scope_key = p_slug/i);
    expect(body).not.toMatch(/scope_level = 'global'/i);
    expect(body).not.toMatch(/scope_level = 'organization'/i);
    expect(body).not.toMatch(/scope_level = 'department'/i);
  });

  it("STILL upserts the grant TOKENS-ONLY — the update path sets only tokens", () => {
    expect(body).toMatch(/update public\.hq_capability_grants\s+set tokens = v_tokens/i);
  });
});

// =====================================================================
// 3. POSTURE IS PRESERVED — no execution unlock anywhere (Directive 001).
// =====================================================================

describe("registry LR5.1 — posture is preserved (no execution unlock)", () => {
  it("NEVER updates posture — no `set can_execute` / `set requires_approval` in the migration", () => {
    expect(exec).not.toMatch(/set\s+can_execute/i);
    expect(exec).not.toMatch(/set\s+requires_approval/i);
  });

  it("STILL reads the legacy posture to seed a FRESH grant (legacy read preserved)", () => {
    const body = authorFn();
    // The subject is still resolved, and permissions + memory_scope are still read to seed
    // a brand-new grant's posture — the CEO's "preserve legacy reads" instruction.
    expect(body).toMatch(/select permissions, memory_scope[\s\S]*?from public\.ai_employees/i);
  });

  it("a FRESH grant is still seeded from the legacy posture with the EXACT normalisation", () => {
    const body = authorFn();
    expect(body).toMatch(/\(v_permissions\s*->\s*'can_execute'\)\s*=\s*'true'::jsonb/i);
    expect(body).toMatch(/\(v_permissions\s*->\s*'requires_approval'\)\s+is distinct from\s+'false'::jsonb/i);
  });
});

// =====================================================================
// 4. THE MIRROR IS RETIRED — no write-back to ai_employees, but the split
//    is STILL computed and STILL reported in the return envelope.
//    (The Removal Sequencing Rule, 23rd: "first remove writes.")
// =====================================================================

describe("registry LR5.1 — the legacy mirror is retired", () => {
  const body = authorFn();

  it("writes NOTHING back to ai_employees — the mirror UPDATE is GONE", () => {
    // The LR1 mirror was `update public.ai_employees set tools_allowed = …, permissions = …`.
    // LR5.1 removes it wholesale: the body no longer writes the legacy columns at all.
    expect(body).not.toMatch(/update public\.ai_employees/i);
    expect(body).not.toMatch(/tools_allowed\s*=\s*v_tool_tokens/i);
    expect(body).not.toMatch(/permissions\s*=\s*coalesce\(permissions, '\{\}'::jsonb\)\s*\|\|/i);
    expect(body).not.toMatch(/jsonb_build_object\(\s*'scopes',\s*to_jsonb\(v_scope_tokens\)/i);
  });

  it("STILL computes the parity-faithful kind split (it backs the return envelope)", () => {
    // The split is no longer mirrored to a column, but it is still computed — the admin
    // activity log records it via the envelope (below).
    expect(body).toMatch(/filter \(where c\.kind <> 'scope'\)/i);
    expect(body).toMatch(/filter \(where c\.kind\s*=\s*'scope'\)/i);
  });

  it("STILL reports the split in the success envelope (tools_allowed + scopes)", () => {
    expect(body).toMatch(/'tools_allowed',\s*to_jsonb\(v_tool_tokens\)/i);
    expect(body).toMatch(/'scopes',\s*to_jsonb\(v_scope_tokens\)/i);
  });
});

// =====================================================================
// 5. LR5.1 boundary — NOTHING ELSE authorised-to-keep is removed.
//    (CEO do-not list: no legacy column, no memory_scope mirror, no legacy
//     read helpers, no rollback, no confidence audit, no parity tooling,
//     no migration history.)
// =====================================================================

describe("registry LR5.1 — removes nothing else (the Removal Sequencing Rule)", () => {
  it("drops NO schema — no DROP / ALTER … DROP COLUMN anywhere (columns retained, now inert)", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|trigger)/i);
    expect(exec).not.toMatch(/alter table[\s\S]*?drop column/i);
  });

  it("leaves the LR1 mirror PINNED in the immutable 808 (migration history retained)", () => {
    // The history is forward-only: 808 still SHOWS the mirror it once wrote. LR5.1 supersedes
    // it with a `create or replace`, it does not rewrite the past.
    const lr1 = stripSql(read(LR1_MIG_REL));
    expect(lr1).toMatch(/update public\.ai_employees/i);
    expect(lr1).toMatch(/tools_allowed = v_tool_tokens/i);
  });

  it("keeps the MEMORY-SCOPE mirror in place (809 untouched — shared data still mirrored)", () => {
    const mem = stripSql(read(MEMSCOPE_MIG_REL));
    expect(mem).toMatch(/create or replace function public\.hq_author_employee_memory_scope/i);
    expect(mem).toMatch(/update public\.ai_employees/i);
    expect(mem).toMatch(/set memory_scope = p_memory_scope/i);
  });

  it("keeps the R2 parity tooling in place (parity verification NOT stopped)", () => {
    expect(existsSync(resolve(ROOT, R2_REL))).toBe(true);
    expect(read(R2_REL)).toMatch(/hq_capability_registry_parity/);
  });

  it("keeps the R4 runtime authority switch + shadow parity in place (authority unchanged)", () => {
    const parity = codeOf(read(PARITY_REL));
    expect(parity).toMatch(/export async function resolveServedCapabilities/);
    expect(parity).toMatch(/export async function verifyRegistryParity/);
  });

  it("keeps the confidence audit in place (the §4 instrument NOT removed)", () => {
    const confidence = codeOf(read(CONFIDENCE_REL));
    expect(confidence).toMatch(/export async function auditRegistryConfidence/);
  });

  it("keeps the rollback control in place (rollback NOT retired — that is the 2nd step)", () => {
    const env = codeOf(read(ENV_REL));
    expect(env).toMatch(/CAPABILITY_AUTHORITY_SOURCE/);
    expect(env).toMatch(/z\.enum\(\["registry",\s*"legacy"\]\)\.default\("registry"\)/);
  });
});
