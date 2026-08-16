import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS } from "@/lib/hq/boardroom-cards";
import { DEPARTMENT_STAGE } from "@/server/services/hq-workflow";
import { decomposeDirective, getTemplate } from "@/lib/hq/workflow/decompose";

/**
 * CrewFlow HQ — Master-Plan task-lifecycle stage alignment (the 14-stage gap).
 *
 * The shipped pipeline_stage enum modelled ELEVEN stages; migration 20261161000000
 * widens it to the full FIFTEEN-stage Master-Plan set (adding `architecture`,
 * `approval`, `monitoring`, `continuous-improvement`; keeping `marketing` + `sales`,
 * both live in the workflow's department→stage map).
 *
 * Two contracts are pinned here:
 *   1. ENUM MIRROR — the TS vocabulary (PIPELINE_STAGES + the hq-tasks PipelineStage
 *      union) and the SQL vocabulary (all three stage surfaces in the migration) are in
 *      exact lock-step. A drift in either direction fails CI.
 *   2. STAGE STAMPING — the full-lifecycle `product_launch` decomposition, mapped
 *      through DEPARTMENT_STAGE, stamps every one of the fifteen stages exactly once, so
 *      a launch saga's dispatched tasks TRAVERSE the entire lifecycle (each move appends
 *      an immutable stage-event — measurable + auditable).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261161000000_hq_task_lifecycle_and_competitor.sql";
const HQ_TASKS = "server/services/hq-tasks.ts";

const EXPECTED_STAGES = [
  "idea",
  "research",
  "specification",
  "architecture",
  "design",
  "engineering",
  "testing",
  "documentation",
  "approval",
  "marketing",
  "sales",
  "deployment",
  "monitoring",
  "review",
  "continuous-improvement",
] as const;

/** Strip -- line comments so prose can neither satisfy nor trip a match. */
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Pull the single-quoted tokens out of the FIRST `in (...)` list after an anchor. */
function stagesInList(sql: string, anchor: RegExp): string[] {
  const anchorIdx = sql.search(anchor);
  expect(anchorIdx, `anchor ${anchor} must be present`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(anchorIdx);
  const open = rest.search(/in\s*\(/i);
  expect(open, "an `in (...)` list must follow the anchor").toBeGreaterThanOrEqual(0);
  const from = rest.slice(open);
  const close = from.indexOf(")");
  const body = from.slice(0, close);
  return [...body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
}

describe("task-lifecycle enum mirror — SQL ↔ TS lock-step", () => {
  const exec = execOf(read(MIGRATION));

  it("PIPELINE_STAGES (TS) is exactly the fifteen Master-Plan stages, in order", () => {
    expect([...PIPELINE_STAGES]).toEqual([...EXPECTED_STAGES]);
  });

  it("every stage has a human label (no missing / orphan label)", () => {
    expect(Object.keys(PIPELINE_STAGE_LABELS).sort()).toEqual([...PIPELINE_STAGES].sort());
    for (const s of PIPELINE_STAGES) expect(PIPELINE_STAGE_LABELS[s]).toBeTruthy();
  });

  it("the column CHECK admits EXACTLY the TS stage set (no more, no fewer)", () => {
    const sql = stagesInList(exec, /add constraint hq_ai_tasks_pipeline_stage_check/);
    expect(sql.sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("the append-only stage-event to_stage CHECK admits EXACTLY the TS stage set", () => {
    const sql = stagesInList(exec, /add constraint hq_ai_task_stage_events_to_stage_check/);
    expect(sql.sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("the sanctioned set_stage mover validates against EXACTLY the TS stage set", () => {
    const sql = stagesInList(exec, /p_stage not in/);
    expect(sql.sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("the hq-tasks PipelineStage union names exactly the TS stage set", () => {
    const src = read(HQ_TASKS);
    // Every stage appears as a `| \"stage\"` arm…
    for (const s of PIPELINE_STAGES) {
      expect(src, `PipelineStage must include ${s}`).toMatch(
        new RegExp(`\\|\\s*"${s.replace(/[-]/g, "\\-")}"`),
      );
    }
    // …and the widened-enum count is documented (guards against a silent 11→? drift).
    expect(src).toMatch(/fifteen Master-Plan product pipeline stages/);
  });

  it("the CHECK widening is a SUPERSET of the shipped eleven (no orphaned rows)", () => {
    const shipped = [
      "idea",
      "research",
      "specification",
      "design",
      "engineering",
      "testing",
      "documentation",
      "marketing",
      "sales",
      "deployment",
      "review",
    ];
    for (const s of shipped) expect(PIPELINE_STAGES as readonly string[]).toContain(s);
  });
});

describe("stage stamping — the launch saga traverses the full lifecycle", () => {
  it("DEPARTMENT_STAGE only maps to valid PipelineStage values", () => {
    for (const stage of Object.values(DEPARTMENT_STAGE)) {
      expect(PIPELINE_STAGES as readonly string[]).toContain(stage);
    }
  });

  it("product_launch decomposes into a step per Master-Plan stage", () => {
    const res = decomposeDirective({ title: "Ship it", templateKey: "product_launch" }, new Date(0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.steps).toHaveLength(PIPELINE_STAGES.length);
  });

  it("mapping product_launch steps through DEPARTMENT_STAGE covers ALL fifteen stages, each once", () => {
    const template = getTemplate("product_launch");
    expect(template).not.toBeNull();
    const stamped = template!.steps.map((s) => DEPARTMENT_STAGE[s.department]);
    // No step goes unstaged.
    for (const [i, stage] of stamped.entries()) {
      expect(stage, `step ${i + 1} (${template!.steps[i]!.department}) must map to a stage`).toBeTruthy();
    }
    // The stamped stages are exactly the full lifecycle — a genuine traversal.
    expect([...stamped].sort()).toEqual([...PIPELINE_STAGES].sort());
    // …and in pipeline order (a launch advances idea → continuous-improvement).
    expect(stamped).toEqual([...PIPELINE_STAGES]);
  });

  it("advanceStep stamps the dispatched task's stage via the sanctioned RPC", () => {
    const src = read("server/services/hq-workflow.ts");
    // The stamp derives from DEPARTMENT_STAGE and goes through setTaskStage (the
    // hq_ai_task_set_stage RPC), never a bare hq_ai_tasks write.
    expect(src).toMatch(/DEPARTMENT_STAGE\[step\.department\]/);
    expect(src).toMatch(/await setTaskStage\(taskId, stage\)/);
    expect(src).not.toMatch(/\.from\(\s*["'`]hq_ai_tasks["'`]\s*\)\s*\.(insert|update|delete|upsert)/);
  });
});
