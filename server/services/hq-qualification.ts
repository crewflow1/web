import "server-only";

/**
 * CrewFlow HQ — Lead Qualification AI runner (CEO Directive 003, Module 3).
 *
 * The worker that makes the qualify/disqualify CALL. Module 2 (Research AI)
 * writes a transparent `ai_qualification_score` + a research report but leaves
 * the company at status='new' — nothing transitions it. This runner fills
 * exactly that gap. It owns NO tables of its own: it claims a `qualify_company`
 * task off the existing AI task queue, drives the lifecycle (Queued → Running →
 * Assessing → Deciding → Completed/Failed), runs the DETERMINISTIC rubric
 * (lib/qualification/criteria.ts), and persists every artifact through the
 * existing Sales-AI writers (hq-sales.ts). Each step is mirrored to the task's
 * `result` jsonb (so the live UI can poll) and the decisive ones to the
 * permanent company timeline.
 *
 * Honesty + safety (Directive 003):
 *   • Deterministic, not a model sample. A qualify/disqualify verdict gates a
 *     company's place in the pipeline, so it must be reconstructable from named
 *     rules — there is NO LLM in this path. The rubric is the arbiter.
 *   • It only ever moves a company OUT of 'new', and only to a qualification
 *     status (qualified | disqualified). A `review` verdict moves nothing — the
 *     lead is held at 'new' for a human. It never skips ahead into outreach,
 *     never contacts a prospect, never sends, never deletes, never moves money.
 *   • Idempotent: claiming conditionally flips pending→running, so re-running a
 *     finished task is a no-op skip; a cron drain can re-run anything stuck.
 *   • Every figure is traceable: timeline rows carry ai_employee_id + the
 *     `ai_qualification` source, and the full weighted verdict (criteria,
 *     confidence, rationale) is persisted to the task result.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { intelligenceCompleteness } from "@/lib/sales/intelligence";
import type { ScoreBand } from "@/lib/sales/model";
import {
  applyStep,
  decisionLabel,
  initialSteps,
  type QualificationDecision,
  type QualificationPhase,
  type QualificationRunState,
  type QualificationRunSummary,
  type QualificationStepKey,
  type QualificationStepState,
  type QualificationTaskStatus,
  type QualificationVerdict,
} from "@/lib/qualification/model";
import { qualifyCompany, type QualificationInput } from "@/lib/qualification/criteria";
import { listAiEmployees } from "@/server/services/ai-employees";
import {
  getCompany,
  recordTimelineEvent,
  setCompanyStatus,
} from "@/server/services/hq-sales";

/** Slug of the Lead Qualification AI employee (seeded by the Module 3 migration). */
const QUALIFICATION_AI_SLUG = "lead-qualification";
/** The task_type this runner claims (seeded alongside the employee). */
const QUALIFY_TASK_TYPE = "qualify_company";
/** Timeline provenance — a dedicated source slug, seeded by the migration, so
 *  qualification events are attributed honestly (not mislabelled as research). */
const QUALIFICATION_SOURCE = "ai_qualification";
/** A task left 'running' longer than this is presumed dead → re-claimable. */
const STUCK_RUNNING_MS = 5 * 60 * 1000;

type Actor = { id: string | null; email: string | null };

// ---------------------------------------------------------------------
// Minimal typed access to hq_sales_ai_tasks (the runner's only direct table).
// Mirrors the cast shim used across hq-sales.ts + hq-research.ts — a typing
// convenience, not duplicated business logic.
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface TaskQuery<T> extends DbList<T> {
  select(columns: string): TaskQuery<T>;
  insert(payload: unknown): TaskQuery<T>;
  update(payload: unknown): TaskQuery<T>;
  eq(column: string, value: unknown): TaskQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): TaskQuery<T>;
  lt(column: string, value: unknown): TaskQuery<T>;
  order(column: string, options?: { ascending?: boolean }): TaskQuery<T>;
  limit(count: number): TaskQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
function tasks<T>(admin: AdminClient): TaskQuery<T> {
  return admin.from("hq_sales_ai_tasks" as never) as unknown as TaskQuery<T>;
}

type TaskRow = {
  id: string;
  company_id: string | null;
  task_type: string;
  status: string;
  retry_count: number;
  max_retries: number;
  payload: Record<string, unknown> | null;
  result: QualificationResult | null;
  created_by_email: string | null;
  started_at: string | null;
};

