import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  getOutreachMetrics,
  getOutreachRunState,
  latestOutreachTaskId,
  runOutreachTask,
  startOutreach,
  type RunOutcome,
} from "@/server/services/hq-outreach";

/**
 * Outreach AI runner — real-Postgres proof of the migration onto the Generic Task
 * Engine (CEO Directive 010, Phase 4; Directive #012 / D-02). Gate 4.
 *
 * The runner (server/services/hq-outreach.ts) owns NO tables of its own: it drains
 * a `generate_email` task off the generic Task Engine (hq_ai_tasks) through the
 * canonical runner SDK — which claims the task, holds the lease, and decides the
 * terminal transition off the handler's return/throw — drives the lifecycle (Queued
 * → Running → Drafting → Completed), and persists ONE immutable draft through the
 * Draft Engine (hq_drafts). The unit tier proves the handler's control flow through
 * the real runner with a mocked queue; this tier proves the BEHAVIOUR a mock cannot:
 * that against a LIVE database with the real migrations applied, a full run actually
 * writes the rows it claims to, in the shapes it claims — and does so DARK.
 *
 * We force the DETERMINISTIC (dark) path — the "unbound tier" production posture —
 * by mocking the text provider to null. So the run touches NO network and makes NO
 * paid model call, yet still has to:
 *
 *   1. complete end-to-end (a deterministic draft is a COMPLETION, never a failure);
 *   2. write exactly ONE immutable draft, attributed to the Outreach AI employee,
 *      provenance='deterministic' / status='fallback' (the dark path, proven durable);
 *   3. record the draft on the company timeline as an approval-pending artifact
 *      (outcome='draft') — EXECUTION STAYS LOCKED: nothing is sent;
 *   4. mirror the lifecycle to the permanent company timeline;
 *   5. reconstruct the terminal run from the persisted jsonb (the read side);
 *   6. aggregate into live metrics;
 *   7. stay idempotent — re-running a finished task is a no-op skip.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. Teardown deletes the probe company (whose FKs
 * cascade to its timeline), then the draft row and the generic-engine task row (both
 * linked by free-form ids — no FK, no cascade — so removed explicitly).
 */

// Force the dark deterministic leg regardless of CI env: with no text provider the
// Draft Engine's buildDraft returns fallbackBuilt("no_provider") — zero network, no
// paid call — exactly what an unbound cost tier yields in production.
vi.mock("@/lib/ai/text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/text")>();
  return { ...actual, getTextProvider: () => null };
});

// Keep the draft context assembly hermetic: no research/qualification task ids are
// passed, so the memory recall is the only external reach. Stub the embedding
// provider so the module graph never touches a network dep during recall.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

