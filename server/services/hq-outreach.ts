import "server-only";

/**
 * CrewFlow HQ — Outreach AI runner (CEO Directive 010, Phase 4; migrated onto the
 * Generic Task Engine under Directive #012 / D-02 — the same LIFECYCLE every AI
 * employee inherits).
 *
 * The worker that DRAFTS the cold outreach email. Directive 010 Phase 1 registered
 * the employee (migration 20260729000000) and, per the Infrastructure Reuse Audit,
 * MINTED NO new work-kind vocabulary: "draft an outreach email" already existed as
 * the inert `generate_email` task type reserved in the Directive-004 foundation
 * (20260714000001_hq_sales_ai_scale.sql, category 'outreach'), claimed by no runner.
 * This runner is the claim the migration foresaw — it binds `generate_email` to a
 * handler and drives it through the canonical runner SDK (server/sdk/tasks.ts), which
 * claims the task, holds a time-boxed lease, and decides the terminal transition off
 * the handler's return/throw.
 *
 * It owns NO tables of its own: it reuses the Draft Engine (hq-drafts.ts) for
 * generation and the Sales-AI writers (hq-sales.ts) for the honest timeline. The
 * lifecycle it drives is Queued → Running → Drafting → Completed/Failed.
 *
 * EXECUTION STAYS LOCKED (Directive 001; the V1 safety contract, pinned in the
 * employee grant with requires_approval=true and NO send scope):
 *   • DRAFT ONLY. This runner GENERATES an immutable draft (hq_drafts) for a human
 *     to review, edit, approve and send. It never sends, never contacts a prospect,
 *     never changes a customer record, never deletes, never moves money. There is no
 *     mailer, no transport, no Executor here — the draft is the terminal artifact.
 *   • GOVERNED + DARK. Every model call routes through the Draft Engine's
 *     `invokeWithGovernor` gate (feature key `hq.draft`). With no cost tier bound,
 *     the governed leg short-circuits and the DETERMINISTIC fallback produces the
 *     draft — so the run COMPLETES honestly (status='fallback', provenance
 *     'deterministic'), it does not fail. Degradation is a first-class path, exactly
 *     as Research AI degrades to a deterministic profile when no provider is reachable.
 *   • Idempotent: the engine claims atomically (FOR UPDATE SKIP LOCKED), so a
 *     double-kick (browser + cron) is harmless — the loser finds the queue drained
 *     and reports a skip. Crash recovery is the engine's: a claim takes a lease, the
 *     runner heartbeats it, and the task-reaper cron recovers anything whose lease
 *     expired.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { listAiEmployees } from "@/server/services/ai-employees";
import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  getCompany,
  recordTimelineEvent,
} from "@/server/services/hq-sales";
import { assembleDraftContext, generateDraft } from "@/server/services/hq-drafts";
import type { DraftProvenance, DraftStatus } from "@/lib/drafts/model";
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

/** Slug of the Outreach AI employee (seeded by the Directive-010 Phase-1 migration). */
const OUTREACH_AI_SLUG = "outreach-ai";
/**
 * The durable task_type this employee drains off the generic engine. NOT minted here:
 * it is the inert `generate_email` type the Directive-004 foundation reserved and the
 * reuse audit chose to claim (never the parallel `draft_outreach` slug it rejected).
 */
const OUTREACH_TASK_TYPE = "generate_email";
/** Timeline provenance — a dedicated source slug (seeded by the migration) so outreach
 *  events are attributed honestly (never mislabelled as research/qualification). */
const OUTREACH_SOURCE = "ai_outreach";
/** The Draft Engine template this employee uses — a cold outreach email. */
const OUTREACH_DRAFT_KIND = "cold_email" as const;
/** The draft subject_type label the artifact + the Approval Engine key on. */
const OUTREACH_SUBJECT_TYPE = "outreach_email";

type Actor = { id: string | null; email: string | null };

