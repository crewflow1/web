import { beforeAll, afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  drainQualificationTasks,
  getQualificationMetrics,
  getQualificationReport,
  getQualificationRunState,
  latestQualificationTaskId,
  runQualificationTask,
  startQualification,
  type RunOutcome,
} from "@/server/services/hq-qualification";
import {
  addContact,
  createCompany,
  type CompanyWriteInput,
  type ContactWriteInput,
} from "@/server/services/hq-sales";

/**
 * Lead Qualification AI runner — real-Postgres proof of the decision engine
 * (Module 3, CEO Directive 003; six-gate bar). Gate 4.
 *
 * The runner (server/services/hq-qualification.ts) owns NO tables of its own:
 * it claims a `qualify_company` task off hq_sales_ai_tasks, drives the
 * lifecycle (Queued → Running → Assessing → Deciding → Completed), runs the
 * DETERMINISTIC rubric, and persists every artifact through the existing
 * Sales-AI writers. The unit tier proves the pure rubric in isolation; this
 * tier proves the BEHAVIOUR a mock cannot: that against a LIVE database with the
 * real migrations applied (so the lead-qualification employee, the
 * `qualify_company` task type, and the `ai_qualification` source all exist), a
 * full run actually writes the rows it claims to, in the shapes it claims, and
 * moves the company exactly where the verdict says — and nowhere else.
 *
 * There is no model in this path, so no mock is needed: the rubric is the whole
 * engine. We seed two ground-truth companies that force two opposite, certain
 * verdicts and assert the persisted consequences of each:
 *
 *   • A UK, well-scored, enriched construction lead → QUALIFIED, and the company
 *     is transitioned new → qualified, with the verdict attributed to the AI
 *     employee via the dedicated `ai_qualification` source.
 *   • An overseas company → DISQUALIFIED on the territory hard gate regardless
 *     of fit, and transitioned new → disqualified.
 *
 * Plus the read side, the metrics aggregate, and idempotency (re-running a
 * finished task is a no-op skip).
 *
 * Runs only against a live DB (describeIntegration): skips locally, fails loudly
 * in CI if the DB is missing. Teardown deletes both probe companies, whose FKs
 * cascade to their tasks, contacts and timeline rows.
 */

// loose-cast client shim — the generated Database type does not model the
// hq_sales_* family (HQ is service-role-only), mirroring research-runner.test.ts.
type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
}
interface UpdChain extends PromiseLike<{ error: { message: string } | null }> {
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
}
const db = (client: unknown): Db => client as unknown as Db;

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `qual${alpha(10)}`;
const ACTOR = { id: null, email: `it-qual-${alpha(6)}@probe.crewflow.test` };

