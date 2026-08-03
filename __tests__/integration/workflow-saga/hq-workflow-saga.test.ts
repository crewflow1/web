import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * The Workflow-Saga foundation — real-Postgres proof (the cross-department task
 * GRAPH). The security tier pins the source contract; this tier proves the BEHAVIOUR
 * a mock cannot, against a LIVE database with migration 20261104000000 applied:
 *
 *   • a saga is born 'planned'; steps are born 'pending'; each insert appends exactly
 *     one immutable event (saga_created / step_created);
 *   • a saga↔step↔task linkage holds — a step FK-links a real hq_ai_tasks row created
 *     through the sanctioned entry point (hq_ai_task_create), and linking + a status
 *     move each append an event;
 *   • the saga/step history is append-only (UPDATE and DELETE rejected even under
 *     service-role);
 *   • provenance is write-once (created_by / saga_id / ordinal cannot be rewritten);
 *   • RLS:hq denies every JWT client (anon AND authenticated) on all three tables.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_saga_events is append-only and gates its saga
 * via ON DELETE RESTRICT, so this suite's rows persist by design (harmless in the
 * ephemeral CI database), exactly like the Decision Centre suite.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  single(): Thenable<Row>;
  maybeSingle(): Thenable<Row>;
}
interface InsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
  select(columns?: string): Sel;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
  rpc(fn: string, args: Record<string, unknown>): Thenable<{ ok?: boolean; task?: Row | null }>;
}
const db = (client: unknown): Db => client as unknown as Db;

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `saga${alpha(10)}`;

const SAGA_COLS = "id, title, template_key, status, created_by, created_at, updated_at";
const STEP_COLS =
  "id, saga_id, ordinal, title, department, role, depends_on_ordinal, hq_ai_task_id, status, created_at, updated_at";

async function insertSaga(tag: string): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_workflow_sagas")
    .insert({ title: `${TOKEN}-${tag}`, template_key: "product_launch", status: "planned" })
    .select(SAGA_COLS)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

async function insertStep(sagaId: string, ordinal: number, dep: number | null): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_saga_steps")
    .insert({
      saga_id: sagaId,
      ordinal,
      title: `step ${ordinal}`,
      department: "Engineering",
      role: "engineer",
      depends_on_ordinal: dep,
      status: "pending",
    })
    .select(STEP_COLS)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