// loose-cast client shim — the generated Database type does not model the hq_* HQ
// family (service-role-only, RLS:hq). Ground-truth reads/teardown only.
type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
}
interface Table {
  select(columns?: string): Sel;
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
const TOKEN = `outreach${alpha(10)}`;
const ACTOR = { id: null, email: `it-outreach-${alpha(6)}@probe.crewflow.test` };

// The runner's DB handle (createAdminClient) reads NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY. The integration CI job exports the live stack's URL
// under the bare SUPABASE_URL, which the harness also accepts — bridge the one name
// the runner needs onto the same stack.
function bridgeRunnerEnv(): void {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

// A minimal probe company inserted directly (Outreach AI never creates a company —
// its input must already exist), so the run has a subject to draft for.
async function seedCompany(): Promise<string> {
  const ins = (
    serviceClient() as unknown as {
      from: (t: string) => {
        insert: (r: Row) => {
          select: (c: string) => { maybeSingle: () => Promise<{ data: Row | null; error: { message: string } | null }> };
        };
      };
    }
  )
    .from("hq_sales_companies")
    .insert({
      name: `Probe ${TOKEN} Construction Ltd`,
      country: "United Kingdom",
      status: "outreach_ready",
      source: "manual",
    })
    .select("id");
  const { data, error } = await ins.maybeSingle();
  if (error || !data) throw new Error(`seedCompany failed: ${error?.message ?? "no row"}`);
  return String(data.id);
}

describeIntegration("HQ Outreach AI · runner against a real Postgres (Directive 010, Phase 4)", () => {
  let companyId = "";
  let taskId = "";
  let outcome: RunOutcome | null = null;

  beforeAll(async () => {
    bridgeRunnerEnv();

    companyId = await seedCompany();

    // The real UI/cron entry points: enqueue a generate_email task for the existing
    // company, then run it to completion against Postgres.
    const started = await startOutreach({ companyId }, ACTOR);
    expect(started.ok, started.ok ? "" : started.error).toBe(true);
    if (!started.ok) throw new Error(started.error);
    taskId = started.taskId;

    outcome = await runOutreachTask(taskId);
  });

  afterAll(async () => {
    if (companyId) {
      // Remove the drafts first (no cascade from the company — the draft's subject is
      // a free-form id), then the company (cascades to its timeline), then the task.
      await db(serviceClient()).from("hq_drafts").delete().eq("subject_id", companyId);
      await db(serviceClient()).from("hq_sales_companies").delete().eq("id", companyId);
    }
    if (taskId) {
      await db(serviceClient()).from("hq_ai_tasks").delete().eq("id", taskId);
    }
  });

  it("completes the run DARK (no provider) — a deterministic draft is a completion", () => {
    const o = outcome;
    expect(o).not.toBeNull();
    if (!o || o.status !== "completed") {
      throw new Error(`expected a completed run, got ${o ? JSON.stringify(o) : "null"}`);
    }
    expect(o.draftId).toBeTruthy();
  });

  it("writes exactly one immutable draft, attributed to Outreach AI, provenance='deterministic'", async () => {
    const res = await db(serviceClient())
      .from("hq_drafts")
      .select("id, subject_type, subject_id, kind, provenance, status")
      .eq("subject_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const rows = res.data ?? [];
    expect(rows.length).toBe(1); // one draft per run; no duplicate
    const draft = rows[0];
    if (!draft) throw new Error("expected exactly one draft row");
    expect(draft.subject_type).toBe("outreach_email");
    expect(draft.kind).toBe("cold_email");
    expect(draft.provenance).toBe("deterministic");
    expect(draft.status).toBe("fallback");
  });

  it("EXECUTION STAYS LOCKED — the draft is logged as approval-pending, never sent", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_timeline_events")
      .select("event_type, outcome, source")
      .eq("company_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const events = res.data ?? [];
    const generated = events.find((e) => e.event_type === "email_generated");
    expect(generated, "expected an email_generated timeline event").toBeTruthy();
    expect(generated?.outcome).toBe("draft"); // a draft, never a send
    expect(generated?.source).toBe("ai_outreach"); // honest provenance, not research/qualification
  });

  it("mirrors the lifecycle to the permanent company timeline (scheduled → started → generated → completed)", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_timeline_events")
      .select("event_type")
      .eq("company_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const types = new Set((res.data ?? []).map((r) => r.event_type));
    for (const t of ["task_scheduled", "task_started", "email_generated", "task_completed"]) {
      expect(types.has(t), `missing timeline event ${t}`).toBe(true);
    }
  });

  it("the read side reconstructs the terminal run from the persisted jsonb", async () => {
    const state = await getOutreachRunState(taskId);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("completed");
    expect(state?.phase).toBe("completed");
    expect(state?.summary?.draftId).toBe(outcome?.status === "completed" ? outcome.draftId : null);
    expect(state?.summary?.provenance).toBe("deterministic");
    expect(state?.error ?? null).toBeNull();
  });

  it("live metrics aggregate the completed deterministic run", async () => {
    const metrics = await getOutreachMetrics();
    expect(metrics.total).toBeGreaterThanOrEqual(1);
    expect(metrics.completed).toBeGreaterThanOrEqual(1);
    expect(metrics.drafted).toBeGreaterThanOrEqual(1);
    expect(metrics.provenance.deterministic).toBeGreaterThanOrEqual(1);
    expect(metrics.recent.some((r) => r.taskId === taskId)).toBe(true);

    expect(await latestOutreachTaskId(companyId)).toBe(taskId);
  });

  it("re-running a finished task is an idempotent skip (the type-oriented claim finds the queue drained)", async () => {
    const again = await runOutreachTask(taskId);
    expect(again.ok).toBe(true);
    expect(again.status).toBe("skipped");
  });
});
