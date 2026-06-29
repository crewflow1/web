import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — LR5.2 (Migrate the Legacy Read Paths) security invariants.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 5.2. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel Contract
 * Map §2): the **Read Migration Rule (24th — set on the LR5.1 review): "No read path should
 * be removed until all remaining consumers have been identified, migrated, and independently
 * validated"**; the Single Source of Authority Rule (13th); the Behaviour Preservation Rule
 * (15th); the Rollback Readiness Rule (17th); and the Removal Sequencing Rule (23rd), whose
 * "then remove stored legacy data" step LR5.2 protects on the consumer side.
 *
 * LR5.1 retired the capability mirror — `ai_employees.tools_allowed` / `permissions` went
 * INERT. The runtime authority reads were migrated long before (R4/LR3 — the runner identity
 * calls resolveServedAuthority). What still read those now-inert columns DIRECTLY were the
 * ADMINISTRATIVE surfaces: the AI Boardroom employee page (the capability-editor pre-fill +
 * the permissions panel) and the authoring audit's before-snapshot. LR5.2 migrates those last
 * reads onto the registry. CI has no database here (the live behaviour is proven in the
 * integration tier), so — like the R1/R2/LR1/LR5.1 suites — we pin the CONTRACT against source
 * text. These are the facts that, if they ever silently flipped, would be a hole in LR5.2:
 *   • the SEAMS SHIP — registry-parity exports resolveServedCapabilityView (served authority,
 *     split by catalogue kind, for admin display) and readEmployeeGrantTokens (the registry
 *     before-snapshot);
 *   • the ADMIN PAGE reads SERVED authority — the capability editor + permissions panel read
 *     the registry view (served.tokens / .scopes / .requiresApproval), and NO LONGER read the
 *     now-inert e.tools_allowed / e.permissions.scopes / e.permissions.requires_approval;
 *   • the AUDIT before-snapshot reads the REGISTRY grant — not the inert columns;
 *   • the seams REUSE the one switch — resolveServedCapabilityView delegates authority to
 *     resolveServedAuthority (so rollback / fail-safe / shadow live in ONE place), threads the
 *     rollback control, and fails open; readEmployeeGrantTokens reads the EMPLOYEE grant only;
 *   • NOTHING authorised-to-keep is removed — the runtime switch, the legacy resolvers, the
 *     confidence audit (which reads legacy BY DESIGN), the rollback control and the migration
 *     history all remain; NO column is dropped; and memory_scope reads are DELIBERATELY
 *     retained (its mirror is still live — out of the LR5.2 sequence).
 *
 * Comment text (TS block/line + JSX comments) is stripped first, so the prose that DOCUMENTS
 * the contract can neither satisfy a positive match nor trip a negative one (this file's own
 * targets are NAMED in the migrated files' comments).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JSX block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. {/* … */} JSX)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Slice one top-level function/interface (its declaration → the next `export`). */
function sliceExport(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + marker.length);
  return src.slice(start, next === -1 ? undefined : next);
}

const PARITY_REL = "server/sdk/registry-parity.ts";
const PAGE_REL = "app/admin/ai-boardroom/[slug]/page.tsx";
const ACTIONS_REL = "app/admin/ai-boardroom/actions.ts";
const TASKS_REL = "server/sdk/tasks.ts";
const CONFIDENCE_REL = "server/sdk/registry-confidence.ts";
const AIEMP_REL = "server/services/ai-employees.ts";
const ENV_REL = "lib/env.ts";
const LR51_MIG_REL = "supabase/migrations/20260810000000_capability_registry_retire_capability_mirror.sql";
const MEMSCOPE_MIG_REL = "supabase/migrations/20260809000000_capability_registry_native_memory_scope.sql";

const parity = codeOf(read(PARITY_REL));
const page = codeOf(read(PAGE_REL));
const actions = codeOf(read(ACTIONS_REL));

// =====================================================================
// 0. The read-migration seams ship.
// =====================================================================

describe("registry LR5.2 — the administrative read-migration seams ship", () => {
  it("registry-parity exports resolveServedCapabilityView + readEmployeeGrantTokens", () => {
    expect(parity).toMatch(/export async function resolveServedCapabilityView/);
    expect(parity).toMatch(/export async function readEmployeeGrantTokens/);
  });

  it("exports the ServedCapabilityView contract (tokens + tools/scopes split + approval)", () => {
    const view = sliceExport(parity, "export interface ServedCapabilityView");
    expect(view).toMatch(/tokens:/);
    expect(view).toMatch(/toolsAllowed:/);
    expect(view).toMatch(/scopes:/);
    expect(view).toMatch(/requiresApproval:/);
  });
});

// =====================================================================
// 1. The AI Boardroom page reads SERVED authority, not the inert columns.
// =====================================================================

