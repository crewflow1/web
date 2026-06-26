import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { enqueueTask } from "@/server/services/hq-tasks";

/**
 * Shared Memory ⇄ Task Engine binding — the `bound_task_id` FK, real-Postgres proof
 * (CEO Directive #012 / D-02, PR-D · ADR-0006).
 *
 * The security tier pins the migration's SOURCE (references `hq_ai_tasks(id)`, `ON
 * DELETE SET NULL`, additive). This tier proves the live BEHAVIOUR neither can — that
 * the constraint actually RUNS in the database:
 *
 *   • a working memory bound to a task that does NOT exist is REJECTED (the foreign
 *     key — no dangling bindings reach the lifecycle worker);
 *   • a memory bound to a REAL task is accepted and persists the binding;
 *   • deleting that task NULLs the binding and the memory SURVIVES (`ON DELETE SET
 *     NULL`) — a task's lifecycle never deletes knowledge (ADR-0006).
 *
 * Runs only against a live DB (describeIntegration). Tasks are enqueued through the
 * sanctioned service path and tagged with a per-run task_type token; every fixture
 * (memories + tasks) is deleted on teardown.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface InsRet extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(row: Row): InsRet;
  delete(): DelChain;
}
const tbl = (name: string): Table =>
  (serviceClient() as unknown as { from(t: string): Table }).from(name);

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const TOKEN = `it_btfk_${alpha(8)}`;
const typeFor = (tag: string) => `${TOKEN}_${tag}`;

const memoryIds: string[] = [];
const taskIds: string[] = [];

/** Insert a working memory directly (service role), optionally bound to a task. */
async function insertMemory(boundTaskId: string | null): Promise<Res<Row[]>> {
  const res = await tbl("hq_memories")
    .insert({
      title: `btfk_${alpha(10)}`,
      summary: "fixture",
      body: "fixture body",
      memory_type: "research",
      source: "ai_employee",
      status: "active",
      visibility: "private",
      memory_class: "working",
      bound_task_id: boundTaskId,
    })
    .select("id, bound_task_id, status");
  const id = res.data?.[0]?.id as string | undefined;
  if (id) memoryIds.push(id);
  return res;
}

async function readMemory(id: string): Promise<Row | undefined> {
  const res = await tbl("hq_memories")
    .select("id, bound_task_id, status")
    .eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return res.data?.[0];
}

async function makeTask(tag: string): Promise<string> {
  const created = await enqueueTask({ taskType: typeFor(tag) });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("enqueue failed");
  taskIds.push(created.task.id);
  return created.task.id;
}

describeIntegration("Shared Memory ⇄ Task Engine · bound_task_id FK (Directive #012 / D-02, PR-D)", () => {
  beforeAll(async () => {
    const probe = await tbl("hq_memories").select("id");
    expect(probe.error, probe.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (memoryIds.length) await tbl("hq_memories").delete().in("id", memoryIds);
    if (taskIds.length) await tbl("hq_ai_tasks").delete().in("id", taskIds);
  });

  it("REJECTS a memory bound to a task that does not exist (the FK holds)", async () => {
    const res = await insertMemory(crypto.randomUUID()); // no such task
    expect(res.error, "a dangling binding must be refused").not.toBeNull();
    const code = res.error?.code;
    const msg = res.error?.message ?? "";
    expect(
      code === "23503" || /foreign key/i.test(msg) || msg.includes("hq_memories_bound_task_id_fkey"),
      `expected a foreign-key violation, got: ${code} ${msg}`,
    ).toBe(true);
  });

  it("ACCEPTS a memory bound to a real task and persists the binding", async () => {
    const taskId = await makeTask("ok");
    const res = await insertMemory(taskId);
    expect(res.error, res.error?.message).toBeNull();
    const row = res.data?.[0];
    expect(row?.bound_task_id).toBe(taskId);
  });

  it("ON DELETE SET NULL — deleting the task NULLs the binding, the memory SURVIVES", async () => {
    const taskId = await makeTask("setnull");
    const ins = await insertMemory(taskId);
    expect(ins.error, ins.error?.message).toBeNull();
    const memId = ins.data?.[0]?.id as string;
    expect(memId).toBeTruthy();

    // Delete the anchor task.
    const del = await tbl("hq_ai_tasks").delete().eq("id", taskId);
    expect(del.error, del.error?.message).toBeNull();

    // The memory is still there, its binding released — not cascade-deleted.
    const after = await readMemory(memId);
    expect(after, "the memory must survive its task's deletion").toBeTruthy();
    expect(after?.bound_task_id).toBeNull();
    expect(after?.status).toBe("active");
  });
});