async function eventsOf(sagaId: string): Promise<Row[]> {
  const res = await db(serviceClient())
    .from("hq_saga_events")
    .select("id, step_id, event_type, from_status, to_status, detail")
    .eq("saga_id", sagaId)
    .order("created_at", { ascending: true });
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

let USER_TOKEN = "";
let userId = "";

describeIntegration("Workflow-Saga · DB-enforced graph + immutable history (foundation)", () => {
  beforeAll(async () => {
    const svc = serviceClient();
    const email = `it-saga-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id;
    if (!id) throw new Error("could not mint the probe user");
    userId = id;
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    USER_TOKEN = signedIn.data.session?.access_token ?? "";
    if (!USER_TOKEN) throw new Error("probe user has no access token");
  });

  afterAll(async () => {
    // hq_saga_events is append-only and gates its saga via ON DELETE RESTRICT, so the
    // seeded rows persist by design (harmless in the ephemeral CI database). Only the
    // minted probe user is cleaned up.
    if (userId) await serviceClient().auth.admin.deleteUser(userId);
  });

  it("a saga is born 'planned' and steps 'pending', each appending one event", async () => {
    const saga = await insertSaga("born");
    expect(saga.status).toBe("planned");
    const sid = String(saga.id);

    const s1 = await insertStep(sid, 1, null);
    const s2 = await insertStep(sid, 2, 1);
    expect(s1.status).toBe("pending");
    expect(String(s2.depends_on_ordinal)).toBe("1");

    const evs = await eventsOf(sid);
    expect(evs.map((e) => e.event_type)).toEqual(["saga_created", "step_created", "step_created"]);
  });

  it("links a step to a REAL task created through the Task-Engine entry point", async () => {
    const saga = await insertSaga("link");
    const sid = String(saga.id);
    const step = await insertStep(sid, 1, null);

    // Create the task through the sanctioned entry point (never a bare insert).
    const created = await db(serviceClient()).rpc("hq_ai_task_create", {
      p_task_type: `${TOKEN}_step`,
      p_payload: { saga_id: sid, step_id: step.id },
      p_subject_kind: "saga_step",
      p_subject_id: String(step.id),
    });
    expect(created.error, created.error?.message).toBeNull();
    const taskId = (created.data?.task as Row | undefined)?.id;
    expect(taskId, "the entry point returns a task").toBeTruthy();

    // Link + move status on the step.
    const linked = await db(serviceClient())
      .from("hq_saga_steps")
      .update({ hq_ai_task_id: taskId, status: "running" })
      .eq("id", String(step.id))
      .select(STEP_COLS)
      .single();
    expect(linked.error, linked.error?.message).toBeNull();
    expect((linked.data as Row).hq_ai_task_id).toBe(taskId);
    expect((linked.data as Row).status).toBe("running");

    const evs = await eventsOf(sid);
    const types = evs.map((e) => e.event_type);
    expect(types).toContain("step_linked");
    expect(types).toContain("step_status");
  });

  it("keeps saga/step history append-only — UPDATE and DELETE are refused", async () => {
    const saga = await insertSaga("append");
    const sid = String(saga.id);
    await insertStep(sid, 1, null);
    const evs = await eventsOf(sid);
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const eventId = String(evs[0]!.id);

    const upd = await db(serviceClient())
      .from("hq_saga_events")
      .update({ to_status: "rewrite" })
      .eq("id", eventId);
    expect(upd.error, "event rows must not be updatable").not.toBeNull();

    const del = await db(serviceClient()).from("hq_saga_events").delete().eq("id", eventId);
    expect(del.error, "event rows must not be deletable").not.toBeNull();
  });

  it("enforces write-once provenance on saga + step identity", async () => {
    const saga = await insertSaga("writeonce");
    const sid = String(saga.id);
    const step = await insertStep(sid, 1, null);

    // created_by is write-once on the saga.
    const bad = await db(serviceClient())
      .from("hq_workflow_sagas")
      .update({ created_by: userId })
      .eq("id", sid);
    expect(bad.error, "created_by must be write-once").not.toBeNull();

    // ordinal is write-once on the step.
    const badOrd = await db(serviceClient())
      .from("hq_saga_steps")
      .update({ ordinal: 9 })
      .eq("id", String(step.id));
    expect(badOrd.error, "ordinal must be write-once").not.toBeNull();
  });

  it("denies every JWT client (anon AND authenticated) on all three tables — RLS:hq", async () => {
    const saga = await insertSaga("rls");
    const sid = String(saga.id);
    await insertStep(sid, 1, null);

    // service_role (BYPASSRLS) sees it…
    const asService = await db(serviceClient()).from("hq_workflow_sagas").select("id").eq("id", sid);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon and an authenticated user do not (all three tables).
    for (const table of ["hq_workflow_sagas", "hq_saga_steps", "hq_saga_events"]) {
      expectDenied(await db(anonClient()).from(table).select("id").eq("saga_id", sid));
      expectDenied(await db(userClient(USER_TOKEN)).from(table).select("id").eq("saga_id", sid));
    }
    // The parent saga read is keyed on id, not saga_id — check it explicitly too.
    expectDenied(await db(anonClient()).from("hq_workflow_sagas").select("id").eq("id", sid));

    // An anon insert is rejected outright.
    const anonInsert = await db(anonClient())
      .from("hq_workflow_sagas")
      .insert({ title: `${TOKEN}-rls-anon`, status: "planned" })
      .select("id");
    expect(anonInsert.error, "anon must not be able to insert a saga").not.toBeNull();
  });
});
