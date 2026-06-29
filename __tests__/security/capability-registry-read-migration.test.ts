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
 *     resolveServedAuthority (so the fail-safe + shadow live in ONE place) and fails open;
 *     readEmployeeGrantTokens reads the EMPLOYEE grant only (LR5.3 later retired the rollback
 *     control, so the view no longer threads one — legacy is the automatic fail-safe);
 *   • NOTHING authorised-to-keep is removed — the runtime switch, the legacy resolvers, the
 *     confidence audit (which reads legacy BY DESIGN) and the migration history all remain; NO
 *     column is dropped; and memory_scope reads are DELIBERATELY retained (its mirror is still
 *     live — out of the LR5.2 sequence). The rollback control is RETIRED (LR5.3).
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

  it("NO LONGER threads a rollback control to the switch (LR5.3 retired the lever)", () => {
    const fn = sliceExport(parity, "export async function resolveServedCapabilityView");
    expect(fn).not.toMatch(/control:\s*opts\.control/);
    // It passes only the injectable client through to the one authority seam.
    expect(fn).toMatch(/resolveServedAuthority\(emp,\s*\{\s*client:\s*opts\.client\s*\}\)/);
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
// 4. LR5.2 → LR5.4B boundary. LR5.2 itself preserved the legacy surface (it migrated
//    administrative READS only — the Removal Sequencing Rule). LR5.4B (the Data Removal
//    Rule, 26th) has SINCE removed the legacy authority columns, the legacy resolvers and
//    the shadow-parity comparator: the registry is the SOLE authority. The SURVIVING
//    memory_scope (shared platform data) and the migration history are retained.
// =====================================================================

describe("registry LR5.2 — the read seams survive; the legacy authority surface is removed (LR5.4B)", () => {
  it("preserves the runtime served-authority switch; the shadow parity is retired (LR5.4B)", () => {
    expect(parity).toMatch(/export async function resolveServedAuthority/);
    expect(parity).toMatch(/export async function resolveServedCapabilities/);
    // The shadow-parity comparator is gone — no legacy baseline left to compare against.
    expect(parity).not.toMatch(/verifyRegistryParity/);
  });

  it("the legacy resolvers are removed (LR5.4B — the registry is the SOLE authority)", () => {
    const tasks = codeOf(read(TASKS_REL));
    expect(tasks).not.toMatch(/resolveEmployeeCapabilities/);
    expect(tasks).not.toMatch(/resolveEmployeePosture/);
  });

  it("preserves the confidence audit, now reading only the registry query columns (no legacy column)", () => {
    const confidence = codeOf(read(CONFIDENCE_REL));
    expect(confidence).toMatch(/export async function auditRegistryConfidence/);
    // LR5.4B dropped ai_employees.tools_allowed / permissions; the audit reads only slug +
    // department to query the registry — never a legacy authority column.
    expect(confidence).not.toMatch(/tools_allowed/);
    expect(confidence).toMatch(/"slug, department"/);
  });

  it("removes the legacy authority columns from the model; the surviving memory_scope stays", () => {
    const aiemp = codeOf(read(AIEMP_REL));
    expect(aiemp).not.toMatch(/"tools_allowed"/);
    expect(aiemp).not.toMatch(/"permissions"/);
    expect(aiemp).toMatch(/"memory_scope"/); // shared platform data — out of scope for the drop
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
