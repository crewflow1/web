import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  getResearchMetrics,
  getResearchReport,
  getResearchRunState,
  latestResearchTaskId,
  runResearchTask,
  startResearch,
  type RunOutcome,
} from "@/server/services/hq-research";

/**
 * Company Research AI runner — real-Postgres proof of the execution engine
 * (Module 2, CEO Directive 005; hardened under Directive 003 to the six-gate
 * bar). Gate 4.
 *
 * The runner (server/services/hq-research.ts) owns NO tables of its own: it
 * claims a `research_company` task off hq_sales_ai_tasks, drives the lifecycle
 * (Queued → Researching → Analysing → Scoring → Reasoning → Completed), and
 * persists every artifact through the existing Sales-AI writers. The unit tier
 * proves the pure scoring/parsing in isolation; this tier proves the BEHAVIOUR
 * a mock cannot: that against a LIVE database with the real migrations applied,
 * a full run actually writes the rows it claims to, in the shapes it claims.
 *
 * We force the DETERMINISTIC path — the directive's "unknown is acceptable"
 * applied to the model itself — by mocking the model layer to the no-key
 * outcome and seeding a website-less company. So the run touches NO network and
 * makes NO paid model call, yet still has to:
 *
 *   1. complete end-to-end and return a real, transparent score (the three
 *      always-known factors — buying intent, technology, decision-maker access
 *      — guarantee a non-null composite even on an empty profile);
 *   2. write exactly ONE durable research report, attributed generated_by='ai'
 *      / model='deterministic' (AI traceability survives a real round-trip);
 *   3. enrich the company row (last_researched_at + ai_qualification_score) so
 *      the CEO dashboard's "researched" count is truthful;
 *   4. mirror the lifecycle to the permanent company timeline;
 *   5. write NOTHING it cannot stand behind — no fabricated sales brief, no
 *      invented contacts (the honesty contract, proven against ground truth);
 *   6. reconstruct the terminal run from the persisted jsonb (the read side);
 *   7. aggregate into live metrics;
 *   8. stay idempotent — re-running a finished task is a no-op skip.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB,
 * fails loudly in CI if the DB is missing. The integration config runs files
 * serially, so this is the only suite touching the research queue; teardown
 * deletes the probe company, whose FKs cascade to its task, report, contacts,
 * timeline and recommendations.
 */

// Force the deterministic path regardless of CI env: researchAiEnabled() →
// false makes analyse() skip the LLM and reasonSalesPrep early-return (so NO
// recommendation is drafted). The two run* stubs guarantee zero network / paid
// model calls even if a provider key happens to be present in the environment.
vi.mock("@/server/services/research-llm", () => ({
  researchAiEnabled: () => false,
  runResearchAnalysis: async () => null,
  runResearchSalesPrep: async () => null,
}));

// Keep the run hermetic and teardown trivial: the final pipeline step promotes
// the report into Shared Memory. The memory↔company link is polymorphic (not a
// FK), so a memory row would survive a company delete. We stub createMemory to
// the "engine unavailable" outcome — which exercises the runner's graceful-skip
// branch and leaves no hq_memories row to clean up. listMemoryTypes / sources
// stay real, so promoteResearchToMemory still runs its real selection logic.
vi.mock("@/server/services/hq-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/hq-memory")>();
  return {
    ...actual,
    createMemory: async () => ({ ok: false as const, error: "memory disabled in integration test" }),
  };
});

// loose-cast client shim — the generated Database type does not model the
// hq_sales_* family (HQ is service-role-only, RLS:hq), mirroring the shim in
// hq-sales-rls.test.ts. Ground-truth reads/teardown only.
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

// An all-letters token, unique per run, so the probe company can't collide with
// any other row and teardown is unambiguous.
function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `research${alpha(10)}`;
const ACTOR = { id: null, email: `it-research-${alpha(6)}@probe.crewflow.test` };