// ---------------------------------------------------------------------
// READ-ONLY typed access to hq_ai_tasks (the generic engine). The queue is WRITTEN
// only through the SECURITY DEFINER entry points: enqueue via `enqueueTask`
// (hq-tasks.ts) and every claim / heartbeat / checkpoint / complete / fail through
// the runner SDK (server/sdk/tasks.ts). Reads are direct service-role selects —
// `hq_ai_tasks` is RLS:hq, so the admin client is the only thing that can see it.
// This shim therefore exposes NO insert/update/delete: a raw queue mutation here
// would break the engine's standing posture (task-engine-spine.test.ts).
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
// The task `result` jsonb the read model + a future live UI polls. Bounded by
// construction — a headline of the one draft the run produced.
// ---------------------------------------------------------------------

export type OutreachPhase = "queued" | "running" | "drafting" | "completed" | "failed";
export type OutreachTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OutreachStepKey = "load" | "context" | "draft" | "completed";
export type OutreachStepStatus = "pending" | "active" | "done" | "skipped" | "failed";
export type OutreachStepState = {
  key: OutreachStepKey;
  status: OutreachStepStatus;
  detail: string | null;
};

export type OutreachRunSummary = {
  /** The immutable hq_drafts row this run produced. */
  draftId: string | null;
  /** Which leg produced it — 'deterministic' on the dark path. */
  provenance: DraftProvenance | null;
  /** 'generated' (LLM) | 'fallback' (deterministic). */
  draftStatus: DraftStatus | null;
  /** Why the deterministic leg ran, when it did (observability). */
  fallbackReason: string | null;
  /** The drafted subject line (never transmitted — a headline for the operator). */
  subject: string | null;
};

