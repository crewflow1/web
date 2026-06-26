import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Shared Memory ⇄ Task Engine binding invariants (Directive #012 / D-02, PR-D).
 *
 * PR-D adds ONE referential constraint: `hq_memories.bound_task_id → hq_ai_tasks(id)`.
 * The column, its index, the `hq_memory_write` parameter, and the SDK auto-binding all
 * shipped at #009 — FK-less, because `hq_ai_tasks` did not exist yet. This suite pins
 * the constraint as a matter of SOURCE: that it points at the task PK, that its delete
 * rule is the SET-NULL chosen in ADR-0006 (a memory OUTLIVES its task — never cascade,
 * never restrict), and that the change is strictly ADDITIVE — it alters only
 * `hq_memories`, leaves `hq_ai_tasks` untouched, writes no data, and adds no behaviour.
 *
 * Each fact below, and what breaks if it silently flips:
 *   • References `hq_ai_tasks(id)` — bind to the wrong column/table and the lifecycle
 *     worker's `bound_task_id` no longer resolves to a task.
 *   • `ON DELETE SET NULL` — a CASCADE would delete company knowledge the moment a
 *     reaper prunes a finished task (a data-loss footgun); a RESTRICT would make a
 *     scratchpad link hold a task hostage against deletion. Neither is permitted.
 *   • Additive — the migration must not alter the `hq_ai_tasks` table, drop anything,
 *     or create/replace a function or trigger: PR-D is a constraint, not a behaviour.
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract can neither
 * satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip SQL block + line comments so only executable DDL is matched. */
function sqlOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--[^\n]*/g, ""); // line comments
}

const MIGRATION = "supabase/migrations/20260804000000_hq_memories_bound_task_fk.sql";

// =====================================================================
// 0. The PR-D migration exists.
// =====================================================================

describe("memory⇄task FK — the migration exists", () => {
  it("ships the bound_task_id FK migration", () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });
});

// =====================================================================
// 1. The constraint binds bound_task_id to the task PK.
// =====================================================================

describe("the FK references hq_ai_tasks(id) from hq_memories.bound_task_id", () => {
  const sql = sqlOf(read(MIGRATION));

  it("alters hq_memories to ADD the constraint (the satellite carries the edge)", () => {
    expect(sql).toMatch(/alter\s+table\s+public\.hq_memories\s+add\s+constraint/i);
  });

  it("declares the foreign key on bound_task_id", () => {
    expect(sql).toMatch(/foreign\s+key\s*\(\s*bound_task_id\s*\)/i);
  });

  it("references public.hq_ai_tasks(id) — the task primary key", () => {
    expect(sql).toMatch(/references\s+public\.hq_ai_tasks\s*\(\s*id\s*\)/i);
  });

  it("names the constraint predictably (so revert + tests can address it)", () => {
    expect(sql).toContain("hq_memories_bound_task_id_fkey");
  });
});

// =====================================================================
// 2. The delete rule is SET NULL — never cascade, never restrict (ADR-0006).
// =====================================================================

describe("delete rule — ON DELETE SET NULL (a memory outlives its task)", () => {
  const sql = sqlOf(read(MIGRATION));

  it("is ON DELETE SET NULL", () => {
    expect(sql).toMatch(/on\s+delete\s+set\s+null/i);
  });

  it("is NOT cascade (deleting a task must never delete knowledge)", () => {
    expect(sql).not.toMatch(/on\s+delete\s+cascade/i);
  });

  it("is NOT restrict / no action (a scratchpad link must not block task deletion)", () => {
    expect(sql).not.toMatch(/on\s+delete\s+restrict/i);
    expect(sql).not.toMatch(/on\s+delete\s+no\s+action/i);
  });
});

// =====================================================================
// 3. Strictly additive — a constraint, not a schema or behaviour change.
// =====================================================================

describe("additive — alters only hq_memories, no behaviour, no destructive op", () => {
  const sql = sqlOf(read(MIGRATION));

  it("does NOT alter the hq_ai_tasks table (the engine stays untouched & agnostic)", () => {
    expect(sql).not.toMatch(/alter\s+table\s+public\.hq_ai_tasks/i);
  });

  it("adds NO column and drops nothing (it is a single FK)", () => {
    expect(sql).not.toMatch(/add\s+column/i);
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+column/i);
  });

  it("introduces NO behaviour — no function or trigger is defined", () => {
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(sql).not.toMatch(/create\s+trigger/i);
  });
});
