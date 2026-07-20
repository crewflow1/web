import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

// The service module is loaded LAZILY (in beforeAll, only when the suite actually
// runs) rather than statically. It transitively imports @/lib/env, which VALIDATES
// the environment at module-load and throws if NEXT_PUBLIC_APP_URL et al. are
// absent. A static import would therefore (a) break the clean local skip — env is
// unset with no DB — and (b) be the first integration suite to require
// NEXT_PUBLIC_APP_URL in CI. Deferring the import past the skip decision, and after
// bridgeServiceEnv() satisfies lib/env, keeps both paths honest. The raw-DB tests
// below need no service at all — they drive the database directly.
type ApprovalsService = typeof import("@/server/services/hq-approvals");
let api: ApprovalsService;

/**
 * The Approval Engine — real-Postgres proof (CEO Directive 010, Phase 2). Gate 4.
 *
 * The unit tier proves the pure transition map (lib/approvals/state.ts) and the
 * security tier pins that the map, the migration and the service AGREE in source.
 * This tier proves the BEHAVIOUR neither a mock nor a source check can: that against
 * a LIVE database with the real migration applied, the database itself is the
 * unbypassable enforcer the CEO success criteria demand —
 *
 *   • the deterministic state machine is enforced by the BEFORE trigger, so an
 *     illegal transition, a retroactive edit to the proposal, a decision without a
 *     reviewer, a rejection without a reason, and ANY mutation of a terminal row are
 *     all structurally impossible — even for the service-role client that BYPASSES
 *     RLS (the boundary "cannot be bypassed", architecture not convention);
 *   • every transition emits exactly one canonical, honestly-attributed `approval.*`
 *     spine event IN THE SAME TRANSACTION (the immutable audit trail), so state and
 *     narrative are inseparable;
 *   • recovery never mutates the frozen record — it is a fresh `pending` row that
 *     `supersedes` the old one;
 *   • RLS:hq denies every JWT client (anon AND authenticated);
 *   • the service wire reaches Postgres for the one non-gated entry point
 *     (requestApproval), and the reviewer gate DENIES a non-HQ caller live — the
 *     engine cannot be driven to a decision by anyone but a super-admin.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_events is append-only, so the spine rows are
 * left behind (harmless in the ephemeral CI database); the hq_approvals rows and the
 * minted reviewer are deleted on teardown.
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

const APPROVAL_COLS =
  "id, ai_employee_id, subject_type, subject_id, action, proposed_payload, edited_payload, " +
  "state, decision_reason, reviewer_id, reviewer_email, correlation_id, supersedes_id, " +
  "requested_at, decided_at, escalated_at, expires_at";

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `appr${alpha(10)}`;
const SUBJECT_TYPE = "outreach_email";
function subjectFor(tag: string): string {
  return `${TOKEN}-${tag}`;
}

// Every correlation id we mint is tracked so teardown can delete exactly this
// suite's hq_approvals rows (the spine rows are append-only and stay behind).
const CORRELATIONS: string[] = [];
function newCorrelation(): string {
  const id = crypto.randomUUID();
  CORRELATIONS.push(id);
  return id;
}

// Satisfy the names the service's module graph needs BEFORE it is imported:
//   • createAdminClient reads NEXT_PUBLIC_SUPABASE_URL; CI exports the live stack
//     under the bare SUPABASE_URL, so mirror it (and the anon key) across.
//   • @/lib/env validates NEXT_PUBLIC_APP_URL at module-load; the integration CI
//     job doesn't set it (no app boots here), so default it to a valid URL. This is
//     test-process-only and never leaks into the assertions, which read the DB.
function bridgeServiceEnv(): void {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY) {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  }
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  }
}

/** A denial is valid whether it is a hard privilege error or an RLS-filtered empty set. */
function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

/** Insert a fresh `pending` approval via service_role; assert it was born clean. */
async function insertPending(correlationId: string, tag: string, over: Row = {}): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_approvals")
    .insert({
      ai_employee_id: EMPLOYEE_ID,
      subject_type: SUBJECT_TYPE,
      subject_id: subjectFor(tag),
      action: "send",
      proposed_payload: { subject: "Quarterly check-in", body: "Hi there — proposed draft." },
      correlation_id: correlationId,
      state: "pending",
      ...over,
    })
    .select(APPROVAL_COLS)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