type OutreachResult = {
  phase: OutreachPhase;
  steps: OutreachStepState[];
  summary: OutreachRunSummary | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

function initialSteps(): OutreachStepState[] {
  return [
    { key: "load", status: "pending", detail: null },
    { key: "context", status: "pending", detail: null },
    { key: "draft", status: "pending", detail: null },
    { key: "completed", status: "pending", detail: null },
  ];
}

function applyStep(
  steps: OutreachStepState[],
  key: OutreachStepKey,
  status: OutreachStepStatus,
  detail: string | null,
): OutreachStepState[] {
  return steps.map((s) => (s.key === key ? { key, status, detail } : s));
}

function freshResult(): OutreachResult {
  return {
    phase: "running",
    steps: initialSteps(),
    summary: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
}

// ---------------------------------------------------------------------
// Outreach AI employee id — resolved once, cached for the process.
// ---------------------------------------------------------------------

let cachedEmployee: AiEmployee | null | undefined;
async function outreachEmployee(): Promise<AiEmployee | null> {
  if (cachedEmployee !== undefined) return cachedEmployee;
  const employees = await listAiEmployees();
  cachedEmployee = employees.find((e) => e.slug === OUTREACH_AI_SLUG) ?? null;
  return cachedEmployee;
}
async function outreachEmployeeId(): Promise<string | null> {
  return (await outreachEmployee())?.id ?? null;
}

// ---------------------------------------------------------------------
// Enqueue — the entry point the UI/action/cron use.
// ---------------------------------------------------------------------

export type StartOutreachInput = {
  /** The company to draft outreach for. Must already exist (research + qualify first). */
  companyId: string;
  /** The Research AI task whose report grounds the draft, if known. */
  researchTaskId?: string | null;
  /** The Qualification task whose verdict informs the draft, if known. */
  qualificationTaskId?: string | null;
};

export type StartOutreachResult =
  | { ok: true; companyId: string; taskId: string }
  | { ok: false; error: string };

/**
 * Enqueue a `generate_email` task for an EXISTING company, assigned to Outreach AI.
 * Like Lead Qualification AI (and unlike Research AI) it never CREATES a company —
 * there is nothing to draft outreach for until a company has been recorded, and
 * ideally researched and cleared. The research/qualification task ids ride in the
 * write-once payload so the handler can ground the draft; both are optional (the
 * Draft Engine degrades each source independently).
 */
export async function startOutreach(
  input: StartOutreachInput,
  actor: Actor,
): Promise<StartOutreachResult> {
  const companyId = (input.companyId ?? "").trim();
  if (!companyId) return { ok: false, error: "A company is required to draft outreach." };

  const company = await getCompany(companyId);
  if (!company) return { ok: false, error: "Company not found." };

  const employeeId = await outreachEmployeeId();
  const payload: Record<string, unknown> = {};
  if (input.researchTaskId) payload.research_task_id = input.researchTaskId;
  if (input.qualificationTaskId) payload.qualification_task_id = input.qualificationTaskId;

  const enq = await enqueueTask({
    taskType: OUTREACH_TASK_TYPE,
    subjectKind: "company",
    subjectId: companyId,
    priority: "normal",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    payload,
    origin: "manual",
    createdBy: actor.email,
  });

  if (!enq.ok) {
    console.error("[hq-outreach] enqueue failed", enq.error);
    return { ok: false, error: enq.error ?? "Could not enqueue outreach." };
  }
  const taskId = enq.task.id;

  await recordTimelineEvent({
    company_id: companyId,
    event_type: "task_scheduled",
    actor_email: actor.email,
    ai_employee_id: employeeId,
    source: OUTREACH_SOURCE,
    body: "Outreach AI task scheduled.",
    metadata: { task_id: taskId, task_type: OUTREACH_TASK_TYPE },
  });

  return { ok: true, companyId, taskId };
}

// ---------------------------------------------------------------------
// Runner identity. The slug drives the lease owner + provenance; employeeId binds
// the memory facet. Authority resolves from the Capability Registry, with the
// default-deny FLOOR as the automatic fail-safe (Directive #015 / D-05) — so a
// registry read error or a silent subject strands the runner at the locked posture,
// never at an escalated one. Outreach AI's grant is read+draft+memory only; there
// is no send token to resolve, and execution never unlocks here.
// ---------------------------------------------------------------------

async function outreachIdentity(): Promise<EmployeeIdentity> {
  const emp = await outreachEmployee();
  const identity: EmployeeIdentity = {
    employeeId: emp?.id ?? OUTREACH_AI_SLUG,
    slug: OUTREACH_AI_SLUG,
  };
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
 * The `generate_email` business logic, as a Task Engine handler. Rule 5: business
 * logic ONLY. The runner owns the lifecycle mechanism — it has already CLAIMED the
 * task and stamped the lease before this runs; it heartbeats while this works; and
 * it decides the terminal transition off this function's return/throw:
 *   • return the OutreachResult → the runner COMPLETES the task with it;
 *   • throw                     → the runner FAILS the task (retryable unless it
 *     throws NonRetryableError, which is terminal).
 *
 * The DARK path (no cost tier bound) is a COMPLETION, not a failure: the Draft
 * Engine's governed leg short-circuits and its deterministic fallback produces the
 * draft, so `generateDraft` returns ok with provenance 'deterministic'. Only a
 * persistence/transport fault (generateDraft returning ok:false) is a real failure,
 * re-queued with backoff by the engine.
 */
const outreachTaskHandler: TaskHandler = async (ctx: RunContext) => {
  const taskId = ctx.task.id;
  const companyId = ctx.task.subject_id;
  const result = freshResult();

  const setStep = async (
    key: OutreachStepKey,
    status: OutreachStepStatus,
    detail: string | null,
  ) => {
    result.steps = applyStep(result.steps, key, status, detail);
    await ctx.tasks.checkpoint(result);
  };
  const setPhase = async (phase: OutreachPhase) => {
    result.phase = phase;
    await ctx.tasks.checkpoint(result);
  };

  try {
    if (!companyId) throw new NonRetryableError("Outreach task has no company.");
    const company = await getCompany(companyId);
    if (!company) throw new NonRetryableError("Company not found for outreach task.");

    const employeeId = await outreachEmployeeId();
    if (!employeeId) {
      // Without the seeded employee row there is no FK to attribute the draft to.
      // A retry cannot fix a missing seed, so this is terminal.
      throw new NonRetryableError("Outreach AI employee is not seeded.");
    }

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_started",
      ai_employee_id: employeeId,
      source: OUTREACH_SOURCE,
      body: `Outreach AI started drafting outreach for ${company.name}.`,
      metadata: { task_id: taskId },
    });
    await setStep("load", "done", `Loaded ${company.name} (status: ${company.status})`);

    // ---- Gather grounding context (each source degrades independently) ------
    await setPhase("drafting");
    await setStep("context", "active", "Gathering research, qualification and memory context…");
    const researchTaskId = readPayloadString(ctx.task.payload, "research_task_id");
    const qualificationTaskId = readPayloadString(ctx.task.payload, "qualification_task_id");
    const context = await assembleDraftContext({
      employeeId,
      subject: { name: company.name, label: OUTREACH_SUBJECT_TYPE },
      researchTaskId,
      qualificationTaskId,
      currentTaskId: taskId,
    });
    const sourceBits = [
      context.research ? "research" : null,
      context.qualification ? "qualification" : null,
      context.memory ? `${context.memory.count} memories` : null,
    ].filter(Boolean);
    await setStep(
      "context",
      "done",
      sourceBits.length ? `Grounded on ${sourceBits.join(", ")}` : "No prior context (grounded on the record only)",
    );

    // ---- Generate the draft (GOVERNED + DARK ⇒ deterministic fallback) -----
    await setStep("draft", "active", "Drafting the cold outreach email…");
    const drafted = await generateDraft({
      aiEmployeeId: employeeId,
      subjectType: OUTREACH_SUBJECT_TYPE,
      subjectId: companyId,
      kind: OUTREACH_DRAFT_KIND,
      context,
      correlationId: ctx.correlationId,
    });
    // A persistence/transport fault is a REAL failure the engine should retry — not
    // the dark path (which returns ok with a deterministic draft). Throw to re-queue.
    if (!drafted.ok) {
      throw new Error(`draft generation failed: ${drafted.error}`);
    }
    const draft = drafted.draft;

    const summary: OutreachRunSummary = {
      draftId: draft.id,
      provenance: draft.provenance,
      draftStatus: draft.status,
      fallbackReason: draft.fallback_reason,
      subject: draft.content?.subject ?? null,
    };
    result.summary = summary;
    await setStep(
      "draft",
      "done",
      draft.status === "fallback"
        ? `Deterministic draft ready for review (${draft.fallback_reason ?? "no provider"})`
        : "Draft ready for human review",
    );

    // DRAFT ONLY — record the draft on the timeline as an approval-pending artifact.
    // outcome='draft' + requiresApproval mirror the Research AI cold-email log: a
    // human reviews, edits, approves and sends. Nothing is transmitted here.
    await recordTimelineEvent({
      company_id: companyId,
      event_type: "email_generated",
      ai_employee_id: employeeId,
      source: OUTREACH_SOURCE,
      subject: draft.content?.subject ?? `Outreach draft for ${company.name}`,
      body: draft.content?.body ?? "",
      outcome: "draft",
      metadata: {
        task_id: taskId,
        draft_id: draft.id,
        provenance: draft.provenance,
        requiresApproval: true,
      },
    });

    // ---- Completed ----------------------------------------------------------
    result.phase = "completed";
    result.finishedAt = new Date().toISOString();
    result.steps = applyStep(result.steps, "completed", "done", "Outreach draft complete");

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_completed",
      ai_employee_id: employeeId,
      source: OUTREACH_SOURCE,
      body: `Outreach draft complete — ${
        draft.status === "fallback" ? "deterministic" : draft.provenance
      } draft awaiting human review.`,
      metadata: { task_id: taskId, draft_id: draft.id, provenance: draft.provenance },
    });

    // Hand the terminal result back; the runner completes the task with it.
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[hq-outreach] run failed", { taskId, error });
    result.phase = "failed";
    result.error = error;
    result.finishedAt = new Date().toISOString();
    try {
      await ctx.tasks.checkpoint(result);
    } catch {
      /* lease lost — nothing to persist; the runner will record the failure */
    }
    if (companyId) {
      await recordTimelineEvent({
        company_id: companyId,
        event_type: "task_failed",
        source: OUTREACH_SOURCE,
        body: `Outreach draft failed: ${error}`,
        metadata: { task_id: taskId },
      });
    }
    // Re-throw so the runner fails the task (retryable unless NonRetryableError).
    throw e;
  }
};

