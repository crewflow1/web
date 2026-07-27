import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR4 (the production-confidence audit) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 4. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing rules: the Rollback Readiness
 * Rule (17th §2 standard), the Shadow Validation Rule (16th), and the **Compatibility Layer
 * Rule** (21st — set on the LR3 review), whose "measurable exit criteria" and "continuous
 * parity validation" attributes this instrument makes concrete. It implements the Legacy
 * Removal Proposal's **C4 — "Bank production confidence"** increment, which gates EVERY
 * removal increment (C5+).
 *
 * The unit tier proves the PURE confidence law (classify + summarize); the integration tier
 * proves the sweep against live Postgres. This tier pins — as a matter of SOURCE, not
 * discipline — the safety invariants of the off-path instrument, the ones that would be a
 * hole if they ever silently flipped:
 *   • it is server-only fenced (it holds the service-role admin client);
 *   • it is STRICTLY READ-ONLY — it never writes the grants, the mirror, or the legacy
 *     columns: you must NEVER mutate authority while measuring it (this is the load-bearing
 *     property — a confidence instrument that could alter authority would corrupt the very
 *     evidence it gathers, and could weaken the compatibility layer LR4 must keep intact);
 *   • it DELEGATES to the pure law and the canonical bridge — it re-implements neither the
 *     serving decision nor the legacy resolution, so the audit's verdict can never drift from
 *     what the runtime actually serves;
 *   • a per-employee registry read failure is CAUGHT (a measured `registry-error` signal),
 *     never an abort of the sweep;
 *   • it REMOVES NOTHING — legacy resolvers and the parity verification are untouched
 *     (removal is a later, separately-authorised phase; LR5.3 since retired the rollback
 *     control, leaving the automatic fail-safe and this audit intact).
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract can neither
 * satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
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

const CONFIDENCE = "server/sdk/registry-confidence.ts";
const RESOLVER = "server/sdk/registry-resolver.ts";
const PARITY = "server/sdk/registry-parity.ts";

// =====================================================================
// 0. The instrument ships.
// =====================================================================

describe("registry LR4 — the production-confidence audit exists", () => {
  it("ships the confidence-audit module", () => {
    expect(existsSync(resolve(ROOT, CONFIDENCE)), CONFIDENCE).toBe(true);
  });
});

// =====================================================================
// 1. Server-only fenced and STRICTLY READ-ONLY (never mutates authority).
// =====================================================================

describe("registry LR4 — the audit is server-only and read-only", () => {
  const code = codeOf(read(CONFIDENCE));

  it("is server-only fenced (it holds the service-role client)", () => {
    expect(code).toContain("server-only");
  });

  it("NEVER writes — no insert/update/delete/upsert (you must not mutate authority while measuring it)", () => {
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(code, `the confidence audit must not ${forbidden} — it is read-only`).not.toContain(
        forbidden,
      );
    }
  });

  it("reads only via .select() (the roster); the grant read is delegated to the bridge", () => {
    expect(code).toMatch(/\.select\(/);
  });

  it("exposes the audit as a function (the runnable instrument), not a write surface", () => {
    expect(code).toMatch(/export async function auditRegistryConfidence/);
  });
});

// =====================================================================
// 2. Delegates to the PURE law and the canonical bridge — never re-derives.
// =====================================================================

describe("registry LR4 — the audit delegates, never re-implements", () => {
  const code = codeOf(read(CONFIDENCE));
  const specs = importSpecifiers(code);

  it("classifies + aggregates via the PURE confidence law (no re-implemented fold)", () => {
    expect(specs).toContain("@/server/sdk/registry-resolver");
    expect(code).toMatch(/classifyServingConfidence\(/);
    expect(code).toMatch(/summarizeConfidence\(/);
  });

  it("measures the SAME serving decision the runtime serves (the audit can't drift from the serve path)", () => {
    expect(code).toMatch(/decideServedAuthority\(/);
  });

  it("reuses the canonical bridge for the registry read (no legacy baseline — LR5.4B)", () => {
    expect(specs).toContain("@/server/sdk/registry-parity");
    expect(code).toMatch(/resolveAuthorityFromRegistry\(/);
    // LR5.4B (the Data Removal Rule, 26th) removed the legacy authority columns, so there is no
    // legacy baseline to read: the audit measures registry serving HEALTH, not a shadow comparison.
    expect(code).not.toMatch(/legacyAuthorityOf\(/);
  });

  it("NO LONGER reads a rollback control (LR5.3 — it measures the registry-only serve path)", () => {
    // With the operator lever retired, the audit no longer imports env or reads an authority
    // source; it measures the ONE decision the runtime now serves, unconditionally.
    expect(specs).not.toContain("@/lib/env");
    expect(code).not.toMatch(/env\.CAPABILITY_AUTHORITY_SOURCE/);
  });
});

// =====================================================================
// 3. A per-employee registry read failure is a MEASURED signal, not an abort.
// =====================================================================

describe("registry LR4 — a registry read failure is measured, never fatal to the sweep", () => {
  const code = codeOf(read(CONFIDENCE));

  it("wraps the per-employee registry read in try/catch (failure → a classified outcome)", () => {
    expect(code).toMatch(/try\s*\{/);
    expect(code).toMatch(/catch\b/);
    // The caught failure degrades to a null registry, which the pure law classifies as the
    // `error` fail-safe — i.e. it becomes evidence, not an exception.
    expect(code).toMatch(/registry\s*=\s*null/);
  });
});

// =====================================================================
// 4. LR4 → LR5.4B boundary. LR4 itself REMOVED NOTHING (it only measures). LR5.4B (the Data
//    Removal Rule, 26th) has SINCE removed the legacy resolvers, the legacy fail-safe and the
//    shadow-parity comparator — the registry is the SOLE authority, the fail-safe is the
//    default-deny FLOOR. The §4 instrument and its PURE law are retained (preserved evidence).
// =====================================================================

describe("registry LR4 — the §4 instrument survives; the legacy machinery is removed (LR5.4B)", () => {
  it("the legacy resolvers are removed (LR5.4B — the registry is the SOLE authority)", () => {
    const tasks = codeOf(read("server/sdk/tasks.ts"));
    expect(tasks).not.toMatch(/resolveEmployeeCapabilities/);
    expect(tasks).not.toMatch(/resolveEmployeePosture/);
  });

  it("the shadow-parity comparator AND the legacy fail-safe are removed from the bridge (LR5.4B)", () => {
    const parity = codeOf(read(PARITY));
    expect(parity).not.toMatch(/verifyRegistryParity/);
    expect(parity).not.toMatch(/legacyServedAuthority/);
    // The fail-safe is now the default-deny FLOOR, not a legacy model.
    expect(parity).toMatch(/source: "floor"/);
  });

  it("the pure resolver still hosts the confidence law as PURE (no IO leaked into the core)", () => {
    const resolver = codeOf(read(RESOLVER));
    expect(resolver).toMatch(/export function classifyServingConfidence/);
    expect(resolver).toMatch(/export function summarizeConfidence/);
    // The pure core stays import-free (the confidence law added no dependency graph).
    expect(importSpecifiers(resolver)).toEqual([]);
  });
});