const TASK_RUN_COLUMNS =
  "id, company_id, task_type, status, retry_count, max_retries, payload, result, created_by_email, started_at";

// ---------------------------------------------------------------------
// The task `result` jsonb the live UI polls. Bounded by construction — the
// whole verdict is small (five criteria + a short rationale).
// ---------------------------------------------------------------------

type QualificationResult = {
  phase: QualificationPhase;
  steps: QualificationStepState[];
  verdict: QualificationVerdict | null;
  summary: QualificationRunSummary | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

function freshResult(): QualificationResult {
  return {
    phase: "running",
    steps: initialSteps(),
    verdict: null,
    summary: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
}

// ---------------------------------------------------------------------
// Lead Qualification AI employee id — resolved once, cached for the process.
// ---------------------------------------------------------------------

let cachedEmployeeId: string | null | undefined;
async function qualificationEmployeeId(): Promise<string | null> {
  if (cachedEmployeeId !== undefined) return cachedEmployeeId;
  const employees = await listAiEmployees();
  cachedEmployeeId = employees.find((e) => e.slug === QUALIFICATION_AI_SLUG)?.id ?? null;
  return cachedEmployeeId;
}

// ---------------------------------------------------------------------
// Enqueue — the entry point the UI/action/cron use.
// ---------------------------------------------------------------------

export type StartQualificationInput = {
  /** The company to qualify. Must already exist (research it first). */
  companyId: string;
};

export type StartQualificationResult =
  | { ok: true; companyId: string; taskId: string }
  | { ok: false; error: string };

/**
 * Enqueue a qualify_company task for an EXISTING company, assigned to the Lead
 * Qualification AI. Unlike Research AI this never creates a company — there is
 * nothing to qualify until a company has been recorded (and ideally researched).
 * Returns the ids so the caller can route to the live run view.
 */
export async function startQualification(
  input: StartQualificationInput,
  actor: Actor,
): Promise<StartQualificationResult> {
  const admin = createAdminClient();
  const companyId = (input.companyId ?? "").trim();
  if (!companyId) return { ok: false, error: "A company is required to qualify." };

  const company = await getCompany(companyId);
  if (!company) return { ok: false, error: "Company not found." };

  const employeeId = await qualificationEmployeeId();
  const { data, error } = await tasks<{ id: string }>(admin)
    .insert({
      company_id: companyId,
      task_type: QUALIFY_TASK_TYPE,
      status: "pending",
      priority: "high",
      retry_count: 0,
      max_retries: 2,
      assigned_ai_employee_id: employeeId,
      payload: null,
      source: "manual",
      created_by_email: actor.email,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-qualification] enqueue failed", error);
    return { ok: false, error: error?.message ?? "Could not enqueue qualification." };
  }

  await recordTimelineEvent({
    company_id: companyId,
    event_type: "task_scheduled",
    actor_email: actor.email,
    ai_employee_id: employeeId,
    source: QUALIFICATION_SOURCE,
    body: "Lead Qualification AI task scheduled.",
    metadata: { task_id: data.id, task_type: QUALIFY_TASK_TYPE },
  });

  return { ok: true, companyId, taskId: data.id };
}

// ---------------------------------------------------------------------
// Claim / checkpoint.
// ---------------------------------------------------------------------

async function claimTask(admin: AdminClient, taskId: string): Promise<TaskRow | null> {
  const nowIso = new Date().toISOString();
  // Conditional update: only succeeds if the row is still pending.
  const { data } = await tasks<TaskRow>(admin)
    .update({ status: "running", started_at: nowIso })
    .eq("id", taskId)
    .in("status", ["pending"])
    .select(TASK_RUN_COLUMNS);
  const claimed = Array.isArray(data) ? data[0] : null;
  return claimed ?? null;
}

async function checkpoint(
  admin: AdminClient,
  taskId: string,
  result: QualificationResult,
): Promise<void> {
  const { error } = await tasks(admin).update({ result }).eq("id", taskId);
  if (error) console.error("[hq-qualification] checkpoint failed", error);
}

// ---------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------

export type RunOutcome =
  | { ok: true; taskId: string; status: "completed"; decision: QualificationDecision }
  | { ok: true; taskId: string; status: "skipped" }
  | { ok: false; taskId: string; status: "failed"; error: string };

export async function runQualificationTask(taskId: string): Promise<RunOutcome> {
  const admin = createAdminClient();

  const claimed = await claimTask(admin, taskId);
  if (!claimed) {
    // Already running/finished, or cancelled — nothing to do (idempotent).
    return { ok: true, taskId, status: "skipped" };
  }

  const actor: Actor = { id: null, email: claimed.created_by_email };
  const companyId = claimed.company_id;
  const result = freshResult();

  // A step helper bound to this run: mutate result, persist.
  const setStep = async (
    key: QualificationStepKey,
    status: QualificationStepState["status"],
    detail: string | null,
  ) => {
    result.steps = applyStep(result.steps, key, status, detail);
    await checkpoint(admin, taskId, result);
  };
  const setPhase = async (phase: QualificationPhase) => {
    result.phase = phase;
    await checkpoint(admin, taskId, result);
  };

  try {
    if (!companyId) throw new Error("Qualification task has no company.");
    const company = await getCompany(companyId);
    if (!company) throw new Error("Company not found for qualification task.");

    const employeeId = await qualificationEmployeeId();

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_started",
      ai_employee_id: employeeId,
      source: QUALIFICATION_SOURCE,
      body: `Lead Qualification AI started assessing ${company.name}.`,
      metadata: { task_id: taskId },
    });

    // ---- STEP: Lead loaded ------------------------------------------
    await setStep("load", "done", `Loaded ${company.name} (status: ${company.status})`);

    // ---- PHASE: Assessing -------------------------------------------
    await setPhase("assessing");

    // ---- STEP: Signals gathered -------------------------------------
    await setStep("signals", "active", "Gathering qualification signals…");
    const completeness = intelligenceCompleteness(company);
    const contacts = await loadContacts(companyId);
    const decisionMakers = contacts.filter((c) => c.is_decision_maker);
    const reachable = decisionMakers.filter(hasDirectChannel).length;

    const qInput: QualificationInput = {
      score: company.ai_qualification_score,
      evidence: completeness.pct,
      researched: !!company.last_researched_at,
      country: company.country,
      location: company.location ?? company.region ?? company.county,
      sector: company.construction_sector,
      industry: company.industry,
      decisionMakers: decisionMakers.length,
      reachableDecisionMakers: reachable,
    };

    await setStep(
      "signals",
      "done",
      `Fit ${qInput.score ?? "—"}, ${completeness.pct}% enriched, ${decisionMakers.length} decision maker${
        decisionMakers.length === 1 ? "" : "s"
      }`,
    );
    await recordTimelineEvent({
      company_id: companyId,
      event_type: "system",
      ai_employee_id: employeeId,
      source: QUALIFICATION_SOURCE,
      body: `Qualification signals gathered: fit ${
        qInput.score ?? "unknown"
      }, ${completeness.pct}% of the profile enriched, ${decisionMakers.length} decision maker${
        decisionMakers.length === 1 ? "" : "s"
      } (${reachable} reachable).`,
      metadata: {
        score: qInput.score,
        evidence: completeness.pct,
        researched: qInput.researched,
        decisionMakers: decisionMakers.length,
        reachable,
      },
    });

    // ---- STEP: Criteria evaluated -----------------------------------
    await setStep("evaluate", "active", "Evaluating the weighted criteria…");
    const verdict = qualifyCompany(qInput);
    result.verdict = verdict;
    const known = verdict.criteria.filter((c) => c.known).length;
    await setStep(
      "evaluate",
      "done",
      `${known}/${verdict.criteria.length} criteria evidenced · ${verdict.confidence}% confidence`,
    );
    await recordTimelineEvent({
      company_id: companyId,
      event_type: "system",
      ai_employee_id: employeeId,
      source: QUALIFICATION_SOURCE,
      body: `Criteria evaluated — ${known} of ${verdict.criteria.length} backed by evidence (${verdict.confidence}% confidence).`,
      metadata: {
        confidence: verdict.confidence,
        criteria: verdict.criteria.map((c) => ({
          key: c.key,
          value: c.value,
          known: c.known,
          passed: c.passed,
        })),
      },
    });

    // ---- PHASE: Deciding --------------------------------------------
    await setPhase("deciding");

    // ---- STEP: Decision recorded ------------------------------------
    await setStep("decision", "active", "Recording the verdict…");
    // The verdict itself — an AI-attributed `scored` event (reusing the
    // existing timeline vocabulary; the engine adds no new event type).
    await recordTimelineEvent({
      company_id: companyId,
      event_type: "scored",
      ai_employee_id: employeeId,
      source: QUALIFICATION_SOURCE,
      subject: `Qualification: ${decisionLabel(verdict.decision)}`,
      body: verdict.summary,
      metadata: {
        decision: verdict.decision,
        score: verdict.score,
        tier: verdict.tier,
        confidence: verdict.confidence,
        recommendedStatus: verdict.recommendedStatus,
        rationale: verdict.rationale,
      },
    });

    // Transition ONLY when the company is still 'new' AND a terminal status is
    // recommended (review recommends nothing). setCompanyStatus writes its own
    // status_change event and no-ops if the status already changed under us.
    let transitioned = false;
    if (company.status === "new" && verdict.recommendedStatus) {
      const moved = await setCompanyStatus(companyId, verdict.recommendedStatus, actor);
      transitioned = moved.ok;
      if (!moved.ok) {
        console.error("[hq-qualification] status transition failed", moved.error);
      }
    }

    await setStep(
      "decision",
      "done",
      transitioned
        ? `${decisionLabel(verdict.decision)} → moved to ${verdict.recommendedStatus}`
        : verdict.recommendedStatus
          ? `${decisionLabel(verdict.decision)} (status left unchanged)`
          : `${decisionLabel(verdict.decision)} — held at 'new' for review`,
    );

    // ---- PHASE: Completed -------------------------------------------
    const summary: QualificationRunSummary = {
      decision: verdict.decision,
      tier: verdict.tier,
      score: verdict.score,
      confidence: verdict.confidence,
      criteriaKnown: known,
      criteriaTotal: verdict.criteria.length,
      transitioned,
    };
    result.summary = summary;
    result.phase = "completed";
    result.finishedAt = new Date().toISOString();
    result.steps = applyStep(result.steps, "completed", "done", "Qualification complete");

    await tasks(admin)
      .update({
        status: "completed",
        finished_at: result.finishedAt,
        result,
        error_message: null,
      })
      .eq("id", taskId);

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_completed",
      ai_employee_id: employeeId,
      source: QUALIFICATION_SOURCE,
      body: `Qualification complete — ${decisionLabel(verdict.decision)}${
        transitioned ? ` (moved to ${verdict.recommendedStatus})` : ""
      }.`,
      metadata: { task_id: taskId, decision: verdict.decision, transitioned },
    });

    return { ok: true, taskId, status: "completed", decision: verdict.decision };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[hq-qualification] run failed", { taskId, error });
    result.phase = "failed";
    result.error = error;
    result.finishedAt = new Date().toISOString();
    await tasks(admin)
      .update({
        status: "failed",
        finished_at: result.finishedAt,
        error_message: error.slice(0, 4000),
        result,
        retry_count: claimed.retry_count + 1,
      })
      .eq("id", taskId);
    if (companyId) {
      await recordTimelineEvent({
        company_id: companyId,
        event_type: "task_failed",
        source: QUALIFICATION_SOURCE,
        body: `Qualification failed: ${error}`,
        metadata: { task_id: taskId },
      });
    }
    return { ok: false, taskId, status: "failed", error };
  }
}

