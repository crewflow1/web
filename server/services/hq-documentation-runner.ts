import "server-only";

/**
 * CrewFlow HQ — Documentation AI runner (HQ roster completion).
 *
 * Gives the previously-dark `documentation-ai` roster identity REAL deterministic work: a
 * doc-drift scan over the roster + capability catalogue descriptions, run as a Task-Engine
 * task. It owns NO tables — it drains a `documentation_drift` task off the generic Task
 * Engine through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a blank-text scan over ai_employees.role/description and
 *     hq_capabilities.description. NO LLM (no prose is generated).
 *   • It REPORTS, it does not act: it edits no doc.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { listDecisions } from "@/server/services/hq-decisions";
import {
  composeReleaseNotes,
  summariseDocDrift,
  summariseRosterDocCoverage,
  type DocEmployeeRow,
  type DocCatalogueRow,
  type ReleaseActivityRow,
  type ReleaseDecisionRow,
  type ReleaseEventRow,
} from "@/lib/hq/roster-workers";
import { generateDepartmentDraft } from "@/server/services/hq-generative-seams";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

const DOCUMENTATION_AI_SLUG = "documentation-ai";
const DOCUMENTATION_TASK_TYPE = "documentation_drift";
/**
 * The RELEASE NOTES contract (L9a / P10): compose REAL release notes from
 * admin_activity_log + hq_events + hq_decisions in a window, plus the governed
 * dark prose seam `hq.doc_draft` (null until a model tier is bound).
 */
const RELEASE_NOTES_TASK_TYPE = "release_notes_draft";

const EMPLOYEE_WINDOW = 200;
const CATALOGUE_WINDOW = 1000;
/** Release-notes composition window. */
const RELEASE_WINDOW_DAYS = 14;

/**
 * The Bible workforce directory the doc-drift scan reconciles the roster
 * against. Runtime FS READ, house precedent: launch-readiness.ts already reads
 * the filesystem with node:fs in a server service. A serverless bundle that
 * omits docs/ makes readdirSync throw — folded to `null`, which the pure layer
 * reports as an honest "unavailable in this runtime", never full coverage.
 */
const WORKFORCE_DOCS_DIR = "docs/bible/workforce/employees";

function readWorkforceDocFiles(): string[] | null {
  try {
    return readdirSync(resolve(process.cwd(), WORKFORCE_DOCS_DIR)).filter((f) =>
      f.endsWith(".md"),
    );
  } catch {
    return null;
  }
}

async function readSignals(): Promise<{
  employees: DocEmployeeRow[];
  catalogue: DocCatalogueRow[];
}> {
  const admin = createAdminClient();

  const { data: empData, error: empErr } = await admin
    .from("ai_employees" as never)
    .select("slug, role, description")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (empErr) throw new Error(`hq-documentation-runner: employee read failed — ${empErr.message}`);

  const { data: catData, error: catErr } = await admin
    .from("hq_capabilities" as never)
    .select("token, description")
    .order("token", { ascending: true })
    .limit(CATALOGUE_WINDOW);
  if (catErr) throw new Error(`hq-documentation-runner: catalogue read failed — ${catErr.message}`);

  return {
    employees: (empData ?? []) as unknown as DocEmployeeRow[],
    catalogue: (catData ?? []) as unknown as DocCatalogueRow[],
  };
}

/**
 * documentation_drift, EXTENDED (L9a / P10) beyond the blank-fields scan: the
 * result now also carries `rosterDocCoverage` — the ai_employees roster
 * cross-checked against the Bible workforce file list (its own mini-envelope,
 * honest-insufficient when the runtime cannot read the directory). The original
 * envelope shape is preserved; the coverage rides as an additional field.
 */
const documentationHandler: TaskHandler = async () => {
  const now = new Date();
  const { employees, catalogue } = await readSignals();
  const drift = summariseDocDrift(employees, catalogue, now);
  const rosterDocCoverage = summariseRosterDocCoverage(
    employees.map((e) => ({ slug: e.slug })),
    readWorkforceDocFiles(),
    now,
  );
  return { ...drift, rosterDocCoverage };
};

// ---------------------------------------------------------------------
// release_notes_draft — reads over the three real ledgers. The two append-only
// ledgers are F-1 PAGED (fetchAllRows over a gte window) so the composed
// grouped counts are COMPLETE for the window, never silently truncated at the
// PostgREST clamp. Decisions are read ONLY through the sanctioned decision
// service (hq-decisions.ts owns every .from on its tables) and window-filtered
// here — decisions are human-authored and human-scale.
// ---------------------------------------------------------------------

async function readReleaseWindow(now: Date): Promise<{
  activity: ReleaseActivityRow[];
  events: ReleaseEventRow[];
  decisions: ReleaseDecisionRow[];
}> {
  const admin = createAdminClient();
  const since = new Date(now.getTime() - RELEASE_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: actData, error: actErr } = await fetchAllRows<ReleaseActivityRow>(
    (from, to) =>
      admin
        .from("admin_activity_log" as never)
        .select("action, target_table, created_at" as never)
        .gte("created_at" as never, since)
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<ReleaseActivityRow>>,
  );
  if (actErr) throw readFailure("hq-documentation-runner: activity window", actErr);

  const { data: evtData, error: evtErr } = await fetchAllRows<ReleaseEventRow>(
    (from, to) =>
      admin
        .from("hq_events" as never)
        .select("verb, object_type, severity, ts" as never)
        .gte("ts" as never, since)
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<ReleaseEventRow>>,
  );
  if (evtErr) throw readFailure("hq-documentation-runner: events window", evtErr);

  const decisionRows = await listDecisions({ limit: 200 });
  const decisions: ReleaseDecisionRow[] = decisionRows
    .filter((d) => d.created_at >= since)
    .map((d) => ({ title: d.title, status: d.status, created_at: d.created_at }));

  return {
    activity: (actData ?? []) as ReleaseActivityRow[],
    events: (evtData ?? []) as ReleaseEventRow[],
    decisions,
  };
}

