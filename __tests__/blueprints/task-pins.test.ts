import { describe, it, expect } from "vitest";
import {
  pinDisplayStatus,
  pinShortLabel,
  filterPins,
  isTaskPinDone,
  PIN_KINDS,
  TASK_PIN_STATUSES,
  createTaskPinSchema,
  updateTaskPinSchema,
  type BlueprintPin,
} from "@/lib/blueprints/pins";

const VER = "22222222-2222-2222-2222-222222222222";
const PIN = "11111111-1111-1111-1111-111111111111";
const USR = "33333333-3333-3333-3333-333333333333";

const taskPin = (over: Partial<BlueprintPin>): BlueprintPin => ({
  id: PIN,
  blueprint_version_id: VER,
  page_number: 1,
  u: 0.5,
  v: 0.5,
  kind: "task",
  title: "Fit handrail",
  note: null,
  snag_id: null,
  created_at: "2026-08-14T00:00:00Z",
  task_status: "open",
  assigned_to: null,
  due_date: null,
  ...over,
});

describe("task pin — kind is first-class", () => {
  it("'task' is a recognised pin kind", () => {
    expect(PIN_KINDS).toContain("task");
  });
  it("has a three-state lifecycle open -> in_progress -> done", () => {
    expect([...TASK_PIN_STATUSES]).toEqual(["open", "in_progress", "done"]);
  });
  it("only 'done' is terminal", () => {
    expect(isTaskPinDone("done")).toBe(true);
    expect(isTaskPinDone("open")).toBe(false);
    expect(isTaskPinDone("in_progress")).toBe(false);
  });
});

describe("pinDisplayStatus — a task pin OWNS its status (not derived from a snag)", () => {
  it("maps open/in_progress/done to open/progress/resolved tones", () => {
    expect(pinDisplayStatus(taskPin({ task_status: "open" }))).toEqual({ label: "Open", tone: "open" });
    expect(pinDisplayStatus(taskPin({ task_status: "in_progress" }))).toEqual({ label: "In progress", tone: "progress" });
    expect(pinDisplayStatus(taskPin({ task_status: "done" }))).toEqual({ label: "Done", tone: "resolved" });
  });
  it("defaults a null task_status to Open (never reads a snag)", () => {
    expect(pinDisplayStatus(taskPin({ task_status: null }))).toEqual({ label: "Open", tone: "open" });
  });
});

describe("pinShortLabel — task", () => {
  it("uses the title", () => {
    expect(pinShortLabel(taskPin({ title: "Seal window" }))).toBe("Seal window");
  });
  it("falls back to the note, then to 'Task'", () => {
    expect(pinShortLabel(taskPin({ title: null, note: "chase up supplier" }))).toBe("chase up supplier");
    expect(pinShortLabel(taskPin({ title: null, note: null }))).toBe("Task");
  });
});

describe("filterPins — task lifecycle participates in open/resolved", () => {
  const pins: BlueprintPin[] = [
    taskPin({ id: "a", task_status: "open" }),
    taskPin({ id: "b", task_status: "in_progress" }),
    taskPin({ id: "c", task_status: "done" }),
  ];
  it("'open' excludes done tasks", () => {
    const out = filterPins(pins, { kind: "all", status: "open" }).map((p) => p.id);
    expect(out).toEqual(["a", "b"]);
  });
  it("'resolved' keeps only done tasks", () => {
    const out = filterPins(pins, { kind: "all", status: "resolved" }).map((p) => p.id);
    expect(out).toEqual(["c"]);
  });
  it("kind filter isolates tasks", () => {
    const mixed = [...pins, taskPin({ id: "n", kind: "note", note: "x", task_status: null })];
    expect(filterPins(mixed, { kind: "task", status: "all" }).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("createTaskPinSchema", () => {
  const base = { blueprint_version_id: VER, page_number: 1, u: 0.5, v: 0.5 };
  it("requires a title", () => {
    expect(createTaskPinSchema.safeParse({ ...base, title: "" }).success).toBe(false);
    expect(createTaskPinSchema.safeParse({ ...base, title: "Do the thing" }).success).toBe(true);
  });
  it("treats an empty assignee/due as absent", () => {
    const parsed = createTaskPinSchema.parse({ ...base, title: "T", assigned_to: "", due_date: "" });
    expect(parsed.assigned_to).toBeUndefined();
    expect(parsed.due_date).toBeUndefined();
  });
  it("accepts a valid assignee uuid + ISO date", () => {
    const parsed = createTaskPinSchema.parse({ ...base, title: "T", assigned_to: USR, due_date: "2026-09-01" });
    expect(parsed.assigned_to).toBe(USR);
    expect(parsed.due_date).toBe("2026-09-01");
  });
  it("rejects a malformed due date", () => {
    expect(createTaskPinSchema.safeParse({ ...base, title: "T", due_date: "01/09/2026" }).success).toBe(false);
  });
});

describe("updateTaskPinSchema — null clears, undefined leaves unchanged", () => {
  it("maps empty-string assignee/due to null (a clear), not undefined", () => {
    const parsed = updateTaskPinSchema.parse({ id: PIN, assigned_to: "", due_date: "" });
    expect(parsed.assigned_to).toBeNull();
    expect(parsed.due_date).toBeNull();
  });
  it("omitting a field leaves it undefined (patch skips it)", () => {
    const parsed = updateTaskPinSchema.parse({ id: PIN, status: "done" });
    expect(parsed.status).toBe("done");
    expect(parsed.assigned_to).toBeUndefined();
    expect(parsed.due_date).toBeUndefined();
  });
  it("rejects an unknown status", () => {
    expect(updateTaskPinSchema.safeParse({ id: PIN, status: "archived" }).success).toBe(false);
  });
});