// ---------------------------------------------------------------------
// Contacts read — decision-maker count + reachability (the only signal the
// rubric needs that isn't already on the company row).
// ---------------------------------------------------------------------

type ContactSignal = {
  is_decision_maker: boolean;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
};

function hasDirectChannel(c: ContactSignal): boolean {
  return !!(c.email?.trim() || c.phone?.trim() || c.linkedin_url?.trim());
}

async function loadContacts(companyId: string): Promise<ContactSignal[]> {
  const admin = createAdminClient();
  const { data } = await (
    admin.from("hq_sales_contacts" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => PromiseLike<{ data: ContactSignal[] | null }>;
      };
    }
  )
    .select("is_decision_maker, email, phone, linkedin_url")
    .eq("company_id", companyId);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------
// Live state for the polling UI + the cron drain.
// ---------------------------------------------------------------------

export async function getQualificationRunState(
  taskId: string,
): Promise<QualificationRunState | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{
    id: string;
    company_id: string | null;
    status: string;
    result: QualificationResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, company_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.company_id ? await getCompany(data.company_id) : null;
  const result = data.result;
  return {
    taskId: data.id,
    companyId: data.company_id,
    companyName: company?.name ?? null,
    status: normaliseTaskStatus(data.status),
    phase: result?.phase ?? phaseFromStatus(data.status),
    steps: result?.steps ?? initialSteps(),
    error: result?.error ?? data.error_message,
    startedAt: result?.startedAt ?? data.started_at,
    finishedAt: result?.finishedAt ?? data.finished_at,
    summary: result?.summary ?? null,
  };
}

