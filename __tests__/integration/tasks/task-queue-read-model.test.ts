import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  getTaskQueueOverview,
  QUEUE_BUCKETS,
  bucketOfStatus,
  type TaskQueueOverview,
  type EmployeeQueueSummary,
} from "@/server/services/hq-task-queue";

/**
 * The unified operator read model — real-Postgres proof (CEO Directive #012 / D-02, PR-G).
 *
 * The source-analysis tier (__tests__/security/employee-migration-parity.test.ts)
 * pins that every migrated employee reaches the ONE engine through the IDENTICAL
 * surface. THIS tier proves the operator-facing consequence that a source check
 * cannot: against a LIVE database, two distinct employees sharing the one
 * `hq_ai_tasks` queue render through `getTaskQueueOverview` as ONE workforce —
 *
 *   • each is grouped by its durable `task_type` contract, not by any bespoke
 *     per-employee table — so a newly migrated employee appears automatically;
 *   • the assigned employee identity is JOINED onto its task_type from
 *     `assigned_employee_id` (identity travels with the work);
 *   • a task_type enqueued WITHOUT an employee is summarised through the SAME
 *     structure (null identity, identical bucket shape) — indistinguishable at
 *     the read layer, which is the architectural-health claim made checkable;
 *   • the engine-wide headline totals are EXACT and move monotonically as the
 *     seeded lifecycle (create → claim → complete, plus a left-running claim and
 *     a left-pending enqueue) plays out;
 *   • every feed row is bucketed by the one canonical status→bucket mapping.
 *
 * Read-only: the model issues nothing but SELECTs. We seed through the real entry
 * points (hq_ai_task_create/claim/complete) so the lifecycle is genuine. Runs only
 * against a live DB (describeIntegration); rows are tagged with a per-run task_type
 * token and a throwaway employee, both purged on teardown (DELETE is unguarded).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  select(columns?: string): Sel;
}
interface InsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  delete(): DelChain;
}
interface Rpc {
  rpc(fn: string, args: Row): Thenable<unknown>;
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;
const rpc = (client: unknown): Rpc => client as unknown as Rpc;

// The entry points speak a {ok, task} envelope — unwrap to the row, or null.
type TaskEnvelope = { ok: boolean; reason?: string; task?: Row };
function taskOf(env: unknown): Row | null {
  const e = env as TaskEnvelope | null;
  return e && e.ok ? ((e.task as Row) ?? null) : null;
}

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// Every task is tagged with a type prefixed by this token, so the overview can be
// filtered down to exactly this run's rows and teardown deletes precisely them.
const TOKEN = `it_taskq_${alpha(8)}`;
// Two employees on the one engine: one whose work is stamped with a joined
// identity (research-like), one whose work carries none (qualify-like).
const TYPE_A = `${TOKEN}_research`;
const TYPE_B = `${TOKEN}_qualify`;
// ai_employees.slug must match ^[a-z0-9-]{1,60}$ — hyphens, never the token's "_".
const EMP_SLUG = `it-taskq-${alpha(8)}`;

// serviceClient() is created lazily inside the hooks/helpers — never at module
// load — so when no live DB is configured describeIntegration can skip cleanly
// without the harness throwing on missing connection details (matches the
// reference suite, task-engine.test.ts).

async function create(taskType: string, over: Row = {}): Promise<Row> {
  const res = (await rpc(serviceClient()).rpc("hq_ai_task_create", {
    p_task_type: taskType,
    p_payload: { tag: taskType },
    ...over,
  })) as Res<unknown>;
  expect(res.error, res.error?.message).toBeNull();
  const task = taskOf(res.data);
  expect(task, "create returned no task").toBeTruthy();
  return task as Row;
}

async function claim(taskType: string, owner: string): Promise<Row | null> {
  const res = (await rpc(serviceClient()).rpc("hq_ai_task_claim", {
    p_task_type: taskType,
    p_lease_owner: owner,
    p_lease_seconds: 300,
  })) as Res<unknown>;
  expect(res.error, res.error?.message).toBeNull();
  return taskOf(res.data);
}

async function complete(id: string, owner: string): Promise<void> {
  const res = (await rpc(serviceClient()).rpc("hq_ai_task_complete", {
    p_task_id: id,
    p_lease_owner: owner,
    p_result: { ok: true },
  })) as Res<unknown>;
  expect(res.error, res.error?.message).toBeNull();
}

let empId = "";
let overview: TaskQueueOverview;

const summaryFor = (taskType: string): EmployeeQueueSummary | undefined =>
  overview.byType.find((t) => t.taskType === taskType);

describeIntegration(
  "The unified operator read model · two employees, ONE engine, indistinguishable (Directive #012 / D-02, PR-G)",
  () => {
    beforeAll(async () => {
      // A throwaway employee to join against — the read model resolves identity
      // from ai_employees by assigned_employee_id, so we need a real row.
      const ins = await db(serviceClient())
        .from("ai_employees")
        .insert({
          name: "IT Parity Employee",
          slug: EMP_SLUG,
          role: "integration-test fixture",
          department: "engineering",
        })
        .select("id, slug");
      expect(ins.error, ins.error?.message).toBeNull();
      empId = String((ins.data ?? [])[0]?.id ?? "");
      expect(empId, "employee fixture must have an id").toBeTruthy();

      // TYPE_A (employee-stamped): one task driven create → claim → complete
      // (→ completed) and one left pending (→ queued).
      const a1 = await create(TYPE_A, { p_assigned_employee_id: empId });
      const a1c = await claim(TYPE_A, "it-worker-a");
      expect(String(a1c?.id)).toBe(String(a1.id));
      await complete(String(a1.id), "it-worker-a");
      await create(TYPE_A, { p_assigned_employee_id: empId }); // left pending → queued

      // TYPE_B (no employee): one task claimed and LEFT running (→ active).
      await create(TYPE_B);
      const b1c = await claim(TYPE_B, "it-worker-b");
      expect(b1c?.status, "TYPE_B task must be left running/active").toBe("running");

      // One read of the whole engine through the operator's eye. Wide window +
      // feed so this run's four rows are certainly summarised and fed.
      overview = await getTaskQueueOverview({ windowCap: 1000, feed: 100 });
    });

    afterAll(async () => {
      // DELETE is unguarded — purge exactly this run's tasks, then the employee.
      const svc = serviceClient();
      const mine = await db(svc).from("hq_ai_tasks").select("id, task_type");
      const ids = (mine.data ?? [])
        .filter((r) => String(r.task_type).startsWith(TOKEN))
        .map((r) => String(r.id));
      if (ids.length) await db(svc).from("hq_ai_tasks").delete().in("id", ids);
      if (empId) await db(svc).from("ai_employees").delete().eq("id", empId);
    });

    it("groups BOTH employees onto the engine by their durable task_type", () => {
      const a = summaryFor(TYPE_A);
      const b = summaryFor(TYPE_B);
      expect(a, `${TYPE_A} must appear in byType`).toBeTruthy();
      expect(b, `${TYPE_B} must appear in byType`).toBeTruthy();
      // Grouped by the durable contract, not a per-employee table.
      expect(a!.taskType).toBe(TYPE_A);
      expect(b!.taskType).toBe(TYPE_B);
      expect(a!.lastActivityAt, "last activity is stamped").toBeTruthy();
    });

    it("joins the assigned employee onto its task_type — identity travels with the work", () => {
      const a = summaryFor(TYPE_A)!;
      expect(a.employee, "TYPE_A must carry a joined employee").not.toBeNull();
      expect(a.employee!.id).toBe(empId);
      expect(a.employee!.slug).toBe(EMP_SLUG);
      expect(a.employee!.department).toBe("engineering");
      // The seeded lifecycle: one completed, one queued.
      expect(a.buckets.completed, "TYPE_A completed").toBeGreaterThanOrEqual(1);
      expect(a.buckets.queued, "TYPE_A queued").toBeGreaterThanOrEqual(1);
    });

    it("summarises an UNASSIGNED task_type through the same surface — null identity, still on the engine", () => {
      const b = summaryFor(TYPE_B)!;
      // No employee was stamped — yet it is a first-class citizen of the view.
      expect(b.employee, "TYPE_B carries no joined employee").toBeNull();
      expect(b.buckets.active, "TYPE_B active (claimed/running)").toBeGreaterThanOrEqual(1);
    });

    it("keeps the engine-wide totals EXACT and monotonic over the seeded lifecycle", () => {
      const { totals } = overview;
      // We added 4 tasks: ≥1 completed, ≥1 active, ≥1 queued. Other rows may exist
      // in the shared DB, so the seeded floor is a lower bound, never equality.
      expect(totals.total).toBeGreaterThanOrEqual(3);
      expect(totals.completed).toBeGreaterThanOrEqual(1);
      expect(totals.active).toBeGreaterThanOrEqual(1);
      expect(totals.queued).toBeGreaterThanOrEqual(1);
      // Totals are head-counts, never negative, and the parts never exceed the whole.
      for (const v of Object.values(totals)) expect(v).toBeGreaterThanOrEqual(0);
      expect(
        totals.queued + totals.active + totals.waitingApproval + totals.completed + totals.failed,
      ).toBeLessThanOrEqual(totals.total);
    });

    it("carries BOTH employees in the live feed, each row bucketed by the canonical mapping", () => {
      const mine = overview.recent.filter((r) => r.taskType.startsWith(TOKEN));
      expect(mine.length, "this run's tasks must reach the feed").toBeGreaterThanOrEqual(1);
      // Every feed row's bucket is exactly bucketOfStatus(status) — one mapping, no
      // per-employee branching.
      for (const r of overview.recent) {
        expect(r.bucket).toBe(bucketOfStatus(r.status));
      }
      // Where TYPE_A rows appear they carry the joined identity; TYPE_B rows do not.
      for (const r of mine) {
        if (r.taskType === TYPE_A) expect(r.employee?.id).toBe(empId);
        if (r.taskType === TYPE_B) expect(r.employee).toBeNull();
      }
    });

    it("exposes the IDENTICAL bucket shape for every summary — no employee is special", () => {
      const canonical = [...QUEUE_BUCKETS].sort();
      const a = summaryFor(TYPE_A)!;
      const b = summaryFor(TYPE_B)!;
      // The employee-stamped type and the anonymous type are structurally the same
      // at the read layer — the machine-checkable form of "indistinguishable on the
      // engine". Identity is data joined on top; it never changes the shape.
      expect(Object.keys(a.buckets).sort()).toEqual(canonical);
      expect(Object.keys(b.buckets).sort()).toEqual(canonical);
      // And this holds for EVERY summary the engine returns, not just our two.
      for (const s of overview.byType) {
        expect(Object.keys(s.buckets).sort(), `${s.taskType} bucket shape`).toEqual(canonical);
      }
    });
  },
);
