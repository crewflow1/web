import "server-only";

/**
 * CrewFlow HQ — Marketing AI content runner (L9a / P6).
 *
 * Gives the Marketing AI its roadmap CONTENT contract as a Task-Engine task: a
 * `marketing_content_draft` task completes with the deterministic WEEKLY
 * CONTENT BRIEF (`computeContentBrief`, lib/hq/marketing.ts) derived from two
 * REAL sources — CrewFlow's own demo-request capture (the recorded
 * form-origin split) and the live SEO page inventory (lib/seo/content, the
 * registry every marketing page is generated from). It owns NO tables — the
 * canonical runner SDK drives the lifecycle (the Reference Employee Rule).
 *
 * Honesty + safety:
 *   • The BRIEF is DETERMINISTIC — every proposal cites the real figure it is
 *     derived from, and an empty estate yields an honest insufficient brief,
 *     never invented "content ideas".
 *   • The COPY is a GOVERNED DARK SEAM — `hq.marketing_draft` via the shared
 *     department seam (server/services/hq-generative-seams.ts →
 *     invokeWithGovernor). With no model tier bound it returns null and the
 *     artifact's generativeNote says so; the dark path is a COMPLETION.
 *   • NO PII: the demo-request read selects status, source, created_at only —
 *     the same lean columns the Marketing board reads, and no lead name/email/
 *     phone ever enters the artifact (or, when armed, a prompt).
 *   • It PROPOSES, it does not publish: nothing here writes content anywhere.
 *     A human reviews the brief; the SEO registry is only ever extended by a
 *     reviewed code change.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { CONTENT_COUNTS } from "@/lib/seo/content";
import {
  computeContentBrief,
  type ContentBriefInput,
  type ContentBriefResult,
} from "@/lib/hq/marketing";
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

const MARKETING_AI_SLUG = "marketing-ai";
const MARKETING_CONTENT_TASK_TYPE = "marketing_content_draft";

type DemoRow = { status: string; source: string | null; created_at: string };

/**
 * Read the lean demo-request rows (status/source/created_at — NO PII), paged
 * estate-wide exactly like the Marketing board's reader. Null on failure (loud)
 * so the brief marks the lead-origin leg unreadable instead of inventing one.
 */
async function readLeanDemoRows(): Promise<ContentBriefInput["leads"]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await fetchAllRows<DemoRow>(
      (from, to) =>
        admin
          .from("demo_requests")
          .select("status, source, created_at" as never)
          .order("id" as never, { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<DemoRow>>,
    );
    if (error) throw readFailure("hq marketing content: demo requests", error);
    const rows = (data ?? []) as unknown as DemoRow[];
    return {
      demoRequests: rows.map((r) => ({
        status: r.status,
        source: r.source ?? "unspecified",
        created_at: r.created_at,
      })),
    };
  } catch (e) {
    console.error("[hq-marketing-content-runner] demo-request read failed", e);
    return null;
  }
}

/** The live SEO inventory — exact counts from the static content registry. */
function seoInventory(): ContentBriefInput["seoInventory"] {
  return {
    features: CONTENT_COUNTS.features,
    comparisons: CONTENT_COUNTS.comparisons,
    industries: CONTENT_COUNTS.industries,
    locations: CONTENT_COUNTS.locations,
    posts: CONTENT_COUNTS.posts,
    tools: CONTENT_COUNTS.tools,
  };
}

const marketingContentHandler: TaskHandler = async () => {
  const leads = await readLeanDemoRows();
  const brief: ContentBriefResult = computeContentBrief(
    { leads, seoInventory: seoInventory() },
    new Date(),
  );

  // The governed generative leg — null while dark (which is always, today).
  // A refusal or dark tier changes NOTHING about the deterministic brief.
  const generativeDraft = brief.insufficient
    ? null
    : await generateDepartmentDraft("hq.marketing_draft", brief);
  if (generativeDraft != null) {
    return {
      ...brief,
      generativeDraft,
      generativeNote:
        "Draft copy generated through the governed hq.marketing_draft seam — an unreviewed draft grounded in the brief above; a human reviews, edits, and owns anything published.",
    };
  }
  return brief;
};

export async function enqueueContentBrief(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(MARKETING_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  // One brief per ISO week — the artifact is a WEEKLY brief by contract.
  const week = computeContentBrief({ leads: null, seoInventory: null }, now).weekOf;
  const enq = await enqueueTask({
    taskType: MARKETING_CONTENT_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${MARKETING_CONTENT_TASK_TYPE}:${week}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-marketing-content-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runContentBriefTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(MARKETING_AI_SLUG);
  registerTaskHandler(MARKETING_CONTENT_TASK_TYPE, identity, marketingContentHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(MARKETING_CONTENT_TASK_TYPE, marketingContentHandler, identity),
  );
}

export async function drainContentBriefTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(MARKETING_AI_SLUG);
  registerTaskHandler(MARKETING_CONTENT_TASK_TYPE, identity, marketingContentHandler);
  const summary = await drainTaskType(
    MARKETING_CONTENT_TASK_TYPE,
    marketingContentHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { MARKETING_AI_SLUG, MARKETING_CONTENT_TASK_TYPE, marketingContentHandler };