describe("registry LR5.2 — the AI Boardroom page reads SERVED authority", () => {
  it("resolves the capability view from the registry seam", () => {
    expect(page).toMatch(/resolveServedCapabilityView\(/);
    expect(page).toMatch(/from "@\/server\/sdk\/registry-parity"/);
  });

  it("seeds the capability editor + permissions panel from the SERVED view", () => {
    expect(page).toMatch(/served\.tokens/);
    expect(page).toMatch(/served\.scopes/);
    expect(page).toMatch(/served\.requiresApproval/);
  });

  it("NO LONGER reads the now-inert capability columns directly (the Read Migration Rule)", () => {
    expect(page).not.toMatch(/e\.tools_allowed/);
    expect(page).not.toMatch(/e\.permissions\.scopes/);
    expect(page).not.toMatch(/e\.permissions\.requires_approval/);
  });
});

// =====================================================================
// 2. The authoring audit before-snapshot reads the REGISTRY grant.
// =====================================================================

describe("registry LR5.2 — the authoring audit reads the registry, not the inert columns", () => {
  it("computes the before-snapshot from the registry grant", () => {
    expect(actions).toMatch(/from "@\/server\/sdk\/registry-parity"/);
    expect(actions).toMatch(/const beforeTokens = await readEmployeeGrantTokens\(/);
  });

  it("NO LONGER selects the inert legacy columns for the snapshot", () => {
    // The LR1 audit read `select("tools_allowed, permissions")` from ai_employees; LR5.2
    // removes it. (`result.toolsAllowed` from the RPC envelope is unaffected — it's not a
    // column read; the memory-scope action's own select stays — memory_scope is still live.)
    expect(actions).not.toMatch(/select\("tools_allowed, permissions"\)/);
    expect(actions).not.toMatch(/prevRow\?\.tools_allowed/);
  });
});

// =====================================================================
// 3. The read seams reuse the ONE served-authority switch.
// =====================================================================

describe("registry LR5.2 — the read seams reuse the one switch (no parallel authority logic)", () => {
  it("resolveServedCapabilityView delegates authority to resolveServedAuthority", () => {
    const fn = sliceExport(parity, "export async function resolveServedCapabilityView");
    expect(fn).toMatch(/resolveServedAuthority\(/);
  });

  it("threads the rollback control through to the switch (rollback honoured)", () => {
    const fn = sliceExport(parity, "export async function resolveServedCapabilityView");
    expect(fn).toMatch(/control:\s*opts\.control/);
  });

  it("the catalogue split fails open (a split error never breaks the admin page)", () => {
    const fn = sliceExport(parity, "export async function resolveServedCapabilityView");
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch/);
  });

  it("readEmployeeGrantTokens reads the EMPLOYEE grant ONLY (never factors authority up a scope)", () => {
    const fn = sliceExport(parity, "export async function readEmployeeGrantTokens");
    expect(fn).toMatch(/scope_level\.eq\.employee/);
    expect(fn).toMatch(/scope_key\.eq\./);
    expect(fn).toMatch(/catch/); // fail-open
    expect(fn).not.toMatch(/scope_level\.eq\.global/);
    expect(fn).not.toMatch(/scope_level\.eq\.department/);
  });
});

// =====================================================================
// 4. LR5.2 boundary — preserves rollback / parity / confidence / legacy
//    reads; removes no column; memory_scope reads deliberately retained.
// =====================================================================

describe("registry LR5.2 — preserves everything authorised-to-keep, removes no column", () => {
  it("preserves the runtime served-authority switch + shadow parity (authority unchanged)", () => {
    expect(parity).toMatch(/export async function resolveServedAuthority/);
    expect(parity).toMatch(/export async function resolveServedCapabilities/);
    expect(parity).toMatch(/export async function verifyRegistryParity/);
  });

  it("preserves the legacy resolvers (the rollback / fail-safe / parity bridge reads)", () => {
    const tasks = codeOf(read(TASKS_REL));
    expect(tasks).toMatch(/export function resolveEmployeeCapabilities/);
    expect(tasks).toMatch(/export function resolveEmployeePosture/);
  });

  it("preserves the confidence audit, which reads the legacy columns BY DESIGN", () => {
    const confidence = codeOf(read(CONFIDENCE_REL));
    expect(confidence).toMatch(/export async function auditRegistryConfidence/);
    expect(confidence).toMatch(/tools_allowed, permissions, memory_scope/);
  });

  it("preserves the rollback control (CAPABILITY_AUTHORITY_SOURCE — rollback NOT retired)", () => {
    const env = codeOf(read(ENV_REL));
    expect(env).toMatch(/CAPABILITY_AUTHORITY_SOURCE/);
    expect(env).toMatch(/z\.enum\(\["registry",\s*"legacy"\]\)\.default\("registry"\)/);
  });

  it("removes NO column — the model still carries the (now-inert) legacy columns", () => {
    const aiemp = codeOf(read(AIEMP_REL));
    expect(aiemp).toMatch(/"tools_allowed"/);
    expect(aiemp).toMatch(/"permissions"/);
    expect(aiemp).toMatch(/"memory_scope"/);
  });

  it("keeps the migration history intact (LR5.1 mirror retirement + the memory_scope mirror)", () => {
    expect(existsSync(resolve(ROOT, LR51_MIG_REL))).toBe(true);
    expect(existsSync(resolve(ROOT, MEMSCOPE_MIG_REL))).toBe(true);
  });

  it("memory_scope reads are DELIBERATELY retained — its mirror is still live (out of sequence)", () => {
    // The Removal Sequencing Rule (23rd): read-migrate a column only AFTER its writes are
    // retired. memory_scope's mirror (809) is still active, so the page still reads the live
    // column and the memory-scope audit still snapshots it. LR5.2 touches capabilities only.
    expect(page).toMatch(/e\.memory_scope/);
    expect(actions).toMatch(/select\("memory_scope"\)/);
  });
});
