import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * The Product Pipeline on the Task Engine — real-Postgres proof (the pipeline_stage +
 * append-only stage-history gap). The security tier pins the source contract; this tier
 * proves the BEHAVIOUR a mock cannot, against a LIVE database with migration
 * 20261094000000 applied:
 *
 *   • pipeline_stage is ADDITIVE — a freshly created task is born with a NULL stage
 *     (every existing row stays valid), and hq_ai_task_create is unaffected;
 *   • hq_ai_task_set_stage moves the stage on an active task and appends exactly one
 *     immutable stage-event per transition (from_stage → to_stage);
 *   • an invalid stage is refused (invalid_stage); a terminal task is frozen
 *     (not_updatable);
 *   • the stage history is append-only (UPDATE and DELETE rejected even under
 *     service-role);
 *   • RLS:hq denies every JWT client (anon AND authenticated) on the child table.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_ai_task_stage_events is append-only and gates
 * its task via ON DELETE RESTRICT, so this suite's rows persist by design (harmless in
 * the ephemeral CI database), exactly like the Decision Centre suite.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;
type Envelope = { ok?: boolean; task?: Row | null; reason?: string };

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  maybeSingle(): Thenable<Row>;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
  rpc(fn: string, args: Record<string, unknown>): Thenable<Envelope>;
}
const db = (client: unknown): Db => client as unknown as Db;

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `pipe${alpha(10)}`;
const TASK_TYPE = `${TOKEN}_type`;

const TASK_IDS: string[] = [];

/** Create a task through the sanctioned entry point; assert it was born unstaged. */
async function createTask(): Promise<Row> {
  const res = await db(serviceClient()).rpc("hq_ai_task_create", {
    p_task_type: TASK_TYPE,
    p_payload: { probe: TOKEN },
  });
  expect(res.error, res.error?.message).toBeNull();
  const env = res.data as Envelope;
  expect(env.ok).toBe(true);
  const task = env.task as Row;
  expect(task.pipeline_stage ?? null, "a fresh task is born with a NULL stage").toBeNull();
  TASK_IDS.push(String(task.id));
  return task;
}

async function setStage(taskId: string, stage: string): Promise<Envelope> {
  const res = await db(serviceClient()).rpc("hq_ai_task_set_stage", {
    p_task_id: taskId,
    p_stage: stage,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Envelope;
}

async function stageEventsOf(taskId: string): Promise<Row[]> {
  const res = await db(serviceClient())
    .from("hq_ai_task_stage_events")
    .select("id, from_stage, to_stage, status, task_type")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

// A signed-in (authenticated) user, to prove RLS denies even a real JWT.
let userToken = "";

describeIntegration("The Product Pipeline · DB-enforced stage moves + immutable history", () => {
  beforeAll(async () => {
    const svc = serviceClient();
    const email = `it-pipeline-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    userToken = signedIn.data.session?.access_token ?? "";
    expect(userToken).toBeTruthy();
  });

  afterAll(async () => {
    // Stage events are append-only and gate their task via ON DELETE RESTRICT — the
    // seeded rows persist by design (harmless in the ephemeral CI database).
  });

  it("moves an active task along the pipeline, appending one immutable event per transition", async () => {
    const task = await createTask();
    const id = String(task.id);

    const first = await setStage(id, "engineering");
    expect(first.ok).toBe(true);
    expect((first.task as Row).pipeline_stage).toBe("engineering");

    const second = await setStage(id, "testing");
    expect(second.ok).toBe(true);
    expect((second.task as Row).pipeline_stage).toBe("testing");

    const events = await stageEventsOf(id);
    expect(events.map((e) => e.to_stage)).toEqual(["engineering", "testing"]);
    expect(events[0]!.from_stage ?? null).toBeNull();
    expect(events[1]!.from_stage).toBe("engineering");
    expect(events[1]!.task_type).toBe(TASK_TYPE);
  });

  it("refuses an unknown stage (invalid_stage) and writes no event", async () => {
    const task = await createTask();
    const id = String(task.id);

    const res = await setStage(id, "brainstorm");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_stage");

    expect(await stageEventsOf(id)).toHaveLength(0);
  });

  it("freezes a terminal task — set_stage returns not_updatable", async () => {
    const task = await createTask();
    const id = String(task.id);
    await setStage(id, "design");

    // Cancel (pending → cancelled is a legal, terminal transition) through the guard.
    const cancelled = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ status: "cancelled" })
      .eq("id", id);
    expect(cancelled.error, cancelled.error?.message).toBeNull();

    const res = await setStage(id, "deployment");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_updatable");

    // The stage history still carries ONLY the one legitimate move.
    const events = await stageEventsOf(id);
    expect(events.map((e) => e.to_stage)).toEqual(["design"]);
  });

  it("keeps the stage history append-only — UPDATE and DELETE are refused", async () => {
    const task = await createTask();
    const id = String(task.id);
    await setStage(id, "research");

    const events = await stageEventsOf(id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const eventId = String(events[0]!.id);

    const upd = await db(serviceClient())
      .from("hq_ai_task_stage_events")
      .update({ to_stage: "review" })
      .eq("id", eventId);
    expect(upd.error, "stage-event rows must not be updatable").not.toBeNull();

    const del = await db(serviceClient())
      .from("hq_ai_task_stage_events")
      .delete()
      .eq("id", eventId);
    expect(del.error, "stage-event rows must not be deletable").not.toBeNull();
  });

  it("denies every JWT client (anon AND authenticated) on the stage history — RLS:hq", async () => {
    const task = await createTask();
    const id = String(task.id);
    await setStage(id, "specification");

    // service_role (BYPASSRLS) sees the event…
    const asService = await db(serviceClient())
      .from("hq_ai_task_stage_events")
      .select("id")
      .eq("task_id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data?.length).toBeGreaterThanOrEqual(1);

    // …anon and an authenticated user do not.
    expectDenied(await db(anonClient()).from("hq_ai_task_stage_events").select("id").eq("task_id", id));
    expectDenied(await db(userClient(userToken)).from("hq_ai_task_stage_events").select("id").eq("task_id", id));
  });
});