/** Pull a string field off the task's write-once payload, or null. */
function readPayloadString(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const v = payload?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}

// ---------------------------------------------------------------------
// The drivers — the two entry points that run the handler through the canonical
// runner (claim-one-and-exit). Both register the handler (idempotent) and act as
// this employee's identity; neither re-implements the run-loop.
// ---------------------------------------------------------------------

export type RunOutcome =
  | { ok: true; taskId: string; status: "completed"; draftId: string | null }
  | { ok: true; taskId: string; status: "skipped" }
  | { ok: false; taskId: string; status: "failed"; error: string };

/**
 * Kick the outreach queue: claim the next ready `generate_email` task and drive it
 * to a terminal transition via the runner. Fire-and-forget from the live view.
 *
 * Engine semantics: the generic queue dequeues by TYPE (atomic FOR UPDATE SKIP
 * LOCKED), not by a specific id, so this runs "the next ready outreach task" —
 * which immediately after an enqueue is the one just created. The atomic claim
 * makes a double-kick (browser + cron) harmless: the loser finds an empty queue
 * and reports `skipped`.
 */
export async function runOutreachTask(taskId?: string): Promise<RunOutcome> {
  const identity = await outreachIdentity();
  registerTaskHandler(OUTREACH_TASK_TYPE, identity, outreachTaskHandler);
  const o = await runReadyTask(OUTREACH_TASK_TYPE, outreachTaskHandler, identity);
  switch (o.status) {
    case "completed":
      return { ok: true, taskId: o.taskId, status: "completed", draftId: await draftOfTask(o.taskId) };
    case "empty":
      return { ok: true, taskId: taskId ?? "", status: "skipped" };
    case "failed":
      return { ok: false, taskId: o.taskId, status: "failed", error: o.error };
    case "lease_lost":
      return { ok: false, taskId: o.taskId, status: "failed", error: "lease lost (reaped or re-claimed)" };
    case "error":
      return { ok: false, taskId: taskId ?? "", status: "failed", error: o.error };
  }
}

