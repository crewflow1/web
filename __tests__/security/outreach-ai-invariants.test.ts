import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Outreach AI security invariants
 * (CEO Directive 010, Phase 1 — Infrastructure Reuse Audit).
 *
 * Outreach AI is the first AI employee whose output is meant to reach a CUSTOMER.
 * That makes its trust boundary different from its siblings:
 *
 *   • Research AI is read+draft and gated (requires_approval=true), but its
 *     drafts are internal preparation; Lead Qualification AI is autonomous
 *     (requires_approval=false) but only ever makes an internal, reversible
 *     classification. Outreach AI is the case both were careful to avoid: it
 *     prepares words a human may then send to a prospect. So the V1 safety story
 *     is the strictest one the programme has: Draft → Human Review → Approval →
 *     Send. There is NO autonomous customer communication.
 *
 * Phase 1 ships only the reuse audit's output — the seed migration that registers
 * the employee and its honest provenance source, reusing everything else. There
 * is no runner, route, or lib yet (those arrive in their own reviewable phases,
 * each with their own invariants). So this suite pins exactly what Phase 1 ships:
 * the migration's contract, against SOURCE TEXT. The checks run over `exec` (SQL
 * with `--` comments stripped), so the prose that DOCUMENTS the contract can
 * neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- … EOL).
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20260729000000_outreach_ai_employee.sql";

// =====================================================================
// 0. The migration ships and stays Foundation-safe (no new attack surface),
//    and records the reuse audit: it mints NO new work-kind vocabulary.
// =====================================================================

describe("outreach-ai — the employee migration adds work, not a new data surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("adds the Outreach AI employee to the existing ai_employees table", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.ai_employees/i);
    expect(exec).toMatch(/'outreach-ai'/);
  });

  it("seeds its honest provenance source slug (so outreach events are not mislabelled)", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.hq_sales_sources/i);
    expect(exec).toMatch(/'ai_outreach'/);
  });

  it("REUSES the inert generate_email task type — it mints no new work-kind vocabulary", () => {
    // The reuse decision, pinned: the migration inserts NO task type at all (it
    // reuses the foundation's `generate_email`), and in particular never mints
    // the parallel `draft_outreach` slug the audit considered and rejected. The
    // assertion targets the quoted SLUG literal — distinct from the descriptive
    // `draft_outreach_email` tool name, which legitimately drafts (never sends).
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_sales_task_types/i);
    expect(exec).not.toMatch(/'draft_outreach'/);
  });

  it("creates NO new table (it reuses the Directive-004 hq_sales_* family wholesale)", () => {
    expect(exec).not.toMatch(/create\s+table/i);
  });

  it("declares NO policy and NO escalation surface (no SECURITY DEFINER, no dynamic SQL)", () => {
    expect(exec).not.toMatch(/create\s+policy/i);
    expect(exec).not.toMatch(/security\s+definer/i);
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("is idempotent — re-running never clobbers operator edits", () => {
    expect(exec).toMatch(/on\s+conflict\s*\(slug\)\s*do\s+nothing/i);
  });
});

// =====================================================================
// 1. The V1 safety contract — Draft → Human Review → Approval → Send.
//    The load-bearing invariant: this employee is gated and carries NO send.
// =====================================================================
//
// Outreach AI's drafts can reach a customer, so the only thing standing between
// a draft and a prospect is a human approval. Two facts make that true and must
// never silently flip: requires_approval=true (a human gates every draft), and a
// scope set that GRANTS no 'send' (sending is never an employee capability in V1
// — it is a separate, human-recorded act). If approval flipped to false, or a
// 'send'/'delete'/'write' scope ever appeared, the V1 safety story would be void.

describe("outreach-ai — the V1 safety contract is pinned in the permission grant", () => {
  const exec = execOf(read(MIGRATION));

  it("is gated — requires_approval=true (no autonomous customer communication in V1)", () => {
    expect(exec).toMatch(/"requires_approval":\s*true/);
  });

  it("is permitted to execute, but ONLY within read/draft/memory scopes", () => {
    expect(exec).toMatch(/"can_execute":\s*true/);
    // The exact, complete scope set — read, draft, remember. Nothing more.
    expect(exec).toMatch(/"scopes":\s*\["read","draft","memory"\]/);
  });

  it("the grant structurally excludes send and every irreversible scope", () => {
    // Sending is human-gated, never an employee scope; the grant must also never
    // silently acquire the ability to delete or write.
    const grant = exec.match(/"scopes":\s*\[[^\]]*\]/)?.[0] ?? "";
    expect(grant).not.toMatch(/"send"/);
    expect(grant).not.toMatch(/"delete"/);
    expect(grant).not.toMatch(/"write"/);
  });
});

// =====================================================================
// 2. A model IS wired — drafting outreach prose is generative.
//    (The exact inverse of Lead Qualification AI, which is deterministic.)
// =====================================================================

describe("outreach-ai — the employee is generative (a model is wired)", () => {
  const exec = execOf(read(MIGRATION));

  it("wires a model provider + name (anthropic / claude-haiku-4-5) — not NULL", () => {
    expect(exec).toMatch(/'anthropic'/);
    expect(exec).toMatch(/'claude-haiku-4-5'/);
    // …and is NOT the deterministic null,null shape that Lead Qualification uses.
    expect(exec).not.toMatch(/\bnull,\s*null,/i);
  });
});

// =====================================================================
// 3. Registration facts — the employee lands in the right place, idle.
// =====================================================================

describe("outreach-ai — the employee is registered correctly", () => {
  const exec = execOf(read(MIGRATION));

  it("joins the sales department with an organisation-wide memory scope, idle", () => {
    expect(exec).toMatch(/'sales'/);
    expect(exec).toMatch(/'organization'/);
    expect(exec).toMatch(/'idle'/);
  });
});
