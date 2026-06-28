import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — R3 (runtime resolver + SDK read integration) security invariants.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rules: the Single Source of Authority Rule (13th §2 standard),
 * the Migration Parity Rule (14th), the Behaviour Preservation Rule (15th).
 *
 * R3 introduces the runtime resolver but, by the Behaviour Preservation Rule, changes NO
 * externally observable behaviour: the legacy model stays authoritative and is what's
 * served; the registry is consulted as a continuously-verified, FAIL-OPEN shadow. These
 * assertions pin — as a matter of SOURCE, not discipline — the facts that would be a hole
 * in that guarantee if they ever silently flipped:
 *   • the pure resolver is dependency-free (no client, no IO, no server-only) — so it can
 *     carry no request-path side effect of its own;
 *   • the server-only bridge reads the registry READ-ONLY and reuses the canonical legacy
 *     resolvers (so the legacy side of the comparison can never drift);
 *   • verifyRegistryParity is STRICTLY fail-open — it never throws and swallows every error;
 *   • the shadow NEVER feeds identity — the services still serve the legacy capabilities and
 *     never assign the registry result, never flip source to "registry" (that is R4).
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract (which names the
 * registry, "source", "registry", the R4 transition, etc.) can neither satisfy a positive
 * match nor trip a negative one.
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

const RESOLVER = "server/sdk/registry-resolver.ts";
const PARITY = "server/sdk/registry-parity.ts";
const RESEARCH = "server/services/hq-research.ts";
const QUALIFICATION = "server/services/hq-qualification.ts";
const SERVICES = [RESEARCH, QUALIFICATION] as const;

// =====================================================================
// 0. The R3 contract files ship.
// =====================================================================

describe("registry R3 — the resolver modules exist", () => {
  it("ships the pure resolver and the server-only parity bridge", () => {
    expect(existsSync(resolve(ROOT, RESOLVER)), RESOLVER).toBe(true);
    expect(existsSync(resolve(ROOT, PARITY)), PARITY).toBe(true);
  });
});

// =====================================================================
// 1. The pure resolver is PURE — dependency-free, no IO, no server-only.
// =====================================================================