// The runner's DB handle (createAdminClient) reads NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY. The integration CI job exports the live stack's
// URL under the bare SUPABASE_URL (see .github/workflows/ci.yml), which the
// harness also accepts — so bridge the one name the runner needs onto the same
// stack, ensuring the runner writes to the very DB these assertions read.
function bridgeRunnerEnv(): void {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

describeIntegration("HQ Company Research AI · runner against a real Postgres (Module 2)", () => {
  let companyId = "";
  let taskId = "";
  let outcome: RunOutcome | null = null;

  beforeAll(async () => {
    bridgeRunnerEnv();

    // The real UI/cron entry points: resolve+create the target company, enqueue
    // a research_company task, then run it to completion against Postgres.
    const started = await startResearch({ name: `Probe ${TOKEN} Construction Ltd` }, ACTOR);
    expect(started.ok, started.ok ? "" : started.error).toBe(true);
    if (!started.ok) throw new Error(started.error);
    companyId = started.companyId;
    taskId = started.taskId;

    outcome = await runResearchTask(taskId);
  });

  afterAll(async () => {
    // Deleting the company cascades to its task, report, contacts, timeline and
    // recommendations (every hq_sales_* child is on delete cascade).
    if (companyId) {
      await db(serviceClient()).from("hq_sales_companies").delete().eq("id", companyId);
    }
  });

  it("completes the run deterministically (no provider key) with a real, transparent score", () => {
    const o = outcome;
    expect(o).not.toBeNull();
    if (!o || o.status !== "completed") {
      throw new Error(`expected a completed run, got ${o ? JSON.stringify(o) : "null"}`);
    }
    // Three factors are always known even on an empty profile, so the composite
    // is a real number — never a fabricated default and never null here.
    expect(typeof o.score).toBe("number");
    expect(o.score ?? -1).toBeGreaterThanOrEqual(0);
    expect(o.score ?? 101).toBeLessThanOrEqual(100);
  });

  it("writes exactly one durable research report, attributed generated_by='ai' / model='deterministic'", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_research_reports")
      .select("id, company_id, generated_by, model, likelihood_score")
      .eq("company_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const reports = res.data ?? [];
    expect(reports.length).toBe(1); // one report per run; no duplicate
    const report = reports[0];
    if (!report) throw new Error("expected exactly one research report row");
    expect(report.generated_by).toBe("ai");
    expect(report.model).toBe("deterministic");
    expect(typeof report.likelihood_score).toBe("number");
  });

  it("enriches the company row — stamps last_researched_at and the AI qualification score", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_companies")
      .select("id, status, source, last_researched_at, ai_qualification_score")
      .eq("id", companyId)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    const c = res.data;
    expect(c).toBeTruthy();
    expect(c?.last_researched_at).toBeTruthy();
    expect(typeof c?.ai_qualification_score).toBe("number");
    // The runner's own entry point created the record, so source is ai_research.
    expect(c?.source).toBe("ai_research");
  });

  it("mirrors the lifecycle to the permanent company timeline (scheduled → started → scored → completed)", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_timeline_events")
      .select("event_type")
      .eq("company_id", companyId);
    expect(res.error, res.error?.message).toBeNull();
    const types = new Set((res.data ?? []).map((r) => r.event_type));
    for (const t of ["task_scheduled", "task_started", "scored", "task_completed"]) {
      expect(types.has(t), `missing timeline event ${t}`).toBe(true);
    }
  });

  it("graceful degradation writes NOTHING it cannot stand behind — no fabricated brief, no invented contacts", async () => {
    // reasonSalesPrep skips without a provider, so no recommendation is drafted.
    const recs = await db(serviceClient())
      .from("hq_sales_recommendations")
      .select("id")
      .eq("company_id", companyId);
    expect(recs.error, recs.error?.message).toBeNull();
    expect((recs.data ?? []).length).toBe(0);

    // No decision makers were observable, so none are invented as contacts.
    const contacts = await db(serviceClient())
      .from("hq_sales_contacts")
      .select("id")
      .eq("company_id", companyId);
    expect(contacts.error, contacts.error?.message).toBeNull();
    expect((contacts.data ?? []).length).toBe(0);
  });

  it("the read side reconstructs the terminal run from the persisted jsonb", async () => {
    const state = await getResearchRunState(taskId);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("completed");
    expect(state?.phase).toBe("completed");
    expect(state?.summary).not.toBeNull();
    expect(state?.error ?? null).toBeNull();

    const report = await getResearchReport(taskId);
    expect(report).not.toBeNull();
    expect(report?.status).toBe("completed");
    expect(report?.provenance).toBe("deterministic");
    expect(report?.scoreFactors.length).toBe(10); // all ten, always present
    const known = (report?.scoreFactors ?? []).filter((f) => f.known).map((f) => f.key);
    for (const k of ["buying_intent", "technology", "decision_maker_access"]) {
      expect(known, `factor ${k} should be known`).toContain(k);
    }
    // The deterministic path drafts no brief and no outreach.
    expect(report?.brief ?? null).toBeNull();
    expect(report?.drafts ?? null).toBeNull();
    expect(report?.decisionMakers ?? []).toEqual([]);
  });

  it("live metrics aggregate the completed deterministic run", async () => {
    const metrics = await getResearchMetrics();
    expect(metrics.total).toBeGreaterThanOrEqual(1);
    expect(metrics.completed).toBeGreaterThanOrEqual(1);
    expect(metrics.scored).toBeGreaterThanOrEqual(1);
    expect(metrics.provenance.deterministic).toBeGreaterThanOrEqual(1);
    expect(metrics.recent.some((r) => r.taskId === taskId)).toBe(true);

    expect(await latestResearchTaskId(companyId)).toBe(taskId);
  });

  it("re-running a finished task is an idempotent skip (claim fails on a non-pending row)", async () => {
    const again = await runResearchTask(taskId);
    expect(again.ok).toBe(true);
    expect(again.status).toBe("skipped");
  });
});
