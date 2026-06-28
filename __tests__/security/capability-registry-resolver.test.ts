import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — R3 + R4 + LR3 (runtime resolver + the authority SWITCH) security
 * invariants.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rules: the Single Source of Authority Rule (13th §2 standard),
 * the Migration Parity Rule (14th), the Behaviour Preservation Rule (15th), the Shadow
 * Validation Rule (16th), and the Registry Completeness Rule (20th — whose SERVING clause
 * LR3 advances).
 *
 * R3 stood the registry up as a continuously-verified, FAIL-OPEN shadow (the legacy model
 * stayed authoritative and was served). R4 performed the authorised SWITCH for TOKENS: the
 * registry became the authoritative source of an employee's served capabilities. LR3 extends
 * that switch to EVERY authority dimension — posture and memory scope, the last runtime reads
 * R4 left on the legacy model — so the identity now serves tokens, posture AND memory scope
 * from the registry, with the legacy model RETAINED as the rollback / fail-safe path. These
 * assertions pin — as a matter of SOURCE, not discipline — the facts that would be a hole in
 * the switch's safety if they ever silently flipped:
 *   • the pure resolver is dependency-free (no client, no IO, no server-only) — both the
 *     composition law AND the serving decision law carry no request-path side effect;
 *   • the server-only bridge reads the registry READ-ONLY and reuses the canonical legacy
 *     resolvers (so the legacy side of the comparison, and the fallback, can never drift);
 *   • verifyRegistryParity stays STRICTLY fail-open (RETAINED through R4 + LR3);
 *   • resolveServedAuthority — the switch — serves EVERY dimension (tokens, posture, memory
 *     scope) from the registry but is STRICTLY non-throwing and ALWAYS falls back to the
 *     retained legacy model (it can never strand an employee), and is gated by the rollback
 *     control; resolveServedCapabilities is RETAINED as its tokens-only projection;
 *   • the services now serve the FULL SWITCH (assign capabilities + posture + memory scope),
 *     no longer the bare legacy resolver — this is the authorised behavioural transition;
 *   • NOTHING is removed — the legacy resolvers, the parity verification, and the rollback
 *     control are all present (legacy removal is a later, separately-authorised phase).
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

const RESOLVER = "server/sdk/registry-resolver.ts";
const PARITY = "server/sdk/registry-parity.ts";
const TASKS = "server/sdk/tasks.ts";
const ENV = "lib/env.ts";
const RESEARCH = "server/services/hq-research.ts";
const QUALIFICATION = "server/services/hq-qualification.ts";
const SERVICES = [RESEARCH, QUALIFICATION] as const;

// =====================================================================
// 0. The contract files ship.
// =====================================================================

describe("registry R3+R4 — the resolver modules exist", () => {
  it("ships the pure resolver and the server-only authority bridge", () => {
    expect(existsSync(resolve(ROOT, RESOLVER)), RESOLVER).toBe(true);
    expect(existsSync(resolve(ROOT, PARITY)), PARITY).toBe(true);
  });
});

// =====================================================================
// 1. The pure resolver is PURE — dependency-free, no IO, no server-only.
//    Both the composition law AND the R4 serving-decision law live here.
// =====================================================================