describe("registry R3 — the resolver core is pure", () => {
  const code = codeOf(read(RESOLVER));

  it("imports NOTHING — no dependency graph, so no request-path side effect of its own", () => {
    expect(importSpecifiers(code)).toEqual([]);
  });

  it("contains no client, transport, or IO construct", () => {
    for (const forbidden of ["server-only", ".from(", ".rpc(", "fetch(", "createClient", "createAdminClient", "supabase"]) {
      expect(code, `pure resolver must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("encodes the Decision-5 law with the EXACT legacy normalisation (parity-load-bearing)", () => {
    // The two edges where the registry must match the legacy model byte-for-byte. A silent
    // flip here would manufacture (can_execute) or leak away (requires_approval) authority.
    expect(code).toMatch(/can_execute === true/); // DENY-WINS, literal-true only
    expect(code).toMatch(/requires_approval !== false/); // RATCHET, literal-false only
    expect(code).toMatch(/\.every\(/); // deny-wins is an AND across grants
    expect(code).toMatch(/\.some\(/); // the ratchet is an OR across grants
    expect(code).toMatch(/Math\.min\(/); // budget is the effective minimum
  });
});

// =====================================================================
// 2. The server-only bridge is fenced, reuses the legacy resolvers, READS only.
// =====================================================================

describe("registry R3 — the parity bridge is server-only and read-only", () => {
  const raw = read(PARITY);
  const code = codeOf(raw);

  it("is server-only fenced (it holds the service-role client)", () => {
    expect(code).toContain("server-only");
  });

  it("reuses the CANONICAL legacy resolvers, so the legacy side can never drift", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/tasks");
    expect(code).toMatch(/resolveEmployeeCapabilities/);
    expect(code).toMatch(/resolveEmployeePosture/);
  });

  it("composes via the pure law (it does not re-implement Decision 5)", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/registry-resolver");
    expect(code).toMatch(/composeGrants/);
    expect(code).toMatch(/applicableGrants/);
    expect(code).toMatch(/compareAuthority/);
  });

  it("reads the registry READ-ONLY — never writes the mirror, never writes the legacy source", () => {
    // The shadow must never mutate (the Migration Parity Rule: the mirror is never written
    // back; the legacy stays the single authoritative source). Only .select()/.or() appear.
    expect(code).toMatch(/\.select\(/);
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(code, `the bridge must not ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 3. verifyRegistryParity is STRICTLY fail-open (the Behaviour Preservation guarantee).
// =====================================================================

describe("registry R3 — the verification is strictly fail-open", () => {
  const code = codeOf(read(PARITY));
  // verifyRegistryParity is the last export in the module; its body runs to EOF.
  const verify = (() => {
    const start = code.indexOf("export async function verifyRegistryParity");
    expect(start, "verifyRegistryParity not found").toBeGreaterThanOrEqual(0);
    return code.slice(start);
  })();

  it("wraps its work in try/catch", () => {
    expect(verify).toMatch(/try\s*\{/);
    expect(verify).toMatch(/catch\b/);
  });

  it("swallows every error — the verification NEVER throws (legacy stays authoritative)", () => {
    expect(verify).not.toMatch(/\bthrow\b/);
  });

  it("the failure path is fail-open (returns a skipped/ok outcome, not a rejection)", () => {
    expect(verify).toMatch(/skipped:\s*true/);
    expect(verify).toMatch(/ok:\s*true/);
  });
});

// =====================================================================
// 4. The shadow NEVER feeds identity — the services preserve behaviour.
// =====================================================================

describe("registry R3 — the shadow does not change what is served", () => {
  for (const svc of SERVICES) {
    const code = codeOf(read(svc));

    it(`${svc}: still serves the LEGACY capabilities (authority unchanged)`, () => {
      expect(code).toMatch(/identity\.capabilities\s*=\s*resolveEmployeeCapabilities\(emp\)/);
    });

    it(`${svc}: consults the registry shadow, but only via the fail-open verify`, () => {
      expect(importSpecifiers(code)).toContain("@/server/sdk/registry-parity");
      expect(code).toMatch(/verifyRegistryParity\(emp\)/);
    });

    it(`${svc}: NEVER assigns the registry result into identity (no behavioural transition)`, () => {
      // The shadow is a bare statement; its outcome is never consumed. Serving authority
      // FROM the registry — assigning a registry result, flipping source — is R4.
      expect(code).not.toMatch(/=\s*await\s+verifyRegistryParity/);
      expect(code).not.toMatch(/=\s*verifyRegistryParity/);
      expect(code).not.toContain("resolveAuthorityFromRegistry");
      expect(code).not.toContain("composeGrants");
      expect(code).not.toContain('source: "registry"');
    });
  }
});

// =====================================================================
// 5. R3 boundary — no legacy removal, no R4 transition anywhere.
// =====================================================================

describe("registry R3 — stays inside the authorised slice", () => {
  it("the bridge does not flip the served source to 'registry' (that is the R4 transition)", () => {
    // The ONLY place source becomes "registry" is the resolver's own ResolvedAuthority
    // provenance (composeGrants). The bridge and services never serve it as the authority.
    expect(codeOf(read(PARITY))).not.toContain('source: "registry"');
  });

  it("keeps the legacy resolvers in place — it consumes them, it does not remove them", () => {
    // legacy authority remains the single authoritative source (the Single Source of
    // Authority Rule): the canonical resolvers are still imported and used everywhere.
    for (const svc of SERVICES) {
      expect(codeOf(read(svc))).toMatch(/resolveEmployeeCapabilities/);
    }
    expect(codeOf(read(PARITY))).toMatch(/resolveEmployeeCapabilities/);
  });
});