/** Read back a completed task's produced draft id from its persisted result jsonb. */
async function draftOfTask(taskId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await taskReads<{ result: OutreachResult | null }>(admin)
    .select("result")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw readFailure("hq-outreach: task draft", error);
  return data?.result?.summary?.draftId ?? null;
}

export type DrainResult = { ok: boolean } & DrainSummary;

/**
 * Cron entry point: drain ready `generate_email` tasks through the canonical runner,
 * one at a time, up to `limit` this tick, then exit (claim-one-and-exit). Crash
 * recovery is the engine's: a claim takes a time-boxed lease, the runner heartbeats
 * it, and the separate reaper cron recovers any task whose lease expired.
 */
export async function drainOutreachTasks(limit = 3): Promise<DrainResult> {
  const identity = await outreachIdentity();
  registerTaskHandler(OUTREACH_TASK_TYPE, identity, outreachTaskHandler);
  const summary = await drainTaskType(OUTREACH_TASK_TYPE, outreachTaskHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

// ---------------------------------------------------------------------
// Live state for a polling UI + the read side.
// ---------------------------------------------------------------------

export type OutreachRunState = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: OutreachTaskStatus;
  phase: OutreachPhase;
  steps: OutreachStepState[];
  summary: OutreachRunSummary | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export async function getOutreachRunState(taskId: string): Promise<OutreachRunState | null> {
  const admin = createAdminClient();
  const { data, error } = await taskReads<{
    id: string;
    subject_id: string | null;
    status: string;
    result: OutreachResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, subject_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw readFailure("hq-outreach: run state", error);
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
    summary: result?.summary ?? null,
    startedAt: result?.startedAt ?? data.started_at,
    finishedAt: result?.finishedAt ?? data.finished_at,
    error: result?.error ?? data.error_message,
  };
}

/** The most recent outreach task for a company — lets a company page link straight
 *  to a live or finished run. */
export async function latestOutreachTaskId(companyId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await taskReads<{ id: string }>(admin)
    .select("id")
    .eq("subject_id", companyId)
    .eq("task_type", OUTREACH_TASK_TYPE)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw readFailure("hq-outreach: latest outreach task", error);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

function normaliseTaskStatus(s: string): OutreachTaskStatus {
  return s === "pending" || s === "running" || s === "completed" || s === "failed" || s === "cancelled"
    ? s
    : "pending";
}

function phaseFromStatus(s: string): OutreachPhase {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "cancelled") return "failed";
  if (s === "running") return "running";
  return "queued";
}

// ---------------------------------------------------------------------
// Read side — recent runs + live metrics. Bounded reads only: head-counts for
// totals, a capped window for the aggregates. Honest zeros when nothing has run.
// ---------------------------------------------------------------------

export type OutreachRunRow = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: OutreachTaskStatus;
  phase: OutreachPhase;
  draftId: string | null;
  provenance: DraftProvenance | null;
  createdAt: string | null;
  finishedAt: string | null;
};

type RecentTaskRow = {
  id: string;
  subject_id: string | null;
  status: string;
  result: OutreachResult | null;
  created_at: string | null;
  finished_at: string | null;
};

/** Most recent outreach runs, newest first — the section home + CEO feed. */
export async function listRecentOutreachRuns(limit = 12): Promise<OutreachRunRow[]> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await taskReads<RecentTaskRow>(admin)
    .select("id, subject_id, status, result, created_at, finished_at")
    .eq("task_type", OUTREACH_TASK_TYPE)
    .order("created_at", { ascending: false })
    .limit(capped);
  if (error) throw readFailure("hq-outreach: recent outreach runs", error);

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
      draftId: summary?.draftId ?? null,
      provenance: summary?.provenance ?? null,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  });
}