/** The most recent qualification task for a company — lets the company page
 *  link straight to a live or finished run. */
export async function latestQualificationTaskId(companyId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{ id: string }>(admin)
    .select("id")
    .eq("company_id", companyId)
    .eq("task_type", QUALIFY_TASK_TYPE)
    .order("created_at", { ascending: false })
    .limit(1);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

function normaliseTaskStatus(s: string): QualificationTaskStatus {
  return s === "pending" || s === "running" || s === "completed" || s === "failed" || s === "cancelled"
    ? s
    : "pending";
}

function phaseFromStatus(s: string): QualificationPhase {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "cancelled") return "failed";
  if (s === "running") return "running";
  return "queued";
}

export type DrainResult = {
  ok: boolean;
  found: number;
  processed: number;
  results: Array<{ taskId: string; status: string }>;
};

/**
 * Cron entry point: pick up pending qualify_company tasks (and any stuck in
 * 'running' past the dead-worker threshold) and run them. Bounded per
 * invocation so one drain never runs away.
 */
export async function drainQualificationTasks(limit = 3): Promise<DrainResult> {
  const admin = createAdminClient();

  const { data: pending } = await tasks<{ id: string }>(admin)
    .select("id")
    .eq("task_type", QUALIFY_TASK_TYPE)
    .eq("status", "pending")
    .order("priority_rank", { ascending: true })
    .limit(limit);

  const ids = (pending ?? []).map((r) => r.id);

  // Re-queue dead 'running' tasks (worker timed out) that still have retries.
  if (ids.length < limit) {
    const cutoff = new Date(Date.now() - STUCK_RUNNING_MS).toISOString();
    const { data: stuck } = await tasks<{ id: string }>(admin)
      .select("id")
      .eq("task_type", QUALIFY_TASK_TYPE)
      .eq("status", "running")
      .lt("started_at", cutoff)
      .limit(limit - ids.length);
    for (const row of stuck ?? []) {
      // Flip back to pending so claimTask can re-acquire it.
      await tasks(admin).update({ status: "pending" }).eq("id", row.id);
      ids.push(row.id);
    }
  }

  const results: Array<{ taskId: string; status: string }> = [];
  for (const id of ids) {
    const outcome = await runQualificationTask(id);
    results.push({ taskId: id, status: outcome.status });
  }

  return { ok: true, found: ids.length, processed: results.length, results };
}