/** Read one approval row back by id (service_role ground truth). */
async function readRow(id: string): Promise<Row | null> {
  const res = await db(serviceClient())
    .from("hq_approvals")
    .select(APPROVAL_COLS)
    .eq("id", id)
    .maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

/** All spine events for one correlation, keyed by verb (one per verb in these traces). */
async function eventsByVerb(correlationId: string): Promise<Record<string, Row>> {
  const res = await db(serviceClient())
    .from("hq_events")
    .select("id, verb, actor_type, actor_id, severity, causation_id, payload")
    .eq("correlation_id", correlationId);
  expect(res.error, res.error?.message).toBeNull();
  const out: Record<string, Row> = {};
  for (const row of res.data ?? []) out[String(row.verb)] = row;
  return out;
}

/** Fetch a required event by verb, asserting presence (and satisfying strict index access). */
function requireEvent(ev: Record<string, Row>, verb: string): Row {
  const row = ev[verb];
  expect(row, `missing spine event ${verb}`).toBeTruthy();
  if (!row) throw new Error(`missing spine event ${verb}`);
  return row;
}

// Seeded in beforeAll: a real proposer (ai_employees) and a real reviewer
// (auth.users + the mirrored public.users row the reviewer_id FK requires).
let EMPLOYEE_ID = "";
let reviewer: { id: string; email: string; token: string };

describeIntegration("The Approval Engine · DB-enforced lifecycle + spine audit (Directive 010 Phase 2)", () => {
  beforeAll(async () => {
    // Bridge env BEFORE importing the service (its graph validates env at load).
    bridgeServiceEnv();
    api = await import("@/server/services/hq-approvals");
    const svc = serviceClient();

    // A proposer: any registered AI employee satisfies the write-once FK.
    const employee = await db(svc).from("ai_employees").select("id").limit(1).single();
    expect(employee.error, employee.error?.message).toBeNull();
    EMPLOYEE_ID = String((employee.data as { id?: string })?.id ?? "");
    if (!EMPLOYEE_ID) throw new Error("no ai_employees row to act as the proposer — is the roster migration applied?");

    // A reviewer: mint an auth user, then mirror it into public.users (no
    // handle_new_user trigger exists) so reviewer_id's FK is satisfiable. The
    // probe email is deliberately NOT a super-admin, so the service gate denies it.
    const email = `it-approvals-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const reviewerId = created.data.user?.id;
    if (!reviewerId) throw new Error("could not mint the reviewer auth user");
    const mirrored = await db(svc).from("users").insert({ id: reviewerId, email }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token;
    if (!token) throw new Error("reviewer has no access token");
    reviewer = { id: reviewerId, email, token };
  });

  afterAll(async () => {
    const svc = serviceClient();
    if (CORRELATIONS.length) {
      await db(svc).from("hq_approvals").delete().in("correlation_id", CORRELATIONS);
    }
    // Deleting the auth user cascades to the mirrored public.users row.
    if (reviewer?.id) await svc.auth.admin.deleteUser(reviewer.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The happy path, walked through the database itself.
  // ─────────────────────────────────────────────────────────────────────────
  it("walks request → escalate → approve, stamping timestamps and emitting honest spine events", async () => {
    const correlation = newCorrelation();
    const born = await insertPending(correlation, "happy");
    expect(born.state).toBe("pending");
    expect(born.requested_at).toBeTruthy();
    expect(born.escalated_at).toBeNull();
    expect(born.decided_at).toBeNull();
    const id = String(born.id);

    const escalated = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "escalated", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
      .eq("id", id)
      .select(APPROVAL_COLS)
      .single();
    expect(escalated.error, escalated.error?.message).toBeNull();
    expect((escalated.data as Row).state).toBe("escalated");
    expect((escalated.data as Row).escalated_at).toBeTruthy();

    const approved = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "approved", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
      .eq("id", id)
      .select(APPROVAL_COLS)
      .single();
    expect(approved.error, approved.error?.message).toBeNull();
    expect((approved.data as Row).state).toBe("approved");
    expect((approved.data as Row).decided_at).toBeTruthy();

    // The full trace landed in the spine, honestly attributed.
    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev).sort()).toEqual(
      ["approval.escalated", "approval.granted", "approval.requested"].sort(),
    );
    expect(requireEvent(ev, "approval.requested").actor_type).toBe("ai_employee");
    expect(requireEvent(ev, "approval.requested").severity).toBe("info");
    expect(requireEvent(ev, "approval.escalated").actor_type).toBe("human");
    expect(requireEvent(ev, "approval.escalated").severity).toBe("warn");
    expect(requireEvent(ev, "approval.granted").actor_type).toBe("human");
    expect(requireEvent(ev, "approval.granted").severity).toBe("success");

    // Terminal immutability: the frozen row rejects ALL further mutation.
    const tamper = await db(serviceClient())
      .from("hq_approvals")
      .update({ reviewer_email: "tampered@example.com" })
      .eq("id", id);
    expect(tamper.error, "an approved row must be immutable").not.toBeNull();
    const after = await readRow(id);
    expect(after?.state).toBe("approved");
    expect(after?.reviewer_email).toBe(reviewer.email);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The structural guarantees, each proven illegal at the DB.
  // ─────────────────────────────────────────────────────────────────────────
  it("enforces born-pending — an approval cannot be inserted into a non-pending state", async () => {
    for (const state of ["approved", "escalated", "rejected", "expired"]) {
      const res = await db(serviceClient())
        .from("hq_approvals")
        .insert({
          ai_employee_id: EMPLOYEE_ID,
          subject_type: SUBJECT_TYPE,
          subject_id: subjectFor("born"),
          action: "send",
          state,
          reviewer_id: reviewer.id,
          reviewer_email: reviewer.email,
          decision_reason: "x",
        })
        .select("id");
      expect(res.error, `insert into state ${state} must be rejected`).not.toBeNull();
    }
  });

  it("keeps the proposal write-once — what was proposed can never be rewritten, only decided", async () => {
    const correlation = newCorrelation();
    const row = await insertPending(correlation, "writeonce");
    const id = String(row.id);

    const tamperPayload = await db(serviceClient())
      .from("hq_approvals")
      .update({ proposed_payload: { subject: "TAMPERED", body: "rewritten" } })
      .eq("id", id);
    expect(tamperPayload.error, "proposed_payload must be write-once").not.toBeNull();

    const tamperSubject = await db(serviceClient())
      .from("hq_approvals")
      .update({ subject_id: "a-different-subject" })
      .eq("id", id);
    expect(tamperSubject.error, "subject_id must be write-once").not.toBeNull();

    const after = await readRow(id);
    expect((after?.proposed_payload as Row)?.subject).toBe("Quarterly check-in");
    expect(after?.subject_id).toBe(subjectFor("writeonce"));
  });

  it("requires a reviewer AND a reason to reject — then rejects, stamping decided_at and the spine", async () => {
    const correlation = newCorrelation();
    const row = await insertPending(correlation, "reject");
    const id = String(row.id);

    const noReason = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "rejected", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
      .eq("id", id);
    expect(noReason.error, "a rejection without a reason must be rejected").not.toBeNull();

    const noReviewer = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "rejected", decision_reason: "off brand" })
      .eq("id", id);
    expect(noReviewer.error, "a rejection without a reviewer must be rejected").not.toBeNull();

    const rejected = await db(serviceClient())
      .from("hq_approvals")
      .update({
        state: "rejected",
        decision_reason: "Subject line is off-brand; revise the opener.",
        reviewer_id: reviewer.id,
        reviewer_email: reviewer.email,
      })
      .eq("id", id)
      .select(APPROVAL_COLS)
      .single();
    expect(rejected.error, rejected.error?.message).toBeNull();
    expect((rejected.data as Row).state).toBe("rejected");
    expect((rejected.data as Row).decided_at).toBeTruthy();

    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev).sort()).toEqual(["approval.rejected", "approval.requested"].sort());
    expect(requireEvent(ev, "approval.rejected").actor_type).toBe("human");
    expect(requireEvent(ev, "approval.rejected").severity).toBe("warn");
    // The operator-authored reason is carried (truncated) in the audit payload.
    expect(String((requireEvent(ev, "approval.rejected").payload as Row)?.reason)).toContain("off-brand");
  });

  it("forbids de-escalation — an escalated item can never move back to pending", async () => {
    const correlation = newCorrelation();
    const row = await insertPending(correlation, "deescalate");
    const id = String(row.id);

    const escalate = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "escalated", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
      .eq("id", id)
      .select("state")
      .single();
    expect(escalate.error, escalate.error?.message).toBeNull();
    expect((escalate.data as Row).state).toBe("escalated");

    const deescalate = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "pending" })
      .eq("id", id);
    expect(deescalate.error, "de-escalation escalated → pending must be rejected").not.toBeNull();
    expect((await readRow(id))?.state).toBe("escalated");
  });

  it("expires as a SYSTEM act — no reviewer required, attributed to system in the spine", async () => {
    const correlation = newCorrelation();
    const row = await insertPending(correlation, "expire");
    const id = String(row.id);

    const expired = await db(serviceClient())
      .from("hq_approvals")
      .update({ state: "expired" }) // no reviewer, no reason
      .eq("id", id)
      .select(APPROVAL_COLS)
      .single();
    expect(expired.error, expired.error?.message).toBeNull();
    expect((expired.data as Row).state).toBe("expired");
    expect((expired.data as Row).decided_at).toBeTruthy();

    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev).sort()).toEqual(["approval.expired", "approval.requested"].sort());
    expect(requireEvent(ev, "approval.expired").actor_type).toBe("system");
    expect(requireEvent(ev, "approval.expired").severity).toBe("warn");
  });

  it("tracks an edit even when batched with the approval, chaining causation in the spine", async () => {
    const correlation = newCorrelation();
    const row = await insertPending(correlation, "editapprove");
    const id = String(row.id);

    // One UPDATE that both edits the proposal AND approves it: the emitter must
    // record approval.edited FIRST, then approval.granted CAUSED BY it.
    const res = await db(serviceClient())
      .from("hq_approvals")
      .update({
        edited_payload: { subject: "Quarterly check-in (revised)", body: "Tightened opener." },
        state: "approved",
        reviewer_id: reviewer.id,
        reviewer_email: reviewer.email,
      })
      .eq("id", id)
      .select(APPROVAL_COLS)
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data as Row).state).toBe("approved");

    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev).sort()).toEqual(
      ["approval.edited", "approval.granted", "approval.requested"].sort(),
    );
    expect(requireEvent(ev, "approval.edited").actor_type).toBe("human");
    // The grant is causally chained to the edit (the audit graph is exact).
    expect(Number(requireEvent(ev, "approval.granted").causation_id)).toBe(
      Number(requireEvent(ev, "approval.edited").id),
    );
  });

  it("recovers a rejected item by a NEW pending row that supersedes it — the original stays frozen", async () => {
    const correlation = newCorrelation();
    const original = await insertPending(correlation, "recover");
    const originalId = String(original.id);

    const rejected = await db(serviceClient())
      .from("hq_approvals")
      .update({
        state: "rejected",
        decision_reason: "Not this quarter — try again next cycle.",
        reviewer_id: reviewer.id,
        reviewer_email: reviewer.email,
      })
      .eq("id", originalId)
      .select("state")
      .single();
    expect(rejected.error, rejected.error?.message).toBeNull();
    expect((rejected.data as Row).state).toBe("rejected");

    // Recovery is a fresh request (new trace) that links back via supersedes_id.
    const recoveryCorrelation = newCorrelation();
    const recovered = await db(serviceClient())
      .from("hq_approvals")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("recover"),
        action: "send",
        proposed_payload: { subject: "Quarterly check-in", body: "Second attempt." },
        correlation_id: recoveryCorrelation,
        supersedes_id: originalId,
        state: "pending",
      })
      .select(APPROVAL_COLS)
      .single();
    expect(recovered.error, recovered.error?.message).toBeNull();
    expect((recovered.data as Row).state).toBe("pending");
    expect((recovered.data as Row).supersedes_id).toBe(originalId);

    const ev = await eventsByVerb(recoveryCorrelation);
    expect(String((requireEvent(ev, "approval.requested").payload as Row)?.supersedes)).toBe(
      originalId,
    );

    // The original decision is part of the permanent record — still frozen.
    expect((await readRow(originalId))?.state).toBe("rejected");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS:hq — the engine is HQ infrastructure; tenants never see it.
  // ─────────────────────────────────────────────────────────────────────────
  it("denies every JWT client (anon AND authenticated) read and write access — RLS:hq", async () => {
    const correlation = newCorrelation();
    const seeded = await insertPending(correlation, "rls");
    const id = String(seeded.id);

    // service_role (BYPASSRLS) sees it…
    const asService = await db(serviceClient()).from("hq_approvals").select("id").eq("id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon and an authenticated user do not.
    expectDenied(await db(anonClient()).from("hq_approvals").select("id").eq("id", id));
    expectDenied(await db(userClient(reviewer.token)).from("hq_approvals").select("id").eq("id", id));

    // Writes are denied too — an anon insert is rejected.
    const anonInsert = await db(anonClient())
      .from("hq_approvals")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("rls-anon"),
        action: "send",
        state: "pending",
      })
      .select("id");
    expect(anonInsert.error, "anon must not be able to insert an approval").not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The service wire — the one non-gated entry point, and the live reviewer gate.
  // ─────────────────────────────────────────────────────────────────────────
  it("requestApproval (service) lands a pending row in Postgres, visible in the queue, emitting approval.requested", async () => {
    const correlation = newCorrelation();
    const subjectId = subjectFor("svc");
    const created = await api.requestApproval({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId,
      action: "send",
      proposedPayload: { subject: "Service-wire draft", body: "Reached Postgres." },
      correlationId: correlation,
    });
    expect(created.ok, created.ok ? "" : created.error).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.approval.state).toBe("pending");
    const id = created.approval.id;

    // The read side sees it through the service.
    const fetched = await api.getApproval(id);
    expect(fetched?.id).toBe(id);
    expect((await api.listPendingApprovals(200)).some((a) => a.id === id)).toBe(true);
    expect(
      (await api.listApprovalsForSubject(SUBJECT_TYPE, subjectId)).some((a) => a.id === id),
    ).toBe(true);

    // And the INSERT trigger fired the canonical event in the same transaction.
    const ev = await eventsByVerb(correlation);
    expect(requireEvent(ev, "approval.requested").actor_type).toBe("ai_employee");
  });

  it("the reviewer gate is real — a non-HQ caller cannot drive ANY decision, even live", async () => {
    // Seed a pending row to attack.
    const correlation = newCorrelation();
    const subjectId = subjectFor("gate");
    const created = await api.requestApproval({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId,
      action: "send",
      correlationId: correlation,
    });
    expect(created.ok, created.ok ? "" : created.error).toBe(true);
    if (!created.ok) throw new Error(created.error);
    const id = created.approval.id;

    // reviewer.email is NOT a super-admin, so every gated decision is forbidden —
    // the gate sits BEFORE the database write (architecture, not convention).
    const calls = [
      await api.approveApproval({ id, reviewer }),
      await api.rejectApproval({ id, reviewer, reason: "should never apply" }),
      await api.escalateApproval({ id, reviewer }),
      await api.editApproval({ id, reviewer, editedPayload: { subject: "nope" } }),
      await api.recoverApproval({ id, reviewer }),
    ];
    for (const res of calls) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("forbidden");
    }

    // The row was never touched: still pending, no reviewer recorded.
    const after = await api.getApproval(id);
    expect(after?.state).toBe("pending");
    expect(after?.reviewer_id).toBeNull();
  });
});
