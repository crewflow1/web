import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

// The service is loaded LAZILY (in beforeAll, only when the suite runs) — it
// transitively imports @/lib/env, which validates the environment at module-load.
// Deferring the import past the skip decision (and after bridgeServiceEnv satisfies
// lib/env) keeps the clean local skip honest, exactly as the drafts/approvals suites do.
type CommsService = typeof import("@/server/services/hq-comms");
let api: CommsService;

/**
 * The Communication Layer — real-Postgres proof (CEO Directive 010, Phase 4). Gate 4.
 *
 * The unit tier proves the pure core (state machine + policy + cost) and the security
 * tier pins that the migration, service and state map AGREE in source. This tier proves
 * the BEHAVIOUR neither a mock nor a source check can: that against a LIVE database with
 * the real migration applied —
 *
 *   • THE approval gate is unbypassable. Even the service-role client (which BYPASSES
 *     RLS) cannot insert a delivery row for an approval that is not 'approved' — "every
 *     outbound communication still requires the Approval Engine," in the database.
 *   • deliverDraft with NO provider (exactly as CI runs) records a terminal
 *     `failed`/no_provider attempt and SENDS NOTHING — the reproducible no-send path —
 *     emitting one honest comm.failed spine event whose payload carries identifiers +
 *     metadata ONLY: the recipient address and the draft prose never leave the RLS:hq row.
 *   • a suppressed address is never contacted — deliverDraft records a `suppressed`
 *     attempt and sends nothing.
 *   • a provider outcome settles a live `sent` row, and a bounce/complaint adds the
 *     recipient to the do-not-contact list; the settled row then FREEZES (terminal,
 *     immutable — even to service_role).
 *   • retry SUPERSEDES — a new attempt links back; the prior attempt stays in the record.
 *   • RLS:hq denies every JWT client (anon AND authenticated).
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_events is append-only, so the spine rows are
 * left behind (harmless in the ephemeral CI database); the hq_communications / hq_drafts
 * / hq_approvals rows and the minted reviewer + suppressions are deleted on teardown.
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

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `comm${alpha(10)}`;
const SUBJECT_TYPE = "outreach_email";
function subjectFor(tag: string): string {
  return `${TOKEN}-${tag}`;
}
function recipientFor(tag: string): string {
  return `${TOKEN}-${tag}@probe.crewflow.test`;
}

const COMM_COLS =
  "id, ai_employee_id, draft_id, approval_id, subject_type, subject_id, channel, provider, " +
  "to_address, provider_message_id, status, failure_reason, attempt, cost_usd, latency_ms, " +
  "correlation_id, supersedes_id, sent_at, settled_at, created_at, updated_at";

// Every correlation we mint is tracked so teardown deletes exactly this suite's rows
// (comms → drafts → approvals; the spine rows are append-only and stay behind).
const CORRELATIONS: string[] = [];
function newCorrelation(): string {
  const id = crypto.randomUUID();
  CORRELATIONS.push(id);
  return id;
}
// Addresses suppressed during the run, deleted from the shared do-not-contact list on teardown.
const SUPPRESSED: string[] = [];

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

/** Insert a deterministic draft directly via service_role (the artifact to deliver). */
async function seedDraft(correlationId: string, tag: string): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_drafts")
    .insert({
      ai_employee_id: EMPLOYEE_ID,
      subject_type: SUBJECT_TYPE,
      subject_id: subjectFor(tag),
      kind: "cold_email",
      content: {
        subject: "Quarterly check-in",
        body: "Hi there,\n\nA quick note about your account.\n\nRegards",
        channel: "email",
      },
      status: "fallback",
      provenance: "deterministic",
      prompt_version: "cold_email:v1",
      prompt_checksum: "0".repeat(64),
      correlation_id: correlationId,
    })
    .select("id, ai_employee_id, subject_type, subject_id, correlation_id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

/** Insert a pending approval and move it to 'approved' with the reviewer (the gate, satisfied). */
async function seedApprovedApproval(correlationId: string, tag: string): Promise<string> {
  const svc = serviceClient();
  const pending = await db(svc)
    .from("hq_approvals")
    .insert({
      ai_employee_id: EMPLOYEE_ID,
      subject_type: SUBJECT_TYPE,
      subject_id: subjectFor(tag),
      action: "send",
      proposed_payload: { subject: "Quarterly check-in", body: "Hi there — proposed draft." },
      correlation_id: correlationId,
      state: "pending",
    })
    .select("id")
    .single();
  expect(pending.error, pending.error?.message).toBeNull();
  const id = String((pending.data as Row).id);

  const approved = await db(svc)
    .from("hq_approvals")
    .update({ state: "approved", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
    .eq("id", id)
    .select("id, state")
    .single();
  expect(approved.error, approved.error?.message).toBeNull();
  expect((approved.data as Row).state).toBe("approved");
  return id;
}

/** A scenario: one correlation, with a draft + an approved approval ready to deliver. */
async function scenario(tag: string): Promise<{ correlation: string; draftId: string; approvalId: string }> {
  const correlation = newCorrelation();
  const draft = await seedDraft(correlation, tag);
  const approvalId = await seedApprovedApproval(correlation, tag);
  return { correlation, draftId: String(draft.id), approvalId };
}

async function readComm(id: string): Promise<Row | null> {
  const res = await db(serviceClient()).from("hq_communications").select(COMM_COLS).eq("id", id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

/** All spine events for a correlation, keyed by verb (one per verb in these traces). */
async function eventsByVerb(correlationId: string): Promise<Record<string, Row>> {
  const res = await db(serviceClient())
    .from("hq_events")
    .select("id, verb, actor_type, actor_id, object_type, target_type, target_id, severity, payload")
    .eq("correlation_id", correlationId);
  expect(res.error, res.error?.message).toBeNull();
  const out: Record<string, Row> = {};
  for (const row of res.data ?? []) out[String(row.verb)] = row;
  return out;
}
function requireEvent(ev: Record<string, Row>, verb: string): Row {
  const row = ev[verb];
  expect(row, `missing spine event ${verb}`).toBeTruthy();
  if (!row) throw new Error(`missing spine event ${verb}`);
  return row;
}

// Seeded in beforeAll: a real deliverer (ai_employees) and a real reviewer (auth.users
// + the mirrored public.users row the approval reviewer_id FK requires).
let EMPLOYEE_ID = "";
let reviewer: { id: string; email: string; token: string };

describeIntegration("The Communication Layer · DB-enforced approval gate + delivery audit (Directive 010 Phase 4)", () => {
  beforeAll(async () => {
    bridgeServiceEnv();
    api = await import("@/server/services/hq-comms");
    const svc = serviceClient();

    const employee = await db(svc).from("ai_employees").select("id").limit(1).single();
    expect(employee.error, employee.error?.message).toBeNull();
    EMPLOYEE_ID = String((employee.data as { id?: string })?.id ?? "");
    if (!EMPLOYEE_ID) throw new Error("no ai_employees row to act as the deliverer — is the roster migration applied?");

    // A reviewer: mint an auth user, mirror into public.users (no handle_new_user
    // trigger exists) so the approval's reviewer_id FK is satisfiable.
    const email = `it-comms-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
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
    // Order matters: communications RESTRICT-reference drafts + approvals, so they go first.
    if (CORRELATIONS.length) {
      await db(svc).from("hq_communications").delete().in("correlation_id", CORRELATIONS);
      await db(svc).from("hq_drafts").delete().in("correlation_id", CORRELATIONS);
      await db(svc).from("hq_approvals").delete().in("correlation_id", CORRELATIONS);
    }
    if (SUPPRESSED.length) {
      await db(svc).from("hq_comms_suppressions").delete().in("address", SUPPRESSED);
    }
    if (reviewer?.id) await svc.auth.admin.deleteUser(reviewer.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE approval gate — the load-bearing boundary, proven at the database.
  // ─────────────────────────────────────────────────────────────────────────
  it("REFUSES an ungated delivery — even service_role cannot insert a row for a non-approved approval", async () => {
    // A pending (NOT approved) approval, under its own correlation so teardown reaps it.
    const correlation = newCorrelation();
    const draft = await seedDraft(correlation, "gate");
    const pending = await db(serviceClient())
      .from("hq_approvals")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("gate"),
        action: "send",
        correlation_id: correlation,
        state: "pending",
      })
      .select("id")
      .single();
    expect(pending.error, pending.error?.message).toBeNull();
    const pendingApprovalId = String((pending.data as Row).id);

    // The gate rejects a delivery row for the un-approved action — the CEO's absolute rule.
    const ungated = await db(serviceClient())
      .from("hq_communications")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        draft_id: String(draft.id),
        approval_id: pendingApprovalId,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("gate"),
        channel: "email",
        provider: "none",
        to_address: recipientFor("gate"),
        status: "failed",
        failure_reason: "should-never-persist",
        correlation_id: correlation,
      })
      .select("id");
    expect(ungated.error, "a delivery for a non-approved approval MUST be rejected by the DB").not.toBeNull();

    // And no row was written.
    const after = await db(serviceClient())
      .from("hq_communications")
      .select("id")
      .eq("correlation_id", correlation);
    expect(after.data ?? []).toHaveLength(0);
  });

  it("the gate guards the BORN state too — an approved approval cannot birth a delivered/bounced row", async () => {
    const { correlation, draftId, approvalId } = await scenario("born");
    const illegal = await db(serviceClient())
      .from("hq_communications")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        draft_id: draftId,
        approval_id: approvalId,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("born"),
        channel: "email",
        provider: "resend",
        to_address: recipientFor("born"),
        provider_message_id: `pm-born-${alpha(8)}`,
        status: "delivered", // only a live `sent` row ever reaches a provider outcome
        correlation_id: correlation,
      })
      .select("id");
    expect(illegal.error, "a row cannot be born `delivered`").not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // deliverDraft with NO provider — the reproducible no-send path (exactly CI).
  // ─────────────────────────────────────────────────────────────────────────
  it("deliverDraft (no provider) records a terminal failed/no_provider attempt and SENDS NOTHING, audited PII-free", async () => {
    const { correlation, draftId, approvalId } = await scenario("nosend");
    const to = recipientFor("nosend");
    const res = await api.deliverDraft({ draftId, approvalId, to, correlationId: correlation });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const comm = res.communication;

    // A terminal failed attempt that reached no provider — nothing was sent.
    expect(comm.status).toBe("failed");
    expect(comm.provider).toBe("none");
    expect(comm.failure_reason).toBe("no_provider");
    expect(comm.provider_message_id).toBeNull();
    expect(comm.attempt).toBe(1);
    expect(comm.to_address).toBe(to);
    expect(comm.settled_at).toBeTruthy(); // born terminal → settled
    expect(comm.cost_usd).toBeNull();

    // Exactly one comm.failed spine event, honestly attributed to the system…
    const ev = await eventsByVerb(correlation);
    const failed = requireEvent(ev, "comm.failed");
    expect(failed.actor_type).toBe("system");
    expect(failed.severity).toBe("warn");
    expect(failed.object_type).toBe("communication");
    expect(failed.target_type).toBe(SUBJECT_TYPE);
    expect(failed.target_id).toBe(subjectFor("nosend"));

    // …carrying identifiers + metadata, and NEVER the recipient address or the prose.
    const payload = (failed.payload ?? {}) as Row;
    expect(payload.status).toBe("failed");
    expect(payload.provider).toBe("none");
    expect(payload.failure_reason).toBe("no_provider");
    expect(payload.to_address).toBeUndefined();
    expect(payload.subject).toBeUndefined();
    expect(payload.body).toBeUndefined();
    // The recipient address never appears anywhere in the spine payload.
    expect(JSON.stringify(payload)).not.toContain(to);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Suppression — a do-not-contact address is never contacted.
  // ─────────────────────────────────────────────────────────────────────────
  it("never contacts a suppressed address — deliverDraft records a `suppressed` attempt and sends nothing", async () => {
    const { correlation, draftId, approvalId } = await scenario("suppress");
    const to = recipientFor("suppress");

    const added = await api.addSuppression({ address: to, reason: "manual", note: "test do-not-contact" });
    expect(added.ok).toBe(true);
    SUPPRESSED.push(to);
    expect(await api.isSuppressed(to)).toBe(true);

    const res = await api.deliverDraft({ draftId, approvalId, to, correlationId: correlation });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.communication.status).toBe("suppressed");
    expect(res.communication.provider_message_id).toBeNull();
    expect(res.communication.failure_reason).toBe("suppressed");

    const ev = await eventsByVerb(correlation);
    const suppressed = requireEvent(ev, "comm.suppressed");
    expect(suppressed.actor_type).toBe("system");
    expect(suppressed.severity).toBe("info");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A provider outcome settles a live `sent` row; a bounce suppresses; then it FREEZES.
  // ─────────────────────────────────────────────────────────────────────────
  it("recordDeliveryEvent settles a sent row to bounced, suppresses the address, is idempotent, then freezes", async () => {
    const { correlation, draftId, approvalId } = await scenario("bounce");
    const to = recipientFor("bounce");
    const pmid = `pm-bounce-${alpha(10)}`;

    // A live `sent` row (no provider in CI, so we seed the accepted state directly).
    const sent = await db(serviceClient())
      .from("hq_communications")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        draft_id: draftId,
        approval_id: approvalId,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("bounce"),
        channel: "email",
        provider: "resend",
        to_address: to,
        provider_message_id: pmid,
        status: "sent",
        correlation_id: correlation,
      })
      .select(COMM_COLS)
      .single();
    expect(sent.error, sent.error?.message).toBeNull();
    expect((sent.data as Row).status).toBe("sent");
    expect((sent.data as Row).sent_at).toBeTruthy();
    const sentId = String((sent.data as Row).id);

    // The provider reports a bounce → the row settles, and the address is suppressed.
    const bounced = await api.recordDeliveryEvent(pmid, "bounced");
    expect(bounced.ok, bounced.ok ? "" : bounced.error).toBe(true);
    if (!bounced.ok) throw new Error(bounced.error);
    expect(bounced.communication.status).toBe("bounced");
    SUPPRESSED.push(to);
    expect(await api.isSuppressed(to)).toBe(true);

    // The bounce landed in the spine, attributed to the system.
    const ev = await eventsByVerb(correlation);
    const bounceEv = requireEvent(ev, "comm.bounced");
    expect(bounceEv.actor_type).toBe("system");
    expect(bounceEv.severity).toBe("warn");

    // Idempotent: a repeated bounce webhook is a no-op success; a CONFLICTING outcome is refused.
    const again = await api.recordDeliveryEvent(pmid, "bounced");
    expect(again.ok).toBe(true);
    const conflict = await api.recordDeliveryEvent(pmid, "delivered");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe("not_active");

    // The settled row is terminal — frozen even to service_role.
    const tamper = await db(serviceClient())
      .from("hq_communications")
      .update({ failure_reason: "tampered" })
      .eq("id", sentId);
    expect(tamper.error, "a bounced row must be immutable").not.toBeNull();
    expect((await readComm(sentId))?.status).toBe("bounced");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Retry SUPERSEDES — a new attempt links back; the prior attempt stays in the record.
  // ─────────────────────────────────────────────────────────────────────────
  it("retryDelivery mints a NEW attempt that supersedes the prior failed one (never mutates it)", async () => {
    const { correlation, draftId, approvalId } = await scenario("retry");
    const to = recipientFor("retry");

    const first = await api.deliverDraft({ draftId, approvalId, to, correlationId: correlation });
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.communication.status).toBe("failed");
    const priorId = first.communication.id;

    const retried = await api.retryDelivery(priorId);
    expect(retried.ok, retried.ok ? "" : retried.error).toBe(true);
    if (!retried.ok) throw new Error(retried.error);
    expect(retried.communication.id).not.toBe(priorId);
    expect(retried.communication.attempt).toBe(2);
    expect(retried.communication.supersedes_id).toBe(priorId);

    // The prior attempt is part of the permanent record — still present, unchanged.
    const prior = await readComm(priorId);
    expect(prior?.id).toBe(priorId);
    expect(prior?.attempt).toBe(1);
    expect(prior?.supersedes_id).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS:hq — the layer is HQ infrastructure; tenants never see it.
  // ─────────────────────────────────────────────────────────────────────────
  it("denies every JWT client (anon AND authenticated) — RLS:hq, recipient + prose sealed", async () => {
    const { correlation, draftId, approvalId } = await scenario("rls");
    const res = await api.deliverDraft({
      draftId,
      approvalId,
      to: recipientFor("rls"),
      correlationId: correlation,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const id = res.communication.id;

    // service_role (BYPASSRLS) sees it…
    const asService = await db(serviceClient()).from("hq_communications").select("id").eq("id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not, and an authenticated user does not either.
    expectDenied(await db(anonClient()).from("hq_communications").select("id").eq("id", id));
    expectDenied(await db(userClient(reviewer.token)).from("hq_communications").select("id").eq("id", id));

    // A JWT write is denied too.
    const anonInsert = await db(anonClient())
      .from("hq_communications")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        draft_id: draftId,
        approval_id: approvalId,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("rls-anon"),
        channel: "email",
        provider: "none",
        to_address: recipientFor("rls-anon"),
        status: "failed",
        correlation_id: correlation,
      })
      .select("id");
    expect(anonInsert.error, "anon must not be able to insert a communication").not.toBeNull();
  });
});
