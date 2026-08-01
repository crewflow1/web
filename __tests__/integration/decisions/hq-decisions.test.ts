import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * The Decision Centre — real-Postgres proof (Master-Plan Phase 16 + the HQ Layer-5
 * gap). The security tier pins the source contract; this tier proves the BEHAVIOUR a
 * mock cannot: against a LIVE database with the real migration applied, the database
 * itself is the unbypassable enforcer —
 *
 *   • each of the four outcomes transitions proposed → its terminal state, stamping
 *     decided_at and appending exactly one immutable history row;
 *   • delay_until / delegate_to / decision_reason persist as decided;
 *   • the invariants (decider required; reason required for reject/delay/delegate;
 *     delay_until required to delay; delegate_to required to delegate) are enforced by
 *     the trigger even for the service-role client that BYPASSES RLS;
 *   • a decided decision is terminal — an illegal RE-DECISION is refused;
 *   • the decision history is append-only (UPDATE/DELETE rejected);
 *   • RLS:hq denies every JWT client (anon AND authenticated).
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_decision_events is append-only, so its rows
 * are left behind (harmless in the ephemeral CI database); the hq_decisions rows and
 * the minted decider are deleted on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  limit(n: number): Sel;
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
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;

const COLS =
  "id, title, problem, business_impact, revenue_impact, demand, engineering_cost, risk, " +
  "timeline, ai_debate, recommendation, status, decided_by, decided_at, delegate_to, " +
  "delay_until, decision_reason, created_by, created_at, updated_at";

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `dec${alpha(10)}`;

// Track every id we create so teardown deletes exactly this suite's decisions.
const DECISION_IDS: string[] = [];

/** Insert a fresh `proposed` decision via service_role; assert it was born clean. */
async function insertProposed(tag: string, over: Row = {}): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_decisions")
    .insert({
      title: `${TOKEN}-${tag}`,
      problem: "A strategic question awaiting judgement.",
      created_by: DECIDER_ID,
      status: "proposed",
      ...over,
    })
    .select(COLS)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const row = res.data as Row;
  DECISION_IDS.push(String(row.id));
  return row;
}