// ---------------------------------------------------------------------
// Read side — recent runs + live metrics (CEO dashboard). Bounded reads only:
// head-counts for totals, a capped window for the aggregates. Honest zeros
// when nothing has run yet.
// ---------------------------------------------------------------------

export type QualificationRunRow = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: QualificationTaskStatus;
  phase: QualificationPhase;
  decision: QualificationDecision | null;
  tier: ScoreBand | null;
  score: number | null;
  confidence: number | null;
  transitioned: boolean | null;
  createdAt: string | null;
  finishedAt: string | null;
};

type RecentTaskRow = {
  id: string;
  company_id: string | null;
  status: string;
  result: QualificationResult | null;
  created_at: string | null;
  finished_at: string | null;
};

/** Most recent qualification runs, newest first — the section home + CEO feed. */
export async function listRecentQualificationRuns(limit = 12): Promise<QualificationRunRow[]> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data } = await tasks<RecentTaskRow>(admin)
    .select("id, company_id, status, result, created_at, finished_at")
    .eq("task_type", QUALIFY_TASK_TYPE)
    .order("created_at", { ascending: false })
    .limit(capped);

  const rows = Array.isArray(data) ? data : [];
  const names = await loadCompanyNames(
    admin,
    rows.map((r) => r.company_id).filter((id): id is string => !!id),
  );
  return rows.map((r) => {
    const summary = r.result?.summary ?? null;
    return {
      taskId: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (names.get(r.company_id) ?? null) : null,
      status: normaliseTaskStatus(r.status),
      phase: r.result?.phase ?? phaseFromStatus(r.status),
      decision: summary?.decision ?? null,
      tier: summary?.tier ?? null,
      score: summary?.score ?? null,
      confidence: summary?.confidence ?? null,
      transitioned: summary?.transitioned ?? null,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  });
}

