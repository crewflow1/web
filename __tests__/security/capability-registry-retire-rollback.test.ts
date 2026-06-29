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
const LR54B_MIG = `${MIG_DIR}/20260812000000_lr5_4b_remove_legacy_authority_columns.sql`;

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

  it("KEEPS the automatic fail-safe — the error / silent-subject branches serve the default-deny floor", () => {
    // These are NOT rollback: they are the registry's own fail-safe, protecting every employee
    // independently of any operator action (the 25th standard's "removable independently"). LR5.4B
    // removed the legacy columns, so the fail-safe lands on the default-deny FLOOR, not a legacy model.
    expect(decide).toMatch(/reason:\s*"error"/); // registry read failed → floor
    expect(decide).toMatch(/reason:\s*"empty"/); // registry silent (backfill gap) → floor
    expect(decide).toMatch(/basis:\s*"registry"/); // registry served when it actually spoke
    expect(decide).toMatch(/basis:\s*"floor"/); // the default-deny fail-safe floor remains
    expect(decide).not.toMatch(/basis:\s*"legacy"/); // no legacy model left to fall back to (LR5.4B)
  });

  it("no longer folds in a parity comparison (LR5.4B retired the shadow monitoring)", () => {
    // The shadow-parity comparator is gone — no legacy baseline left to compare the registry to.
    expect(resolver).not.toMatch(/compareAuthority/);
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

  it("resolveServedAuthority PRESERVES the automatic fail-safe (non-throwing, always lands on the floor)", () => {
    const serve = sliceExport(parity, "export async function resolveServedAuthority");
    expect(serve).toMatch(/decideServedAuthority\(/); // delegates to the pure law
    expect(serve).toMatch(/floorServedAuthority/); // the default-deny floor is served (LR5.4B)
    expect(serve).not.toMatch(/legacyServedAuthority/); // the legacy fallback was removed
    expect(serve).not.toMatch(/return legacy\b/);
    expect(serve).toMatch(/try\s*\{/);
    expect(serve).toMatch(/catch\b/);
    expect(serve).not.toMatch(/\bthrow\b/); // fails SAFE to the floor, never to an error
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

  it("no longer reads the legacy columns (LR5.4B — the audit measures registry serving health)", () => {
    // With the legacy columns dropped there is no baseline to compare against; the audit reads
    // only slug + department to query the registry, never a legacy authority column.
    expect(confidence).not.toMatch(/tools_allowed/);
    expect(confidence).toMatch(/"slug, department"/);
  });
});

// =====================================================================
// 4. LR5.3 → LR5.4B boundary. LR5.3 retired the rollback INDEPENDENTLY of the legacy
//    implementation it protected (25th standard), leaving that implementation intact. LR5.4B
//    (the Legacy Independence Rule, 28th; the Data Removal Rule, 26th) has SINCE removed it — the
//    legacy resolvers, the shadow-parity comparator and the legacy authority columns. The
//    surviving memory_scope, the parity-backfill HISTORY and the migration history all remain.
// =====================================================================

describe("registry LR5.3 → LR5.4B — the legacy implementation rollback protected is now removed", () => {
  it("removes the canonical legacy resolvers (LR5.4B — the registry is the SOLE authority)", () => {
    const tasks = codeOf(read(TASKS));
    expect(tasks).not.toMatch(/resolveEmployeeCapabilities/);
    expect(tasks).not.toMatch(/resolveEmployeePosture/);
  });

  it("removes the parity comparator from the bridge; the R2 backfill migration is PRESERVED", () => {
    expect(codeOf(read(PARITY))).not.toMatch(/verifyRegistryParity/);
    // The historical R2 backfill migration is governance history — untouched.
    expect(existsSync(resolve(ROOT, R2_MIG))).toBe(true);
    expect(read(R2_MIG)).toMatch(/hq_capability_registry_parity/);
  });

  it("removes the legacy authority columns from the model; the surviving memory_scope stays", () => {
    const aiemp = codeOf(read(AIEMP));
    expect(aiemp).not.toMatch(/tools_allowed/);
    expect(aiemp).not.toMatch(/permissions/);
    expect(aiemp).toMatch(/memory_scope/); // shared platform data — out of scope for the drop
  });

  it("the LR5.4B migration DROPS the legacy authority columns; memory_scope is NEVER dropped", () => {
    const lr54b = stripSql(read(LR54B_MIG));
    expect(lr54b).toMatch(/drop\s+column\s+tools_allowed/i);
    expect(lr54b).toMatch(/drop\s+column\s+permissions/i);
    // memory_scope (and department) survive — no migration ever drops them.
    expect(migrationCorpus()).not.toMatch(/drop\s+column[^;]*\bmemory_scope\b/i);
  });

  it("keeps the migration history intact (LR1 808, memory_scope 809, LR5.1 810, LR5.4B 812 all present)", () => {
    expect(existsSync(resolve(ROOT, LR1_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, MEMSCOPE_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, LR51_MIG))).toBe(true);
    expect(existsSync(resolve(ROOT, LR54B_MIG))).toBe(true);
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
