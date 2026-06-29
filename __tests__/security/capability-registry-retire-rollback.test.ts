import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR5.3 (Retire the Rollback Mechanisms) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 5.3. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel Contract Map
 * §2): the Behaviour Preservation Rule (15th), the Rollback Readiness Rule (17th), the Removal
 * Sequencing Rule (23rd — "first remove writes; THEN remove rollback; then remove stored legacy
 * data …"; LR5.1 took the first step, LR5.3 takes the second) and — first and foremost — the
 * **Rollback Independence Rule (25th): "Rollback mechanisms must be removable INDEPENDENTLY of
 * the legacy implementation they protect. Before rollback infrastructure is retired, the
 * production system must demonstrate that continued operation no longer depends on rollback
 * activation."**
 *
 * The DELIBERATE rollback was a single operator lever — `CAPABILITY_AUTHORITY_SOURCE=legacy` —
 * that forced the runtime to serve the legacy model regardless of the registry. LR5.3 RETIRES
 * exactly that lever and everything that existed only to serve it (the `control` input/opt, the
 * `reason: "rollback"` branch, the `rolled-back` confidence outcome). What it must NOT touch is
 * the AUTOMATIC fail-safe — the registry-read-error / silent-subject fallthrough that protects
 * every employee independently of any operator switch — nor the legacy columns, the parity
 * tooling, the confidence audit or the migration history (all separately authorised, later
 * phases). That independence — rollback removable while the legacy implementation it protected
 * stays wholly intact — is the 25th standard made concrete.
 *
 * CI has no database here (the live behaviour is proven in the integration tier), so — like the
 * R1/R2/LR1/LR5.1/LR5.2 suites — we pin the CONTRACT against source text. Comment text is
 * stripped first, so the prose that DOCUMENTS the contract (this header NAMES the lever it
 * retires) can neither satisfy a positive match nor trip a negative one.
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

/** Slice one top-level function (its declaration → the next top-level `export`). */
function sliceExport(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + marker.length);
  return src.slice(start, next === -1 ? undefined : next);
}

const RESOLVER = "server/sdk/registry-resolver.ts";
const PARITY = "server/sdk/registry-parity.ts";
const CONFIDENCE = "server/sdk/registry-confidence.ts";
const TASKS = "server/sdk/tasks.ts";
const ENV = "lib/env.ts";
const AIEMP = "server/services/ai-employees.ts";
const RESEARCH = "server/services/hq-research.ts";
const QUALIFICATION = "server/services/hq-qualification.ts";
const PAGE = "app/admin/ai-boardroom/[slug]/page.tsx";
const SERVICES = [RESEARCH, QUALIFICATION] as const;

const MIG_DIR = "supabase/migrations";
const R2_MIG = `${MIG_DIR}/20260807000000_capability_registry_backfill.sql`;
const LR1_MIG = `${MIG_DIR}/20260808000000_capability_registry_native_authoring.sql`;
const MEMSCOPE_MIG = `${MIG_DIR}/20260809000000_capability_registry_native_memory_scope.sql`;
const LR51_MIG = `${MIG_DIR}/20260810000000_capability_registry_retire_capability_mirror.sql`;

/** The whole migration corpus, SQL-comment-stripped — for "no column is ever dropped" scans. */
function migrationCorpus(): string {
  return readdirSync(resolve(ROOT, MIG_DIR))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => stripSql(read(`${MIG_DIR}/${f}`)))
    .join("\n");
}

// =====================================================================
// 0. The operator rollback LEVER is RETIRED from the env contract.
//    (CAPABILITY_AUTHORITY_SOURCE=legacy was the ONLY deliberate rollback.)
// =====================================================================