/**
 * The release_notes_draft handler: deterministic composition first, then the
 * GOVERNED DARK prose seam (`hq.doc_draft`, via the shared department-seam
 * module — this runner opens no model door itself). While the tier is dark
 * (always, today) the seam returns null and the artifact's generativeNote says
 * so; the composed sections stand alone.
 */
const releaseNotesHandler: TaskHandler = async (ctx) => {
  const now = new Date();
  const { activity, events, decisions } = await readReleaseWindow(now);
  const notes = composeReleaseNotes(activity, events, decisions, RELEASE_WINDOW_DAYS, now);
  const generativeProse = notes.insufficient
    ? null
    : await generateDepartmentDraft("hq.doc_draft", notes, { aiEmployeeId: ctx.identity.employeeId });
  if (generativeProse != null) {
    return {
      ...notes,
      generativeProse,
      generativeNote:
        "Prose generated through the governed hq.doc_draft seam — an unreviewed draft grounded in the composed sections above; a human reviews and owns anything published.",
    };
  }
  return notes;
};

export async function enqueueDocumentationDrift(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DOCUMENTATION_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DOCUMENTATION_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-documentation-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDocumentationTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(DOCUMENTATION_TASK_TYPE, identity, documentationHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(DOCUMENTATION_TASK_TYPE, documentationHandler, identity),
  );
}

export async function drainDocumentationTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(DOCUMENTATION_TASK_TYPE, identity, documentationHandler);
  const summary = await drainTaskType(DOCUMENTATION_TASK_TYPE, documentationHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

// ---------------------------------------------------------------------
// release_notes_draft — the L9a / P10 contract on the same canonical surface.
// ---------------------------------------------------------------------

export async function enqueueReleaseNotes(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: RELEASE_NOTES_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${RELEASE_NOTES_TASK_TYPE}:${day}`,
    origin: "manual",
  });
  if (!enq.ok) {
    console.error("[hq-documentation-runner] release-notes enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runReleaseNotesTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(RELEASE_NOTES_TASK_TYPE, identity, releaseNotesHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(RELEASE_NOTES_TASK_TYPE, releaseNotesHandler, identity),
  );
}

export async function drainReleaseNotesTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(RELEASE_NOTES_TASK_TYPE, identity, releaseNotesHandler);
  const summary = await drainTaskType(RELEASE_NOTES_TASK_TYPE, releaseNotesHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

// ---------------------------------------------------------------------
// Read side — the /admin/documentation-ai page (board + recent artifacts).
// Bounded SELECT-only reads; writes reach the queue only via enqueueTask.
// ---------------------------------------------------------------------

export type DocumentationRunRow = {
  taskId: string;
  taskType: string;
  status: string;
  summary: string | null;
  severity: string | null;
  insufficient: boolean | null;
  createdAt: string | null;
  finishedAt: string | null;
};

type QueueRow = {
  id: string;
  task_type: string;
  status: string;
  result: Record<string, unknown> | null;
  created_at: string | null;
  finished_at: string | null;
};

type QueueRead = {
  select(columns: string): QueueRead;
  in(column: string, values: ReadonlyArray<unknown>): QueueRead;
  order(column: string, options?: { ascending?: boolean }): QueueRead;
  limit(count: number): PromiseLike<{ data: QueueRow[] | null; error: { message: string } | null }>;
};

export type DocumentationAiOverview = {
  latestDrift: Record<string, unknown> | null;
  latestReleaseNotes: Record<string, unknown> | null;
  recent: DocumentationRunRow[];
};

/** Latest completed artifact per task type + the recent run list, newest first. */
export async function getDocumentationAiOverview(limit = 12): Promise<DocumentationAiOverview> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await (admin.from("hq_ai_tasks" as never) as unknown as QueueRead)
    .select("id, task_type, status, result, created_at, finished_at")
    .in("task_type", [DOCUMENTATION_TASK_TYPE, RELEASE_NOTES_TASK_TYPE])
    .order("created_at", { ascending: false })
    .limit(capped);
  if (error) throw new Error(`hq-documentation-runner: overview read failed — ${error.message}`);
  const rows = (data ?? []) as QueueRow[];
  const latestOf = (type: string) =>
    rows.find((r) => r.task_type === type && r.status === "completed" && r.result != null)
      ?.result ?? null;
  return {
    latestDrift: latestOf(DOCUMENTATION_TASK_TYPE),
    latestReleaseNotes: latestOf(RELEASE_NOTES_TASK_TYPE),
    recent: rows.map((r) => {
      const result = r.result ?? null;
      return {
        taskId: r.id,
        taskType: r.task_type,
        status: r.status,
        summary: typeof result?.summary === "string" ? (result.summary as string) : null,
        severity: typeof result?.severity === "string" ? (result.severity as string) : null,
        insufficient:
          typeof result?.insufficient === "boolean" ? (result.insufficient as boolean) : null,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      };
    }),
  };
}

export {
  DOCUMENTATION_AI_SLUG,
  DOCUMENTATION_TASK_TYPE,
  RELEASE_NOTES_TASK_TYPE,
  releaseNotesHandler,
  readWorkforceDocFiles,
};
