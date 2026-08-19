import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  selectMyOpenTasks,
  sortMyTasks,
  isTaskOverdue,
  type MyTaskRow,
} from "@/lib/jobs/my-tasks";

/**
 * Per-person task assignment on job checklists + "My tasks" (W3 CRM finisher).
 *
 * Tier 1 — the pure My-tasks selection (mine + open + ordered): where the
 * isolation ("never someone else's task, never a done one") and the due-date
 * ordering actually live. Tier 2 — the migration + action, pinned on source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const row = (over: Partial<MyTaskRow>): MyTaskRow => ({
  id: "i1",
  label: "Task",
  job_id: "job-1",
  is_done: false,
  assigned_to: "me",
  due_on: null,
  customer_name: null,
  ...over,
});

describe("my tasks — selection filters to mine + open", () => {
  it("excludes tasks assigned to someone else (tenant/person isolation)", () => {
    const rows = [
      row({ id: "mine", assigned_to: "me" }),
      row({ id: "theirs", assigned_to: "other" }),
    ];
    const out = selectMyOpenTasks(rows, "me");
    expect(out.map((r) => r.id)).toEqual(["mine"]);
  });

  it("excludes completed tasks", () => {
    const rows = [
      row({ id: "open", is_done: false }),
      row({ id: "done", is_done: true }),
    ];
    expect(selectMyOpenTasks(rows, "me").map((r) => r.id)).toEqual(["open"]);
  });

  it("excludes an unassigned (null) task even for the viewer", () => {
    const rows = [row({ id: "unassigned", assigned_to: null })];
    expect(selectMyOpenTasks(rows, "me")).toHaveLength(0);
  });
});

describe("my tasks — ordering (soonest deadline first, undated last)", () => {
  it("sorts dated tasks ascending and pushes undated to the end", () => {
    const rows = [
      row({ id: "none", due_on: null, label: "z" }),
      row({ id: "late", due_on: "2026-09-01" }),
      row({ id: "soon", due_on: "2026-08-20" }),
    ];
    expect(sortMyTasks(rows).map((r) => r.id)).toEqual(["soon", "late", "none"]);
  });

  it("is a total, stable order (label then id tiebreak on equal dates)", () => {
    const rows = [
      row({ id: "b", due_on: "2026-08-20", label: "Beta" }),
      row({ id: "a", due_on: "2026-08-20", label: "Alpha" }),
    ];
    expect(sortMyTasks(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("flags overdue against today", () => {
    expect(isTaskOverdue("2026-08-18", "2026-08-19")).toBe(true);
    expect(isTaskOverdue("2026-08-19", "2026-08-19")).toBe(false);
    expect(isTaskOverdue(null, "2026-08-19")).toBe(false);
  });
});

describe("migration 20261182000000 — assignment schema is tenant-safe", () => {
  const SRC = src("supabase/migrations/20261182000000_job_checklist_assignment.sql");

  it("adds assigned_to + due_on additively", () => {
    expect(SRC).toMatch(/add column if not exists assigned_to uuid/);
    expect(SRC).toMatch(/add column if not exists due_on date/);
  });

  it("enforces the org-membership dimension via the blessed assignee trigger", () => {
    // Cross-org assignee rejection — the same guard jobs/leads.assigned_to use.
    expect(SRC).toMatch(/execute function public\.tg_assignee_is_org_member\(\)/);
    expect(SRC).toMatch(/before insert or update on public\.job_checklists/);
  });

  it("preserves the item on user deletion (SET NULL, not cascade)", () => {
    expect(SRC).toMatch(/references public\.users\(id\) on delete set null/);
  });

  it("does not redefine or drop the completion trigger/provenance", () => {
    // It may REFERENCE the completion trigger in a comment (to say it's left
    // alone), but must never recreate the function or the trigger.
    expect(SRC).not.toMatch(/create\s+or\s+replace\s+function\s+public\.tg_job_checklist_completion/i);
    expect(SRC).not.toMatch(/create\s+trigger\s+job_checklists_completion/i);
    expect(SRC).not.toMatch(/drop\s+trigger\s+if\s+exists\s+job_checklists_completion/i);
  });
});

describe("checklist assignment action — org-scoped + real assignment (source pins)", () => {
  const SRC = src("app/(app)/jobs/[id]/checklist-actions.ts");

  it("verifies the assignee is a member of the active org before writing", () => {
    expect(SRC).toMatch(/verifyAssigneeInOrg\(supabase, parsed\.data\.assignedTo, ctx\.org\.id\)/);
  });

  it("pins the by-id assignment write to the active org", () => {
    expect(SRC).toMatch(
      /setChecklistAssignment[\s\S]*?\.eq\("id", itemId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("notifies a newly-assigned person (not on a due-date-only edit, not self)", () => {
    expect(SRC).toMatch(/assignee !== prior\.assigned_to && assignee !== user\.id/);
    expect(SRC).toMatch(/type: "job_checklist\.assigned"/);
  });

  it("only ever writes assigned_to/due_on — never touches is_done provenance", () => {
    expect(SRC).toMatch(/assigned_to: parsed\.data\.assignedTo, due_on: parsed\.data\.dueOn/);
  });
});
