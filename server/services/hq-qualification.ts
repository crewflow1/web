import "server-only";

/**
 * CrewFlow HQ — Lead Qualification AI runner (CEO Directive 003, Module 3;
 * migrated onto the Generic Task Engine under Directive #012 / D-02, PR-F).
 *
 * The worker that makes the qualify/disqualify CALL. Module 2 (Research AI)
 * writes a transparent `ai_qualification_score` + a research report but leaves
 * the company at status='new' — nothing transitions it. This runner fills
 * exactly that gap. It owns NO tables of its own: it drains a `qualify_company`
 * task off the generic Task Engine (hq_ai_tasks) through the canonical runner
 * SDK (server/sdk/tasks.ts) — which claims the task, holds a time-boxed lease,
 * and decides the terminal transition off the handler's return/throw — drives
 * the lifecycle (Queued → Running → Assessing → Deciding → Completed/Failed),
 * runs the DETERMINISTIC rubric (lib/qualification/criteria.ts), and persists
 * every artifact through the existing Sales-AI writers (hq-sales.ts). Each step
 * is checkpointed to the task's `result` jsonb (so the live UI can poll) and the
 * decisive ones mirrored to the permanent company timeline.
 *
 * Honesty + safety (Directive 003):
 *   • Deterministic, not a model sample. A qualify/disqualify verdict gates a
 *     company's place in the pipeline, so it must be reconstructable from named
 *     rules — there is NO LLM in this path. The rubric is the arbiter.
 *   • It only ever moves a company OUT of 'new', and only to a qualification
 *     status (qualified | disqualified). A `review` verdict moves nothing — the
 *     lead is held at 'new' for a human. It never skips ahead into outreach,
 *     never contacts a prospect, never sends, never deletes, never moves money.
 *   • Idempotent: the engine claims atomically (FOR UPDATE SKIP LOCKED), so a
 *     double-kick (browser + cron) is harmless — the loser finds the queue
 *     drained and reports a skip. Crash recovery is the engine's: a claim takes a
 *     time-boxed lease and the task-reaper cron recovers anything whose lease
 *     expired, with engine-driven retry/backoff replacing the old wall-clock
 *     stuck-detection (Directive #012 / D-02, PR-F).
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
import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  getCompany,
  recordTimelineEvent,
  setCompanyStatus,
} from "@/server/services/hq-sales";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  drainTaskType,
  NonRetryableError,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type EmployeeIdentity,
  type RunContext,
  type TaskHandler,
} from "@/server/sdk/tasks";
import { resolveServedAuthority } from "@/server/sdk/registry-parity";

/** Slug of the Lead Qualification AI employee (seeded by the Module 3 migration). */
const QUALIFICATION_AI_SLUG = "lead-qualification";
/** The durable task_type this employee drains off the generic engine. */
const QUALIFY_TASK_TYPE = "qualify_company";
/** Timeline provenance — a dedicated source slug, seeded by the migration, so
 *  qualification events are attributed honestly (not mislabelled as research). */
const QUALIFICATION_SOURCE = "ai_qualification";

type Actor = { id: string | null; email: string | null };