export type QualificationMetrics = {
  total: number;
  completed: number;
  inFlight: number;
  failed: number;
  qualified: number;
  disqualified: number;
  review: number;
  transitioned: number;
  avgConfidence: number | null;
  lastCompletedAt: string | null;
  recent: QualificationRunRow[];
};

/** Live Lead Qualification metrics for the section home + CEO dashboard tile. */
export async function getQualificationMetrics(): Promise<QualificationMetrics> {
  const admin = createAdminClient();
  const [total, completed, failed, inFlight] = await Promise.all([
    countQualification(admin),
    countQualification(admin, "completed"),
    countQualification(admin, "failed"),
    countQualification(admin, ["pending", "running"]),
  ]);

  // Aggregate the most-recent completed runs' summaries (capped window).
  const { data } = await tasks<{ result: QualificationResult | null; finished_at: string | null }>(admin)
    .select("result, finished_at")
    .eq("task_type", QUALIFY_TASK_TYPE)
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(200);

  let qualified = 0;
  let disqualified = 0;
  let review = 0;
  let transitioned = 0;
  let confidenceSum = 0;
  let confidenceN = 0;
  let lastCompletedAt: string | null = null;
  for (const row of Array.isArray(data) ? data : []) {
    const s = row.result?.summary;
    if (!s) continue;
    if (s.decision === "qualified") qualified += 1;
    else if (s.decision === "disqualified") disqualified += 1;
    else if (s.decision === "review") review += 1;
    if (s.transitioned) transitioned += 1;
    if (typeof s.confidence === "number") {
      confidenceSum += s.confidence;
      confidenceN += 1;
    }
    if (!lastCompletedAt && row.finished_at) lastCompletedAt = row.finished_at;
  }

  const recent = await listRecentQualificationRuns(8);

  return {
    total,
    completed,
    inFlight,
    failed,
    qualified,
    disqualified,
    review,
    transitioned,
    avgConfidence: confidenceN ? Math.round(confidenceSum / confidenceN) : null,
    lastCompletedAt,
    recent,
  };
}

type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }> & {
  select(columns: string, opts: { count: "exact"; head: true }): CountQuery;
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: ReadonlyArray<unknown>): CountQuery;
};

async function countQualification(
  admin: AdminClient,
  status?: string | string[],
): Promise<number> {
  let q = (admin.from("hq_sales_ai_tasks" as never) as unknown as CountQuery)
    .select("id", { count: "exact", head: true })
    .eq("task_type", QUALIFY_TASK_TYPE);
  if (Array.isArray(status)) q = q.in("status", status);
  else if (status) q = q.eq("status", status);
  const { count } = await q;
  return count ?? 0;
}

async function loadCompanyNames(
  admin: AdminClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const { data } = await (
    admin.from("hq_sales_companies" as never) as unknown as {
      select: (c: string) => {
        in: (k: string, v: ReadonlyArray<unknown>) => PromiseLike<{
          data: Array<{ id: string; name: string | null }> | null;
        }>;
      };
    }
  )
    .select("id, name")
    .in("id", unique);
  for (const row of data ?? []) {
    if (row.name) map.set(row.id, row.name);
  }
  return map;
}

// ---------------------------------------------------------------------
// Full report view — the completed verdict the live page renders once the run
// finishes (decoded straight from result jsonb).
// ---------------------------------------------------------------------

export type QualificationReportView = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: QualificationTaskStatus;
  phase: QualificationPhase;
  summary: QualificationRunSummary | null;
  verdict: QualificationVerdict | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export async function getQualificationReport(
  taskId: string,
): Promise<QualificationReportView | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{
    id: string;
    company_id: string | null;
    status: string;
    result: QualificationResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, company_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.company_id ? await getCompany(data.company_id) : null;
  const r = data.result;
  return {
    taskId: data.id,
    companyId: data.company_id,
    companyName: company?.name ?? null,
    status: normaliseTaskStatus(data.status),
    phase: r?.phase ?? phaseFromStatus(data.status),
    summary: r?.summary ?? null,
    verdict: r?.verdict ?? null,
    startedAt: r?.startedAt ?? data.started_at,
    finishedAt: r?.finishedAt ?? data.finished_at,
    error: r?.error ?? data.error_message,
  };
}