describe("registry R3+R4 — the resolver core is pure", () => {
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

  it("encodes the R4 serving-decision law purely, folding in the parity comparison", () => {
    expect(code).toMatch(/export function decideServedAuthority/);
    // The serving law reuses the pure comparison — the continuous shadow verification is
    // computed from the same module, never re-implemented and never via IO.
    expect(code).toMatch(/compareAuthority\(/);
    // It is deny-safe: every non-registry branch resolves to the legacy basis, with a
    // named reason; the registry is served only when it actually spoke.
    expect(code).toMatch(/basis: "registry"/);
    expect(code).toMatch(/basis: "legacy"/);
    for (const reason of ['"rollback"', '"error"', '"empty"']) {
      expect(code, `the serving law must name the ${reason} fallback`).toContain(reason);
    }
  });
});

// =====================================================================
// 2. The server-only bridge is fenced, reuses the legacy resolvers, READS only.
// =====================================================================

describe("registry R3+R4 — the bridge is server-only and read-only", () => {
  const code = codeOf(read(PARITY));

  it("is server-only fenced (it holds the service-role client)", () => {
    expect(code).toContain("server-only");
  });

  it("reuses the CANONICAL legacy resolvers, so the legacy side can never drift", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/tasks");
    expect(code).toMatch(/resolveEmployeeCapabilities/);
    expect(code).toMatch(/resolveEmployeePosture/);
  });

  it("composes via the pure law (it does not re-implement Decision 5 or the switch)", () => {
    expect(importSpecifiers(code)).toContain("@/server/sdk/registry-resolver");
    expect(code).toMatch(/composeGrants/);
    expect(code).toMatch(/applicableGrants/);
    expect(code).toMatch(/compareAuthority/);
    expect(code).toMatch(/decideServedAuthority/);
  });

  it("reads the registry READ-ONLY — never writes the mirror, never writes the legacy source", () => {
    // The Migration Parity Rule: the mirror is never written back; the legacy stays the
    // single authoritative SOURCE-of-record. Only .select()/.or() appear.
    expect(code).toMatch(/\.select\(/);
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(code, `the bridge must not ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 3. verifyRegistryParity is STRICTLY fail-open — RETAINED through R4.
// =====================================================================

describe("registry R3+R4 — the standalone parity gate stays fail-open", () => {
  const code = codeOf(read(PARITY));
  // verifyRegistryParity sits before the ServedAuthority switch; slice up to it.
  const verify = (() => {
    const start = code.indexOf("export async function verifyRegistryParity");
    expect(start, "verifyRegistryParity not found (must be RETAINED through R4 + LR3)").toBeGreaterThanOrEqual(0);
    const end = code.indexOf("export interface ServedAuthority", start);
    return end > start ? code.slice(start, end) : code.slice(start);
  })();

  it("wraps its work in try/catch", () => {
    expect(verify).toMatch(/try\s*\{/);
    expect(verify).toMatch(/catch\b/);
  });

  it("swallows every error — the verification NEVER throws", () => {
    expect(verify).not.toMatch(/\bthrow\b/);
  });

  it("the failure path is fail-open (returns a skipped/ok outcome, not a rejection)", () => {
    expect(verify).toMatch(/skipped:\s*true/);
    expect(verify).toMatch(/ok:\s*true/);
  });
});

// =====================================================================
// 4. resolveServedAuthority — the LR3 switch: registry authoritative on
//    EVERY dimension (tokens, posture, memory scope), legacy retained,
//    never throws, gated by the rollback control. resolveServedCapabilities
//    is RETAINED as its tokens-only projection.
// =====================================================================

describe("registry LR3 — the authority switch serves EVERY dimension, retains legacy", () => {
  const code = codeOf(read(PARITY));
  // The full switch slice: from resolveServedAuthority up to its capabilities projection.
  const serve = (() => {
    const start = code.indexOf("export async function resolveServedAuthority");
    expect(start, "resolveServedAuthority not found (the LR3 full switch)").toBeGreaterThanOrEqual(0);
    const end = code.indexOf("export async function resolveServedCapabilities", start);
    return end > start ? code.slice(start, end) : code.slice(start);
  })();

  it("serves the registry's TOKENS as authoritative (the R4 dimension, carried into LR3)", () => {
    // The switch returns the registry's tokens AND its provenance — `source` flips to
    // "registry" (composeGrants stamps it).
    expect(serve).toMatch(/tokens: registry\.tokens/);
    expect(serve).toMatch(/source: registry\.source/);
  });

  it("serves the registry's POSTURE as authoritative (the LR3 dimension — the doorman's layer 1)", () => {
    // The execution lock now flows from the registry: a silent flip here would let the gate's
    // deny-by-default floor be sourced from the wrong place.
    expect(serve).toMatch(/canExecute: registry\.canExecute/);
    expect(serve).toMatch(/requiresApproval: registry\.requiresApproval/);
  });

  it("serves the registry's MEMORY SCOPE as authoritative (the LR3 dimension), coerced to the vocabulary", () => {
    expect(serve).toMatch(/memoryScope: coerceMemoryScope\(registry\.memoryScope\)/);
  });

  it("delegates the choice to the PURE decision law (no re-implemented switch logic)", () => {
    expect(serve).toMatch(/decideServedAuthority\(/);
  });

  it("is gated by the rollback control (the env-backed authority source)", () => {
    expect(importSpecifiers(code)).toContain("@/lib/env");
    expect(serve).toMatch(/env\.CAPABILITY_AUTHORITY_SOURCE/);
  });

  it("RETAINS the legacy model as the fallback — it can never strand an employee", () => {
    // Every non-registry branch returns the legacy SERVED set, built from the canonical legacy
    // resolvers (so the fallback can never drift from what the runtime enforces today).
    expect(serve).toMatch(/legacyServedAuthority\(emp\)/);
    expect(serve).toMatch(/return legacy\b/);
  });

  it("is STRICTLY non-throwing (the switch fails SAFE to legacy, never to an error)", () => {
    expect(serve).toMatch(/try\s*\{/);
    expect(serve).toMatch(/catch\b/);
    expect(serve).not.toMatch(/\bthrow\b/);
  });

  it("RETAINS resolveServedCapabilities as the tokens-only projection of the full switch", () => {
    const shim = code.slice(code.indexOf("export async function resolveServedCapabilities"));
    expect(shim, "resolveServedCapabilities must be RETAINED").toContain(
      "export async function resolveServedCapabilities",
    );
    // It delegates to the one switch and returns its capabilities — no second copy of the law.
    expect(shim).toMatch(/await resolveServedAuthority\(emp, opts\)/);
    expect(shim).toMatch(/\.capabilities/);
  });
});

// =====================================================================
// 5. The services SERVE the full switch — the authorised behavioural transition.
//    Every dimension (capabilities, posture, memory scope) now flows from the registry.
// =====================================================================

describe("registry LR3 — the services serve registry-derived authority on every dimension", () => {
  for (const svc of SERVICES) {
    const code = codeOf(read(svc));

    it(`${svc}: assigns the FULL SWITCH result into identity (authority now flows from the registry)`, () => {
      expect(importSpecifiers(code)).toContain("@/server/sdk/registry-parity");
      expect(code).toMatch(/const\s+served\s*=\s*await\s+resolveServedAuthority\(emp\)/);
      // All three runtime read dimensions are now served from the switch, not the legacy model.
      expect(code).toMatch(/identity\.capabilities\s*=\s*served\.capabilities/);
      expect(code).toMatch(/identity\.posture\s*=\s*served\.posture/);
      expect(code).toMatch(/identity\.memoryScope\s*=\s*served\.memoryScope/);
    });

    it(`${svc}: no longer serves the bare legacy resolver directly (the switch is the one seam)`, () => {
      // The legacy resolution is RETAINED — but inside the switch (the bridge), not in the
      // service. The service must route ALL authority through resolveServedAuthority.
      expect(code).not.toMatch(/identity\.capabilities\s*=\s*resolveEmployeeCapabilities/);
      expect(code).not.toMatch(/resolveEmployeeCapabilities/);
      expect(code).not.toMatch(/resolveEmployeePosture/);
    });
  }
});

// =====================================================================
// 6. R4 boundary — legacy retained, parity retained, rollback control present.
//    (CEO: do NOT remove legacy authority / parity verification / rollback path.)
// =====================================================================

describe("registry R4 — nothing authorised-to-keep is removed", () => {
  it("keeps the canonical legacy resolvers in place (legacy authority retained)", () => {
    const tasks = codeOf(read(TASKS));
    expect(tasks).toMatch(/export function resolveEmployeeCapabilities/);
    expect(tasks).toMatch(/export function resolveEmployeePosture/);
  });

  it("retains the parity verification AND consumes the legacy model in the bridge", () => {
    const code = codeOf(read(PARITY));
    expect(code).toMatch(/export async function verifyRegistryParity/);
    expect(code).toMatch(/resolveEmployeeCapabilities/);
  });

  it("ships the rollback control as a server-only, registry-default authority source", () => {
    const env = codeOf(read(ENV));
    expect(env).toMatch(/CAPABILITY_AUTHORITY_SOURCE/);
    expect(env).toMatch(/z\.enum\(\["registry",\s*"legacy"\]\)\.default\("registry"\)/);
    // An authority control is never shipped to the browser.
    expect(env).not.toMatch(/NEXT_PUBLIC_CAPABILITY_AUTHORITY_SOURCE/);
  });
});