// ---------------------------------------------------------------------
// READ-ONLY typed access to hq_ai_tasks (the generic engine — Directive #012
// / D-02, PR-F). The queue is WRITTEN only through the SECURITY DEFINER entry
// points: enqueue via `enqueueTask` (hq-tasks.ts) and every claim / heartbeat /
// checkpoint / complete / fail through the runner SDK (server/sdk/tasks.ts).
// Reads are direct service-role selects — `hq_ai_tasks` is RLS:hq, so the admin
// client is the only thing that can see it. This shim therefore exposes NO
// insert/update/delete: a raw queue mutation here would break the engine's
// standing posture (task-engine-spine.test.ts).
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface TaskRead<T> extends DbList<T> {
  select(columns: string): TaskRead<T>;
  eq(column: string, value: unknown): TaskRead<T>;
  order(column: string, options?: { ascending?: boolean }): TaskRead<T>;
  limit(count: number): TaskRead<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
function taskReads<T>(admin: AdminClient): TaskRead<T> {
  return admin.from("hq_ai_tasks" as never) as unknown as TaskRead<T>;
}

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

let cachedEmployee: AiEmployee | null | undefined;
async function qualificationEmployee(): Promise<AiEmployee | null> {
  if (cachedEmployee !== undefined) return cachedEmployee;
  const employees = await listAiEmployees();
  cachedEmployee = employees.find((e) => e.slug === QUALIFICATION_AI_SLUG) ?? null;
  return cachedEmployee;
}
async function qualificationEmployeeId(): Promise<string | null> {
  return (await qualificationEmployee())?.id ?? null;
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
  const companyId = (input.companyId ?? "").trim();
  if (!companyId) return { ok: false, error: "A company is required to qualify." };

  const company = await getCompany(companyId);
  if (!company) return { ok: false, error: "Company not found." };

  const employeeId = await qualificationEmployeeId();
  // Enqueue onto the generic engine (hq_ai_tasks) through the create entry point.
  // The company becomes the task's polymorphic SUBJECT; `origin`/`createdBy`/
  // `assignedEmployeeId` carry the provenance the bespoke columns used to. This
  // employee carries no per-task payload — the rubric reads the company row live.
  const enq = await enqueueTask({
    taskType: QUALIFY_TASK_TYPE,
    subjectKind: "company",
    subjectId: companyId,
    priority: "high",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    payload: {},
    origin: "manual",
    createdBy: actor.email,
  });

  if (!enq.ok) {
    console.error("[hq-qualification] enqueue failed", enq.error);
    return { ok: false, error: enq.error ?? "Could not enqueue qualification." };
  }
  const taskId = enq.task.id;

  await recordTimelineEvent({
    company_id: companyId,
    event_type: "task_scheduled",
    actor_email: actor.email,
    ai_employee_id: employeeId,
    source: QUALIFICATION_SOURCE,
    body: "Lead Qualification AI task scheduled.",
    metadata: { task_id: taskId, task_type: QUALIFY_TASK_TYPE },
  });

  return { ok: true, companyId, taskId };
}

// ---------------------------------------------------------------------
// Runner identity (Directive #012 / D-02, PR-F). The slug drives the lease
// owner + provenance; employeeId binds the (unused-here) memory facet. Resolved
// per-tick — qualificationEmployeeId() is process-cached, so this is ~free.
// ---------------------------------------------------------------------

async function qualificationIdentity(): Promise<EmployeeIdentity> {
  const emp = await qualificationEmployee();
  // The seeded lead-qualification row id when present; the stable slug as a
  // last-resort opaque identity (lease owner only) if it was never seeded.
  // Capabilities resolve from the row (tools_allowed ∪ permissions.scopes) — left
  // absent when unseeded, so the runner defaults ctx.capabilities to the empty set.
  const identity: EmployeeIdentity = {
    employeeId: emp?.id ?? QUALIFICATION_AI_SLUG,
    slug: QUALIFICATION_AI_SLUG,
  };
  // LR3 runtime authority switch (CEO Directive #015 / D-05): serve EVERY authority dimension
  // — capabilities, posture AND memory scope — from the now-AUTHORITATIVE Capability Registry,
  // with the legacy resolution RETAINED as the rollback / fail-safe path. resolveServedAuthority
  // falls back to legacy on a deliberate rollback (CAPABILITY_AUTHORITY_SOURCE=legacy), a
  // registry read error, or a subject the registry is silent about, so the switch can never
  // strand the employee, and folds the continuous shadow verification (the Shadow Validation
  // Rule) onto the served value. Behaviour-preserving while the flat mirror holds: the served
  // posture equals the legacy locked floor (Directive 001) and the served memory scope equals
  // the legacy column — R4 moved tokens, LR3 moves the remaining two runtime reads.
  if (emp) {
    const served = await resolveServedAuthority(emp);
    identity.capabilities = served.capabilities;
    identity.posture = served.posture;
    identity.memoryScope = served.memoryScope;
  }
  return identity;
}

// ---------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------

/**
 * The `qualify_company` business logic, as a Task Engine handler (Directive
 * #012 / D-02, PR-F). Rule 5: business logic ONLY. The runner (server/sdk/
 * tasks.ts) owns the lifecycle mechanism — it has already CLAIMED the task and
 * stamped the lease before this runs; it heartbeats while this works; and it
 * decides the terminal transition off this function's return/throw:
 *   • return the QualificationResult → the runner COMPLETES the task with it
 *     (hq_ai_task_complete persists it into the same `result` jsonb the live UI
 *     polls, so the read side is unchanged);
 *   • throw                          → the runner FAILS the task. A structural
 *     error a retry cannot fix is thrown as NonRetryableError (terminal);
 *     anything else is retryable, re-queued with backoff by the engine — which
 *     is what replaces the old STUCK_RUNNING_MS re-queue.
 *
 * Every checkpoint goes through `ctx.tasks.checkpoint` (lease-guarded); the
 * handler never touches the queue, the lease, or the spine directly.
 */
const qualificationTaskHandler: TaskHandler = async (ctx: RunContext) => {
  const taskId = ctx.task.id;
  const companyId = ctx.task.subject_id;
  const actor: Actor = { id: null, email: ctx.task.created_by };
  const result = freshResult();

  // A step helper bound to this run: mutate result, persist (lease-guarded).
  const setStep = async (
    key: QualificationStepKey,
    status: QualificationStepState["status"],
    detail: string | null,
  ) => {
    result.steps = applyStep(result.steps, key, status, detail);
    await ctx.tasks.checkpoint(result);
  };
  const setPhase = async (phase: QualificationPhase) => {
    result.phase = phase;
    await ctx.tasks.checkpoint(result);
  };

  try {
    if (!companyId) throw new NonRetryableError("Qualification task has no company.");
    const company = await getCompany(companyId);
    if (!company) throw new NonRetryableError("Company not found for qualification task.");

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

    // Hand the terminal result back; the runner completes the task with it
    // (hq_ai_task_complete writes it into the same `result` jsonb).
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[hq-qualification] run failed", { taskId, error });
    result.phase = "failed";
    result.error = error;
    result.finishedAt = new Date().toISOString();
    // Best-effort: persist the failed phase so the live UI reflects it. The lease
    // may already be gone (reaped mid-run) — swallow that; the runner's failTask
    // is the source of truth for the terminal transition + error_message.
    try {
      await ctx.tasks.checkpoint(result);
    } catch {
      /* lease lost — nothing to persist; the runner will record the failure */
    }
    if (companyId) {
      await recordTimelineEvent({
        company_id: companyId,
        event_type: "task_failed",
        source: QUALIFICATION_SOURCE,
        body: `Qualification failed: ${error}`,
        metadata: { task_id: taskId },
      });
    }
    // Re-throw so the runner fails the task (retryable unless NonRetryableError),
    // re-queuing with backoff — the engine's retry replaces STUCK_RUNNING_MS.
    throw e;
  }
};

// ---------------------------------------------------------------------
// The drivers — the two entry points that run the handler through the canonical
// runner (claim-one-and-exit). Both register the handler (idempotent) and act as
// this employee's identity; neither re-implements the run-loop.
// ---------------------------------------------------------------------

export type RunOutcome =
  | { ok: true; taskId: string; status: "completed"; decision: QualificationDecision | null }
  | { ok: true; taskId: string; status: "skipped" }
  | { ok: false; taskId: string; status: "failed"; error: string };

/**
 * Kick the qualification queue: claim the next ready `qualify_company` task and
 * drive it to a terminal transition via the runner. Fire-and-forget from the
 * live run page the moment it mounts.
 *
 * Engine semantics: the generic queue dequeues by TYPE (atomic FOR UPDATE SKIP
 * LOCKED), not by a specific id, so this runs "the next ready qualify task" —
 * which immediately after an enqueue is the one just created. The atomic claim
 * makes a double-kick (browser + cron) harmless: the loser finds an empty queue
 * and reports `skipped`. `taskId` is accepted for the caller's validation /
 * logging; the claim is type-oriented by design.
 */
export async function runQualificationTask(taskId?: string): Promise<RunOutcome> {
  const identity = await qualificationIdentity();
  registerTaskHandler(QUALIFY_TASK_TYPE, identity, qualificationTaskHandler);
  const o = await runReadyTask(QUALIFY_TASK_TYPE, qualificationTaskHandler, identity);
  switch (o.status) {
    case "completed":
      return { ok: true, taskId: o.taskId, status: "completed", decision: await decisionOfTask(o.taskId) };
    case "empty":
      // Nothing ready — already claimed/finished elsewhere (idempotent double-kick).
      return { ok: true, taskId: taskId ?? "", status: "skipped" };
    case "failed":
      return { ok: false, taskId: o.taskId, status: "failed", error: o.error };
    case "lease_lost":
      return { ok: false, taskId: o.taskId, status: "failed", error: "lease lost (reaped or re-claimed)" };
    case "error":
      return { ok: false, taskId: taskId ?? "", status: "failed", error: o.error };
  }
}

/** Read back a completed task's verdict decision from its persisted result jsonb. */
async function decisionOfTask(taskId: string): Promise<QualificationDecision | null> {
  const admin = createAdminClient();
  const { data } = await taskReads<{ result: QualificationResult | null }>(admin)
    .select("result")
    .eq("id", taskId)
    .maybeSingle();
  return data?.result?.summary?.decision ?? null;
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
  const { data } = await taskReads<{
    id: string;
    subject_id: string | null;
    status: string;
    result: QualificationResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, subject_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.subject_id ? await getCompany(data.subject_id) : null;
  const result = data.result;
  return {
    taskId: data.id,
    companyId: data.subject_id,
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
  const { data } = await taskReads<{ id: string }>(admin)
    .select("id")
    .eq("subject_id", companyId)
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

export type DrainResult = { ok: boolean } & DrainSummary;

/**
 * Cron entry point: drain ready `qualify_company` tasks through the canonical
 * runner, one at a time, up to `limit` this tick, then exit (claim-one-and-exit).
 *
 * The bespoke "re-queue anything stuck in 'running' past STUCK_RUNNING_MS" step
 * is GONE — crash recovery is now the engine's: a claim takes a time-boxed lease,
 * the runner heartbeats it, and the separate reaper cron (task-reaper) recovers
 * any task whose lease expired. Worker-declared liveness replaced the 5-minute
 * wall clock (Directive #012 / D-02, PR-F).
 */
export async function drainQualificationTasks(limit = 3): Promise<DrainResult> {
  const identity = await qualificationIdentity();
  registerTaskHandler(QUALIFY_TASK_TYPE, identity, qualificationTaskHandler);
  const summary = await drainTaskType(QUALIFY_TASK_TYPE, qualificationTaskHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
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
  subject_id: string | null;
  status: string;
  result: QualificationResult | null;
  created_at: string | null;
  finished_at: string | null;
};

/** Most recent qualification runs, newest first — the section home + CEO feed. */
export async function listRecentQualificationRuns(limit = 12): Promise<QualificationRunRow[]> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data } = await taskReads<RecentTaskRow>(admin)
    .select("id, subject_id, status, result, created_at, finished_at")
    .eq("task_type", QUALIFY_TASK_TYPE)
    .order("created_at", { ascending: false })
    .limit(capped);

  const rows = Array.isArray(data) ? data : [];
  const names = await loadCompanyNames(
    admin,
    rows.map((r) => r.subject_id).filter((id): id is string => !!id),
  );
  return rows.map((r) => {
    const summary = r.result?.summary ?? null;
    return {
      taskId: r.id,
      companyId: r.subject_id,
      companyName: r.subject_id ? (names.get(r.subject_id) ?? null) : null,
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
  const { data } = await taskReads<{ result: QualificationResult | null; finished_at: string | null }>(admin)
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
  let q = (admin.from("hq_ai_tasks" as never) as unknown as CountQuery)
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
  const { data } = await taskReads<{
    id: string;
    subject_id: string | null;
    status: string;
    result: QualificationResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, subject_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.subject_id ? await getCompany(data.subject_id) : null;
  const r = data.result;
  return {
    taskId: data.id,
    companyId: data.subject_id,
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