async function readRow(id: string): Promise<Row | null> {
  const res = await db(serviceClient()).from("hq_decisions").select(COLS).eq("id", id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

async function historyOf(decisionId: string): Promise<Row[]> {
  const res = await db(serviceClient())
    .from("hq_decision_events")
    .select("id, event_type, from_status, to_status, actor_id, reason, delegate_to, delay_until")
    .eq("decision_id", decisionId)
    .order("created_at", { ascending: true });
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** The i-th history row, asserting presence (and satisfying strict index access). */
function nth(rows: Row[], i: number): Row {
  const row = rows[i];
  expect(row, `expected a history row at index ${i}`).toBeTruthy();
  if (!row) throw new Error(`missing history row ${i}`);
  return row;
}

/** A denial is valid whether a hard privilege error or an RLS-filtered empty set. */
function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

// Seeded in beforeAll: a real decider (auth.users + mirrored public.users row for the
// decided_by / delegate_to FKs). Deliberately NOT a super-admin (RLS + the service
// gate are proven independently below).
let DECIDER_ID = "";
let decider: { id: string; email: string; token: string };

describeIntegration("The Decision Centre · DB-enforced outcomes + immutable history (Phase 16)", () => {
  beforeAll(async () => {
    const svc = serviceClient();
    const email = `it-decisions-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id;
    if (!id) throw new Error("could not mint the decider auth user");
    const mirrored = await db(svc).from("users").insert({ id, email }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token;
    if (!token) throw new Error("decider has no access token");
    DECIDER_ID = id;
    decider = { id, email, token };
  });

  afterAll(async () => {
    const svc = serviceClient();
    // hq_decisions + hq_decision_events are an append-only audit record: events are
    // block-mutation (no DELETE) and gate the decision via ON DELETE RESTRICT, so the
    // seeded rows persist by design (harmless in the ephemeral CI database). Only the
    // minted decider is cleaned up — which now succeeds because the FK set-null path is
    // permitted on terminal rows (see the GDPR-erasure test below).
    if (decider?.id) await svc.auth.admin.deleteUser(decider.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Each of the four outcomes, walked through the database itself.
  // ─────────────────────────────────────────────────────────────────────────
  it("approves a proposed decision — stamps decided_at, appends the history row", async () => {
    const born = await insertProposed("approve");
    expect(born.status).toBe("proposed");
    expect(born.decided_at).toBeNull();
    const id = String(born.id);

    const approved = await db(serviceClient())
      .from("hq_decisions")
      .update({ status: "approved", decided_by: decider.id })
      .eq("id", id)
      .select(COLS)
      .single();
    expect(approved.error, approved.error?.message).toBeNull();
    expect((approved.data as Row).status).toBe("approved");
    expect((approved.data as Row).decided_at).toBeTruthy();

    const events = await historyOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["proposed", "approved"]);
    expect(nth(events, 1).from_status).toBe("proposed");
    expect(nth(events, 1).actor_id).toBe(decider.id);
  });

  it("rejects with a reason — persists the reason and records it in history", async () => {
    const born = await insertProposed("reject");
    const id = String(born.id);

    const rejected = await db(serviceClient())
      .from("hq_decisions")
      .update({ status: "rejected", decided_by: decider.id, decision_reason: "Not aligned this quarter." })
      .eq("id", id)
      .select(COLS)
      .single();
    expect(rejected.error, rejected.error?.message).toBeNull();
    expect((rejected.data as Row).status).toBe("rejected");
    expect((rejected.data as Row).decision_reason).toBe("Not aligned this quarter.");

    const events = await historyOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["proposed", "rejected"]);
    expect(nth(events, 1).reason).toBe("Not aligned this quarter.");
  });

  it("delays with delay_until + reason — both persist", async () => {
    const born = await insertProposed("delay");
    const id = String(born.id);

    const delayed = await db(serviceClient())
      .from("hq_decisions")
      .update({
        status: "delayed",
        decided_by: decider.id,
        decision_reason: "Revisit after the Q3 numbers land.",
        delay_until: "2026-10-01",
      })
      .eq("id", id)
      .select(COLS)
      .single();
    expect(delayed.error, delayed.error?.message).toBeNull();
    expect((delayed.data as Row).status).toBe("delayed");
    expect(String((delayed.data as Row).delay_until)).toContain("2026-10-01");

    const events = await historyOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["proposed", "delayed"]);
    expect(String(nth(events, 1).delay_until)).toContain("2026-10-01");
  });

  it("delegates with delegate_to + reason — both persist", async () => {
    const born = await insertProposed("delegate");
    const id = String(born.id);

    const delegated = await db(serviceClient())
      .from("hq_decisions")
      .update({
        status: "delegated",
        decided_by: decider.id,
        decision_reason: "Owned by the platform team.",
        delegate_to: decider.id,
      })
      .eq("id", id)
      .select(COLS)
      .single();
    expect(delegated.error, delegated.error?.message).toBeNull();
    expect((delegated.data as Row).status).toBe("delegated");
    expect((delegated.data as Row).delegate_to).toBe(decider.id);

    const events = await historyOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["proposed", "delegated"]);
    expect(nth(events, 1).delegate_to).toBe(decider.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The structural guarantees, each proven illegal at the DB.
  // ─────────────────────────────────────────────────────────────────────────
  it("enforces born-proposed — a decision cannot be inserted into a decided state", async () => {
    for (const status of ["approved", "rejected", "delayed", "delegated"]) {
      const res = await db(serviceClient())
        .from("hq_decisions")
        .insert({
          title: `${TOKEN}-born-${status}`,
          created_by: DECIDER_ID,
          status,
          decided_by: decider.id,
          decision_reason: "x",
          delay_until: "2026-10-01",
          delegate_to: decider.id,
        })
        .select("id");
      expect(res.error, `insert into status ${status} must be rejected`).not.toBeNull();
    }
  });

  it("requires a decider for every outcome, and the right inputs per outcome", async () => {
    const born = await insertProposed("invariants");
    const id = String(born.id);

    // No decider.
    expect(
      (await db(serviceClient()).from("hq_decisions").update({ status: "approved" }).eq("id", id))
        .error,
      "approve without a decider must be rejected",
    ).not.toBeNull();

    // Reject without a reason.
    expect(
      (
        await db(serviceClient())
          .from("hq_decisions")
          .update({ status: "rejected", decided_by: decider.id })
          .eq("id", id)
      ).error,
      "reject without a reason must be rejected",
    ).not.toBeNull();

    // Delay without delay_until.
    expect(
      (
        await db(serviceClient())
          .from("hq_decisions")
          .update({ status: "delayed", decided_by: decider.id, decision_reason: "later" })
          .eq("id", id)
      ).error,
      "delay without delay_until must be rejected",
    ).not.toBeNull();

    // Delegate without delegate_to.
    expect(
      (
        await db(serviceClient())
          .from("hq_decisions")
          .update({ status: "delegated", decided_by: decider.id, decision_reason: "to team" })
          .eq("id", id)
      ).error,
      "delegate without delegate_to must be rejected",
    ).not.toBeNull();

    // The row was never moved.
    expect((await readRow(id))?.status).toBe("proposed");
  });

  it("refuses an illegal RE-DECISION — a decided decision is terminal and immutable", async () => {
    const born = await insertProposed("redecide");
    const id = String(born.id);

    const approved = await db(serviceClient())
      .from("hq_decisions")
      .update({ status: "approved", decided_by: decider.id })
      .eq("id", id)
      .select("status")
      .single();
    expect(approved.error, approved.error?.message).toBeNull();
    expect((approved.data as Row).status).toBe("approved");

    // Re-decide → refused. Try flipping to another terminal state…
    const reReject = await db(serviceClient())
      .from("hq_decisions")
      .update({ status: "rejected", decided_by: decider.id, decision_reason: "changed my mind" })
      .eq("id", id);
    expect(reReject.error, "a decided decision must not be re-decided").not.toBeNull();

    // …and any mutation at all.
    const tamper = await db(serviceClient())
      .from("hq_decisions")
      .update({ decision_reason: "tampered" })
      .eq("id", id);
    expect(tamper.error, "a terminal decision row must be immutable").not.toBeNull();

    expect((await readRow(id))?.status).toBe("approved");
    // History carries exactly the two legitimate transitions — no third row.
    const events = await historyOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["proposed", "approved"]);
  });

  it("keeps the decision history append-only — UPDATE and DELETE are refused", async () => {
    const born = await insertProposed("history");
    const id = String(born.id);
    await db(serviceClient())
      .from("hq_decisions")
      .update({ status: "approved", decided_by: decider.id })
      .eq("id", id)
      .select("status")
      .single();

    const events = await historyOf(id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const eventId = String(nth(events, 0).id);

    const upd = await db(serviceClient())
      .from("hq_decision_events")
      .update({ reason: "rewrite history" })
      .eq("id", eventId);
    expect(upd.error, "history rows must not be updatable").not.toBeNull();

    const del = await db(serviceClient()).from("hq_decision_events").delete().eq("id", eventId);
    expect(del.error, "history rows must not be deletable").not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS:hq — the Decision Centre is HQ infrastructure; tenants never see it.
  // ─────────────────────────────────────────────────────────────────────────
  it("denies every JWT client (anon AND authenticated) read and write access — RLS:hq", async () => {
    const born = await insertProposed("rls");
    const id = String(born.id);

    // service_role (BYPASSRLS) sees it…
    const asService = await db(serviceClient()).from("hq_decisions").select("id").eq("id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon and an authenticated user do not (decisions + history).
    expectDenied(await db(anonClient()).from("hq_decisions").select("id").eq("id", id));
    expectDenied(await db(userClient(decider.token)).from("hq_decisions").select("id").eq("id", id));
    expectDenied(await db(anonClient()).from("hq_decision_events").select("id").eq("decision_id", id));

    // An anon insert is rejected outright.
    const anonInsert = await db(anonClient())
      .from("hq_decisions")
      .insert({ title: `${TOKEN}-rls-anon`, status: "proposed" })
      .select("id");
    expect(anonInsert.error, "anon must not be able to insert a decision").not.toBeNull();
  });

  // GDPR right-to-erasure vs the immutability guard. A terminal decision is frozen —
  // but deleting a referenced user must still succeed (erasure), nulling decided_by via
  // the FK set-null path. The guard permits EXACTLY that transition and nothing else.
  it("erasing a decider nulls decided_by on a terminal decision, which otherwise stays frozen", async () => {
    const svc = serviceClient();
    const email = `it-decisions-gdpr-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const created = await svc.auth.admin.createUser({
      email, password: `Pw!${alpha(10)}${Date.now()}`, email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const uid = created.data.user?.id;
    if (!uid) throw new Error("could not mint the throwaway decider");
    const mirror = await db(svc).from("users").insert({ id: uid, email }).select("id").single();
    expect(mirror.error, mirror.error?.message).toBeNull();

    const born = await insertProposed("gdpr");
    const id = String(born.id);
    const approved = await db(svc)
      .from("hq_decisions")
      .update({ status: "approved", decided_by: uid })
      .eq("id", id);
    expect(approved.error, approved.error?.message).toBeNull();

    // Previously this FAILED — the ON DELETE SET NULL fired the immutability guard.
    const erased = await svc.auth.admin.deleteUser(uid);
    expect(erased.error, erased.error?.message ?? "erasing a decider must succeed").toBeNull();

    const after = await readRow(id);
    expect(after?.status, "the terminal decision survives erasure").toBe("approved");
    expect(after?.decided_by ?? null, "decided_by is nulled by the FK set-null path").toBeNull();

    // …but the row is still frozen to a REAL edit.
    const tamper = await db(svc)
      .from("hq_decisions")
      .update({ recommendation: "tampered after the fact" })
      .eq("id", id);
    expect(tamper.error, "a terminal decision must stay immutable to real edits").not.toBeNull();
  });
});