export type OutreachMetrics = {
  total: number;
  completed: number;
  inFlight: number;
  failed: number;
  drafted: number;
  provenance: { anthropic: number; openai: number; deterministic: number };
  lastCompletedAt: string | null;
  recent: OutreachRunRow[];
};

/** Live Outreach AI metrics for the section home + CEO dashboard tile. */
export async function getOutreachMetrics(): Promise<OutreachMetrics> {
  const admin = createAdminClient();
  const [total, completed, failed, inFlight] = await Promise.all([
    countOutreach(admin),
    countOutreach(admin, "completed"),
    countOutreach(admin, "failed"),
    countOutreach(admin, ["pending", "running"]),
  ]);

  const { data, error } = await taskReads<{ result: OutreachResult | null; finished_at: string | null }>(admin)
    .select("result, finished_at")
    .eq("task_type", OUTREACH_TASK_TYPE)
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(200);
  if (error) throw readFailure("hq-outreach: metrics aggregate", error);

  let drafted = 0;
  const provenance = { anthropic: 0, openai: 0, deterministic: 0 };
  let lastCompletedAt: string | null = null;
  for (const row of Array.isArray(data) ? data : []) {
    const s = row.result?.summary;
    if (!s) continue;
    if (s.draftId) drafted += 1;
    const p = s.provenance;
    if (p === "anthropic" || p === "openai" || p === "deterministic") provenance[p] += 1;
    if (!lastCompletedAt && row.finished_at) lastCompletedAt = row.finished_at;
  }

  const recent = await listRecentOutreachRuns(8);

  return {
    total,
    completed,
    inFlight,
    failed,
    drafted,
    provenance,
    lastCompletedAt,
    recent,
  };
}

type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }> & {
  select(columns: string, opts: { count: "exact"; head: true }): CountQuery;
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: ReadonlyArray<unknown>): CountQuery;
};

async function countOutreach(
  admin: AdminClient,
  status?: string | string[],
): Promise<number> {
  let q = (admin.from("hq_ai_tasks" as never) as unknown as CountQuery)
    .select("id", { count: "exact", head: true })
    .eq("task_type", OUTREACH_TASK_TYPE);
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