// The runner's DB handle (createAdminClient) reads NEXT_PUBLIC_SUPABASE_URL; the
// integration CI job exports the live stack under the bare SUPABASE_URL, so
// bridge the one name the runner needs onto the same stack the assertions read.
function bridgeRunnerEnv(): void {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

/** A complete company write input, all-nullable fields defaulted, with overrides. */
function companyInput(overrides: Partial<CompanyWriteInput>): CompanyWriteInput {
  return {
    name: `Probe ${TOKEN} Ltd`,
    summary: "Integration probe company.",
    website: null,
    industry: null,
    employeeCount: null,
    annualTurnoverGbp: null,
    location: null,
    region: null,
    county: null,
    country: "United Kingdom",
    primaryEmail: null,
    primaryPhone: null,
    linkedinUrl: null,
    instagramUrl: null,
    facebookUrl: null,
    companiesHouseUrl: null,
    companiesHouseNumber: null,
    websiteTechnology: [],
    crmScore: null,
    aiQualificationScore: null,
    estimatedDealValueGbp: null,
    status: "new",
    source: "manual",
    assignedToEmail: null,
    tags: [],
    revenueEstimateGbp: null,
    growthScore: null,
    constructionSector: null,
    softwareUsed: [],
    estimatedSoftwareSpendGbp: null,
    fleetSize: null,
    staffSize: null,
    websiteQualityScore: null,
    marketingQualityScore: null,
    hiringActivityScore: null,
    digitalMaturityScore: null,
    ...overrides,
  };
}

describeIntegration("HQ Lead Qualification AI · runner against a real Postgres (Module 3)", () => {
  // The qualified scenario.
  let qualifiedCompanyId = "";
  let qualifiedTaskId = "";
  let qualifiedOutcome: RunOutcome | null = null;
  // The disqualified (overseas) scenario.
  let overseasCompanyId = "";
  let overseasTaskId = "";
  let overseasOutcome: RunOutcome | null = null;

  beforeAll(async () => {
    bridgeRunnerEnv();
    const svc = serviceClient();

    // --- A certain QUALIFY: UK, hot fit, ≥25% enriched, construction --------
    const qualified = await createCompany(
      companyInput({
        name: `Probe ${TOKEN} Construction Ltd`,
        country: "United Kingdom",
        industry: "Construction",
        constructionSector: "Groundworks",
        aiQualificationScore: 85,
        // ≥5 of 19 profile fields present clears the 25% evidence floor.
        employeeCount: 40,
        annualTurnoverGbp: 5_000_000,
        website: "https://probe.example.co.uk",
        primaryEmail: "hello@probe.example.co.uk",
        primaryPhone: "+441234567890",
        websiteQualityScore: 72,
        digitalMaturityScore: 66,
      }),
      ACTOR,
    );
    expect(qualified.ok, qualified.ok ? "" : qualified.error).toBe(true);
    if (!qualified.ok) throw new Error(qualified.error);
    qualifiedCompanyId = qualified.id;

    // Stamp last_researched_at so the evidence criterion reads as "researched"
    // (createCompany does not write this column).
    await db(svc)
      .from("hq_sales_companies")
      .update({ last_researched_at: new Date().toISOString() })
      .eq("id", qualifiedCompanyId);

    // A reachable decision maker — exercises loadContacts + the reachable path.
    const contact: ContactWriteInput = {
      fullName: "Pat Probe",
      title: "Managing Director",
      seniority: "c_level",
      email: "pat@probe.example.co.uk",
      phone: null,
      linkedinUrl: null,
      isPrimary: true,
      isDecisionMaker: true,
      notes: "",
    };
    await addContact(qualifiedCompanyId, contact, ACTOR);

    const startedQ = await startQualification({ companyId: qualifiedCompanyId }, ACTOR);
    expect(startedQ.ok, startedQ.ok ? "" : startedQ.error).toBe(true);
    if (!startedQ.ok) throw new Error(startedQ.error);
    qualifiedTaskId = startedQ.taskId;
    qualifiedOutcome = await runQualificationTask(qualifiedTaskId);

    // --- A certain DISQUALIFY: overseas, on the territory hard gate ----------
    const overseas = await createCompany(
      companyInput({
        name: `Probe ${TOKEN} Bau GmbH`,
        country: "Germany",
        industry: "Construction",
        aiQualificationScore: 70, // strong fit, but territory overrides it
      }),
      ACTOR,
    );
    expect(overseas.ok, overseas.ok ? "" : overseas.error).toBe(true);
    if (!overseas.ok) throw new Error(overseas.error);
    overseasCompanyId = overseas.id;

    const startedO = await startQualification({ companyId: overseasCompanyId }, ACTOR);
    expect(startedO.ok, startedO.ok ? "" : startedO.error).toBe(true);
    if (!startedO.ok) throw new Error(startedO.error);
    overseasTaskId = startedO.taskId;
    overseasOutcome = await runQualificationTask(overseasTaskId);
  });

  afterAll(async () => {
    const svc = serviceClient();
    for (const id of [qualifiedCompanyId, overseasCompanyId]) {
      if (id) await db(svc).from("hq_sales_companies").delete().eq("id", id);
    }
  });

  it("completes the qualified run deterministically with a 'qualified' decision", () => {
    const o = qualifiedOutcome;
    expect(o).not.toBeNull();
    if (!o || o.status !== "completed") {
      throw new Error(`expected a completed run, got ${o ? JSON.stringify(o) : "null"}`);
    }
    expect(o.decision).toBe("qualified");
  });

  it("transitions the qualified company new → qualified (only ever moves OUT of 'new')", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_companies")
      .select("id, status")
      .eq("id", qualifiedCompanyId)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("qualified");
  });

  it("records the verdict as an AI-attributed `scored` event via the dedicated ai_qualification source", async () => {
    const res = await db(serviceClient())
      .from("hq_sales_timeline_events")
      .select("event_type, source, ai_employee_id, metadata")
      .eq("company_id", qualifiedCompanyId);
    expect(res.error, res.error?.message).toBeNull();
    const events = res.data ?? [];

    // The full lifecycle is mirrored to the permanent timeline.
    const types = new Set(events.map((e) => e.event_type));
    for (const t of ["task_scheduled", "task_started", "system", "scored", "task_completed", "status_change"]) {
      expect(types.has(t), `missing timeline event ${t}`).toBe(true);
    }

    // The decisive `scored` row carries honest attribution + the full verdict.
    const scored = events.find((e) => e.event_type === "scored");
    expect(scored, "no scored event written").toBeTruthy();
    expect(scored?.source).toBe("ai_qualification");
    expect(scored?.ai_employee_id, "scored verdict not attributed to the AI employee").toBeTruthy();
    const meta = (scored?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.decision).toBe("qualified");
    expect(meta.recommendedStatus).toBe("qualified");
    expect(typeof meta.confidence).toBe("number");
  });

  it("the read side reconstructs the terminal qualified run from the persisted jsonb", async () => {
    const state = await getQualificationRunState(qualifiedTaskId);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("completed");
    expect(state?.phase).toBe("completed");
    expect(state?.error ?? null).toBeNull();
    expect(state?.summary?.decision).toBe("qualified");
    expect(state?.summary?.transitioned).toBe(true);

    const report = await getQualificationReport(qualifiedTaskId);
    expect(report).not.toBeNull();
    expect(report?.status).toBe("completed");
    const verdict = report?.verdict;
    expect(verdict, "no verdict persisted").toBeTruthy();
    expect(verdict?.decision).toBe("qualified");
    expect(verdict?.recommendedStatus).toBe("qualified");
    expect(verdict?.criteria.length).toBe(5); // all five, always present
    expect((verdict?.confidence ?? 0)).toBeGreaterThan(0);
    // Every criterion carries an evidence flag — the no-black-box contract.
    for (const c of verdict?.criteria ?? []) {
      expect(typeof c.known).toBe("boolean");
      expect(typeof c.weight).toBe("number");
    }
  });

  it("disqualifies the overseas company on the territory hard gate, regardless of a strong fit", async () => {
    const o = overseasOutcome;
    expect(o).not.toBeNull();
    if (!o || o.status !== "completed") {
      throw new Error(`expected a completed run, got ${o ? JSON.stringify(o) : "null"}`);
    }
    expect(o.decision).toBe("disqualified");

    const res = await db(serviceClient())
      .from("hq_sales_companies")
      .select("id, status")
      .eq("id", overseasCompanyId)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("disqualified");

    const report = await getQualificationReport(overseasTaskId);
    expect(report?.verdict?.decision).toBe("disqualified");
    expect(report?.verdict?.recommendedStatus).toBe("disqualified");
  });

  it("live metrics aggregate the two completed runs", async () => {
    const metrics = await getQualificationMetrics();
    expect(metrics.total).toBeGreaterThanOrEqual(2);
    expect(metrics.completed).toBeGreaterThanOrEqual(2);
    expect(metrics.qualified).toBeGreaterThanOrEqual(1);
    expect(metrics.disqualified).toBeGreaterThanOrEqual(1);
    expect(metrics.transitioned).toBeGreaterThanOrEqual(2);
    expect(metrics.recent.some((r) => r.taskId === qualifiedTaskId)).toBe(true);

    expect(await latestQualificationTaskId(qualifiedCompanyId)).toBe(qualifiedTaskId);
  });

  it("re-running a finished task is an idempotent skip (claim fails on a non-pending row)", async () => {
    const again = await runQualificationTask(qualifiedTaskId);
    expect(again.ok).toBe(true);
    expect(again.status).toBe("skipped");

    // The drain, too, finds nothing pending to do for these tasks.
    const drained = await drainQualificationTasks(5);
    expect(drained.ok).toBe(true);
  });
});