describe("registry LR5.3 — the rollback lever is retired from env", () => {
  const env = codeOf(read(ENV));

  it("env NO LONGER defines CAPABILITY_AUTHORITY_SOURCE (the deliberate rollback is gone)", () => {
    expect(env).not.toMatch(/CAPABILITY_AUTHORITY_SOURCE/);
  });

  it("env NO LONGER ships a registry/legacy authority-source enum", () => {
    expect(env).not.toMatch(/z\.enum\(\["registry",\s*"legacy"\]\)/);
  });

  it("no consumer reads an authority-source env lever (services + admin page)", () => {
    for (const rel of [...SERVICES, PAGE, PARITY, CONFIDENCE]) {
      const code = codeOf(read(rel));
      expect(code, `${rel} still reads the retired lever`).not.toMatch(
        /env\.CAPABILITY_AUTHORITY_SOURCE/,
      );
    }
  });
});

// =====================================================================
// 1. The PURE serving law drops the deliberate-rollback branch …
//    but KEEPS the automatic fail-safe (registry error / silent subject).
// =====================================================================

describe("registry LR5.3 — decideServedAuthority retires rollback, keeps the fail-safe", () => {
  const resolver = codeOf(read(RESOLVER));
  const decide = sliceExport(resolver, "export function decideServedAuthority");

  it("takes NO `control` input (the law no longer has an operator switch)", () => {
    expect(decide).not.toMatch(/\bcontrol\b/);
  });

  it("has NO deliberate-rollback branch (no `=== \"legacy\"`, no `reason: \"rollback\"`)", () => {
    expect(decide).not.toMatch(/===\s*"legacy"/);
    expect(decide).not.toMatch(/reason:\s*"rollback"/);
  });

  it("the whole pure resolver is purged of the rollback vocabulary", () => {
    // `rolled-back` (the outcome) and `rolledBack` (the summary tally) existed ONLY to report a
    // deliberate rollback; with the lever gone they are unreachable, so they are removed.
    expect(resolver).not.toMatch(/"rolled-back"/);
    expect(resolver).not.toMatch(/\brolledBack\b/);
    expect(resolver).not.toMatch(/"rollback"/);
  });

  it("KEEPS the automatic fail-safe — the error / silent-subject branches still serve legacy", () => {
    // These are NOT rollback: they are the registry's own fail-safe, protecting every employee
    // independently of any operator action (the 25th standard's "removable independently").
    expect(decide).toMatch(/reason:\s*"error"/); // registry read failed → legacy
    expect(decide).toMatch(/reason:\s*"empty"/); // registry silent (backfill gap) → legacy
    expect(decide).toMatch(/basis:\s*"registry"/); // registry served when it actually spoke
    expect(decide).toMatch(/basis:\s*"legacy"/); // the fail-safe floor remains
  });

  it("still folds in the parity comparison (shadow monitoring is untouched)", () => {
    expect(decide).toMatch(/compareAuthority\(/);
  });
});

// =====================================================================
// 2. The IO bridge reads NO control and threads NONE — yet the legacy
//    fail-safe (the thing rollback is independent OF) is fully preserved.
// =====================================================================

describe("registry LR5.3 — the bridge serves registry-only, legacy reachable via fail-safe only", () => {
  const parity = codeOf(read(PARITY));

  it("the bridge no longer imports the env module (nothing to gate on)", () => {
    expect(importSpecifiers(parity)).not.toContain("@/lib/env");
  });

  it("resolveServedAuthority takes no `control` opt and reads no authority-source lever", () => {
    const serve = sliceExport(parity, "export async function resolveServedAuthority");
    expect(serve).not.toMatch(/\bcontrol\b/);
    expect(serve).not.toMatch(/env\.CAPABILITY_AUTHORITY_SOURCE/);
    expect(serve).not.toMatch(/===\s*"legacy"/);
  });

  it("resolveServedAuthority PRESERVES the automatic fail-safe (non-throwing, always lands on legacy)", () => {
    const serve = sliceExport(parity, "export async function resolveServedAuthority");
    expect(serve).toMatch(/decideServedAuthority\(/); // delegates to the pure law
    expect(serve).toMatch(/legacyServedAuthority\(emp\)/); // the retained legacy floor is built
    expect(serve).toMatch(/return legacy\b/); // and served when the registry can't be
    expect(serve).toMatch(/try\s*\{/);
    expect(serve).toMatch(/catch\b/);
    expect(serve).not.toMatch(/\bthrow\b/); // fails SAFE to legacy, never to an error
  });

  it("resolveServedCapabilityView threads only the client (no rollback control)", () => {
    const view = sliceExport(parity, "export async function resolveServedCapabilityView");
    expect(view).not.toMatch(/control/);
    expect(view).toMatch(/resolveServedAuthority\(emp,\s*\{\s*client:\s*opts\.client\s*\}\)/);
  });
});

// =====================================================================
// 3. The confidence audit is PRESERVED (CEO: preserve confidence auditing)
//    — and is no longer control-gated (it measures the registry-only serve).
// =====================================================================

describe("registry LR5.3 — the confidence audit is preserved, no longer control-gated", () => {
  const confidence = codeOf(read(CONFIDENCE));

  it("still exports the §4 production-confidence instrument", () => {
    expect(confidence).toMatch(/export async function auditRegistryConfidence/);
  });

  it("no longer imports env / reads an authority source / reports a rollback tally", () => {
    expect(importSpecifiers(confidence)).not.toContain("@/lib/env");
    expect(confidence).not.toMatch(/env\.CAPABILITY_AUTHORITY_SOURCE/);
    expect(confidence).not.toMatch(/\bcontrol\b/);
    expect(confidence).not.toMatch(/\brolledBack\b/);
  });

  it("still reads the legacy columns BY DESIGN (the audit measures legacy vs registry)", () => {
    expect(confidence).toMatch(/tools_allowed, permissions, memory_scope/);
  });
});

// =====================================================================
// 4. INDEPENDENCE — the legacy implementation rollback protected is WHOLLY
//    intact (25th standard: rollback removable independently of legacy).
// =====================================================================

describe("registry LR5.3 — the legacy implementation is preserved INDEPENDENTLY of the rollback", () => {
  it("keeps the canonical legacy resolvers (legacy authority retained)", () => {
    const tasks = codeOf(read(TASKS));
    expect(tasks).toMatch(/export function resolveEmployeeCapabilities/);
    expect(tasks).toMatch(/export function resolveEmployeePosture/);
  });

  it("keeps the parity tooling (verification + the R2 backfill migration)", () => {
    expect(codeOf(read(PARITY))).toMatch(/export async function verifyRegistryParity/);
    expect(existsSync(resolve(ROOT, R2_MIG))).toBe(true);
    expect(read(R2_MIG)).toMatch(/hq_capability_registry_parity/);
  });

  it("keeps the (now-inert) legacy authority columns on the model (CEO: do NOT remove columns)", () => {
    const aiemp = codeOf(read(AIEMP));
    expect(aiemp).toMatch(/tools_allowed/);
    expect(aiemp).toMatch(/permissions/);
    expect(aiemp).toMatch(/memory_scope/);
  });

  it("NO migration EVER drops a legacy authority column (columns remain physically present)", () => {
    // The CEO's bar: "Legacy authority columns remain physically present until rollback
    // retirement has been independently validated and approved." LR5.3 ships no DB change.
    expect(migrationCorpus()).not.toMatch(
      /drop\s+column[^;]*\b(tools_allowed|permissions|memory_scope)\b/i,
    );
  });

  it("keeps the migration history intact (LR1 808, memory_scope 809, LR5.1 810 all present)", () => {
    expect(existsSync(resolve(ROOT, LR1_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, MEMSCOPE_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, LR51_MIG))).toBe(true);
  });
});

// =====================================================================
// 5. NO DEPENDENCE ON ROLLBACK — the consumers serve the registry switch
//    UNCONDITIONALLY (the 25th standard's "continued operation no longer
//    depends on rollback activation", pinned at the call sites).
// =====================================================================

describe("registry LR5.3 — consumers serve the registry unconditionally (no rollback dependence)", () => {
  for (const svc of SERVICES) {
    it(`${svc}: resolves served authority with no control argument`, () => {
      const code = codeOf(read(svc));
      expect(code).toMatch(/resolveServedAuthority\(emp\)/);
      expect(code).not.toMatch(/resolveServedAuthority\([^)]*control/);
    });
  }
});
