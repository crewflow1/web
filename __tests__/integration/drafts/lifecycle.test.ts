import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import type { DraftContext } from "@/lib/drafts/model";

// The service is loaded LAZILY (in beforeAll, only when the suite runs) — it
// transitively imports @/lib/env, which validates the environment at module-load.
// Deferring the import past the skip decision (and after bridgeServiceEnv satisfies
// lib/env) keeps the clean local skip honest, exactly as the approvals suite does.
type DraftsService = typeof import("@/server/services/hq-drafts");
let api: DraftsService;

/**
 * Draft Generation — real-Postgres proof (CEO Directive 010, Phase 3). Gate 4.
 *
 * The unit tier proves the pure core (deterministic prompt + checksum + fallback) and
 * the security tier pins that the migration, service and model AGREE in source. This
 * tier proves the BEHAVIOUR neither a mock nor a source check can: that against a LIVE
 * database with the real migration applied —
 *
 *   • generateDraft (with NO LLM key, exactly as CI runs) takes the DETERMINISTIC
 *     fallback and persists one immutable hq_drafts row carrying provenance, the
 *     prompt version + checksum, the cost ledger, and the status — every draft
 *     auditable, costs measured, fallback reproducible;
 *   • the AFTER INSERT trigger emits exactly one canonical `ai.run_completed` spine
 *     event IN THE SAME TRANSACTION, honestly attributed, carrying identifiers +
 *     metadata ONLY — the draft prose never leaves the RLS:hq row;
 *   • the artifact is WRITE-ONCE — the service-role client that BYPASSES RLS still
 *     cannot mutate a draft (immutability is architecture, not convention);
 *   • RLS:hq denies every JWT client (anon AND authenticated);
 *   • regenerating supersedes — a NEW row links back via supersedes_id; the original
 *     stays in the permanent record.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_events is append-only, so the spine rows are
 * left behind (harmless in the ephemeral CI database); the hq_drafts rows are deleted
 * on teardown.
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
const TOKEN = `draft${alpha(10)}`;
const SUBJECT_TYPE = "outreach_email";
function subjectFor(tag: string): string {
  return `${TOKEN}-${tag}`;
}

// Track every correlation we mint so teardown deletes exactly this suite's rows.
const CORRELATIONS: string[] = [];
function newCorrelation(): string {
  const id = crypto.randomUUID();
  CORRELATIONS.push(id);
  return id;
}

// A full context (all three sources) — built by hand, so this tier tests the ENGINE
// (persistence, immutability, audit, RLS), not the context adapter (a unit mapping).
function contextFor(tag: string): DraftContext {
  return {
    subject: { name: `Brackenhill ${tag}`, label: SUBJECT_TYPE },
    memory: { text: "They asked about invoicing back in March.", count: 2 },
    research: {
      summary: "A groundworks contractor operating across West Yorkshire.",
      sector: "groundworks",
      painPoints: ["chasing late invoices by phone"],
      buyingSignals: ["advertised three site-manager roles last month"],
      score: 80,
      recommendedModules: ["quoting", "invoicing"],
    },
    qualification: { tier: "hot", score: 88, decision: "qualified", rationale: ["good size fit"] },
  };
}

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

function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

const DRAFT_COLS =
  "id, ai_employee_id, subject_type, subject_id, kind, content, status, provenance, " +
  "model, prompt_version, prompt_checksum, input_tokens, output_tokens, cost_usd, " +
  "latency_ms, fallback_reason, correlation_id, supersedes_id, created_at";

async function readRow(id: string): Promise<Row | null> {
  const res = await db(serviceClient()).from("hq_drafts").select(DRAFT_COLS).eq("id", id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

async function runCompletedEvent(correlationId: string): Promise<Row> {
  const res = await db(serviceClient())
    .from("hq_events")
    .select("id, verb, actor_type, actor_id, object_type, target_type, target_id, severity, payload")
    .eq("correlation_id", correlationId);
  expect(res.error, res.error?.message).toBeNull();
  const rows = (res.data ?? []).filter((r) => r.verb === "ai.run_completed");
  expect(rows.length, "exactly one ai.run_completed per draft").toBe(1);
  const row = rows[0];
  if (!row) throw new Error("missing ai.run_completed event");
  return row;
}

// Seeded in beforeAll: a real generator (ai_employees) and a throwaway auth user.
let EMPLOYEE_ID = "";
let authUser: { id: string; token: string } | null = null;

describeIntegration("Draft Generation · DB-enforced immutable artifact + spine audit (Directive 010 Phase 3)", () => {
  beforeAll(async () => {
    bridgeServiceEnv();
    api = await import("@/server/services/hq-drafts");
    const svc = serviceClient();

    // A generator: any registered AI employee satisfies the write-once FK.
    const employee = await db(svc).from("ai_employees").select("id").limit(1).single();
    expect(employee.error, employee.error?.message).toBeNull();
    EMPLOYEE_ID = String((employee.data as { id?: string })?.id ?? "");
    if (!EMPLOYEE_ID) throw new Error("no ai_employees row to act as the generator — is the roster migration applied?");

    // A throwaway authenticated user, purely to prove RLS denies an authenticated JWT
    // (drafts has no users FK, so no public.users mirror is needed).
    const email = `it-drafts-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id;
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token;
    if (id && token) authUser = { id, token };
  });

  afterAll(async () => {
    const svc = serviceClient();
    if (CORRELATIONS.length) {
      await db(svc).from("hq_drafts").delete().in("correlation_id", CORRELATIONS);
    }
    if (authUser?.id) await svc.auth.admin.deleteUser(authUser.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The deterministic path — exactly what CI (no LLM key) exercises end-to-end.
  // ─────────────────────────────────────────────────────────────────────────
  it("generateDraft (no provider) persists an immutable, audited deterministic draft", async () => {
    const correlation = newCorrelation();
    const subjectId = subjectFor("gen");
    const res = await api.generateDraft({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId,
      kind: "cold_email",
      context: contextFor("gen"),
      correlationId: correlation,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const draft = res.draft;

    // Deterministic fallback provenance + a fully-recorded, traceable, costed run.
    expect(draft.status).toBe("fallback");
    expect(draft.provenance).toBe("deterministic");
    expect(draft.model).toBeNull();
    expect(draft.prompt_version).toBe("cold_email:v1");
    expect(draft.prompt_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.input_tokens).toBe(0);
    expect(draft.output_tokens).toBe(0);
    expect(draft.cost_usd).toBeNull();
    expect(draft.fallback_reason).toBe("no_provider");

    // A real, honest draft built from the context (the sector flowed through).
    expect(draft.content.channel).toBe("email");
    expect(draft.content.subject.length).toBeGreaterThan(0);
    expect(draft.content.body).toContain("groundworks");

    // The INSERT trigger fired exactly one ai.run_completed, honestly attributed…
    const ev = await runCompletedEvent(correlation);
    expect(ev.actor_type).toBe("ai_employee");
    expect(ev.severity).toBe("info"); // fallback is info; a generated draft would be success
    expect(ev.object_type).toBe("draft");
    expect(ev.target_type).toBe(SUBJECT_TYPE);
    expect(ev.target_id).toBe(subjectId);

    // …carrying identifiers + metadata, and NOT the prose (it stays in the RLS:hq row).
    const payload = (ev.payload ?? {}) as Row;
    expect(payload.prompt_version).toBe("cold_email:v1");
    expect(payload.provenance).toBe("deterministic");
    expect(payload.status).toBe("fallback");
    expect(payload.subject).toBeUndefined();
    expect(payload.body).toBeUndefined();
    expect(payload.content).toBeUndefined();
    // The body's distinctive prose ("groundworks") never appears in the spine payload.
    expect(JSON.stringify(payload)).not.toContain("groundworks");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Write-once — even the service-role client (which BYPASSES RLS) cannot mutate.
  // ─────────────────────────────────────────────────────────────────────────
  it("a draft is immutable — ANY update is rejected by the database trigger", async () => {
    const correlation = newCorrelation();
    const res = await api.generateDraft({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId: subjectFor("immut"),
      kind: "cold_email",
      context: contextFor("immut"),
      correlationId: correlation,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const id = res.draft.id;

    const tamper = await db(serviceClient())
      .from("hq_drafts")
      .update({ model: "tampered", content: { subject: "X", body: "Y", channel: "email" } })
      .eq("id", id);
    expect(tamper.error, "a draft row must be immutable").not.toBeNull();

    const after = await readRow(id);
    expect(after?.model).toBeNull();
    expect((after?.content as Row)?.subject).toBe(res.draft.content.subject);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS:hq — the engine is HQ infrastructure; tenants never see it.
  // ─────────────────────────────────────────────────────────────────────────
  it("denies every JWT client (anon AND authenticated) — RLS:hq, prose sealed", async () => {
    const correlation = newCorrelation();
    const res = await api.generateDraft({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId: subjectFor("rls"),
      kind: "cold_email",
      context: contextFor("rls"),
      correlationId: correlation,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const id = res.draft.id;

    // service_role (BYPASSRLS) sees it…
    const asService = await db(serviceClient()).from("hq_drafts").select("id").eq("id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not, and an authenticated user does not either.
    expectDenied(await db(anonClient()).from("hq_drafts").select("id").eq("id", id));
    if (authUser) {
      expectDenied(await db(userClient(authUser.token)).from("hq_drafts").select("id").eq("id", id));
    }

    // A JWT write is denied too.
    const anonInsert = await db(anonClient())
      .from("hq_drafts")
      .insert({
        ai_employee_id: EMPLOYEE_ID,
        subject_type: SUBJECT_TYPE,
        subject_id: subjectFor("rls-anon"),
        kind: "cold_email",
        content: { subject: "x", body: "y", channel: "email" },
        status: "fallback",
        provenance: "deterministic",
        prompt_version: "cold_email:v1",
        prompt_checksum: "0".repeat(64),
      })
      .select("id");
    expect(anonInsert.error, "anon must not be able to insert a draft").not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regeneration supersedes — never mutates. The original stays in the record.
  // ─────────────────────────────────────────────────────────────────────────
  it("regenerating produces a NEW row that supersedes the prior — the original is untouched", async () => {
    const firstCorrelation = newCorrelation();
    const subjectId = subjectFor("regen");
    const first = await api.generateDraft({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId,
      kind: "cold_email",
      context: contextFor("regen"),
      correlationId: firstCorrelation,
    });
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const originalId = first.draft.id;

    const secondCorrelation = newCorrelation();
    const second = await api.generateDraft({
      aiEmployeeId: EMPLOYEE_ID,
      subjectType: SUBJECT_TYPE,
      subjectId,
      kind: "cold_email",
      context: contextFor("regen"),
      correlationId: secondCorrelation,
      supersedesId: originalId,
    });
    expect(second.ok, second.ok ? "" : second.error).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.draft.id).not.toBe(originalId);
    expect(second.draft.supersedes_id).toBe(originalId);

    // The original is part of the permanent record — still present, unchanged.
    const original = await readRow(originalId);
    expect(original?.id).toBe(originalId);
    expect(original?.supersedes_id).toBeNull();

    // The regeneration's spine event records the supersession.
    const ev = await runCompletedEvent(secondCorrelation);
    expect(String((ev.payload as Row)?.supersedes)).toBe(originalId);
  });
});
