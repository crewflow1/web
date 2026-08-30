import "server-only";

/**
 * CrewFlow HQ — CTO AI PR-review runner (L9a / P7).
 *
 * Gives the CTO AI its roadmap "review PRs" contract as a Task-Engine task: a
 * `cto_pr_review` task fetches one pull request's unified diff through the DARK
 * GitHub adapter and completes with the deterministic review checklist
 * (`computePrReviewChecklist`, lib/hq/cto.ts). It owns NO tables — the canonical
 * runner SDK (server/sdk/tasks.ts) drives the lifecycle, exactly like every
 * other employee (the Reference Employee Rule).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — the review is pure string analysis of the fetched diff.
 *     NO LLM anywhere in this runner.
 *   • DARK UNTIL A TOKEN EXISTS — with no GITHUB_TOKEN/GITHUB_REPO the adapter
 *     refuses before fetch, and the task COMPLETES with an honest
 *     not-configured envelope (insufficient, confidence 0). Dark is a
 *     completion, not a failure — exactly as the Draft Engine's dark path
 *     completes with a deterministic draft.
 *   • It REVIEWS, it does not act: merge/deploy are irreversible and exist only
 *     as approval-gated executor-tool METADATA (lib/hq/cto-tools.ts), dormant
 *     behind the dark executor gates. Nothing here can merge.
 *   • Reads are adapter GETs only; the only queue write is the sanctioned
 *     enqueue (enqueueTask).
 */

import { GithubAdapter } from "@/lib/integrations/github/adapter";
import { computePrReviewChecklist, type PrReviewChecklistResult } from "@/lib/hq/cto";
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
  NonRetryableError,
  type DrainSummary,
  type RunContext,
  type TaskHandler,
} from "@/server/sdk/tasks";

const CTO_AI_SLUG = "cto-ai";
const CTO_REVIEW_TASK_TYPE = "cto_pr_review";

/** Pull a field off the task's write-once payload, or null. */
function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function payloadNumber(payload: Record<string, unknown> | null, key: string): number | null {
  const v = payload?.[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * The honest DARK completion: the adapter is not configured, so no diff was
 * fetched and no review is fabricated. Insufficient by construction —
 * activation (GITHUB_TOKEN + GITHUB_REPO) is the only switch.
 */
function notConfiguredEnvelope(prNumber: number | null, now: Date): PrReviewChecklistResult {
  return {
    kind: "cto_pr_review",
    summary:
      "Insufficient data — the GitHub adapter is not configured, so no diff was fetched and no review is fabricated.",
    reasoning:
      "PR review needs a fetched diff, and the GitHub adapter refuses before fetch while GITHUB_TOKEN + GITHUB_REPO are absent (which they are). This run completes honestly dark: setting those credentials is the only activation switch, and no code change is needed here.",
    confidence: 0,
    insufficient: true,
    generatedAt: now.toISOString(),
    sources: ["github:pull_request_diff (dark — not configured)"],
    severity: "ok",
    approvalRequired: true,
    signals: {
      prNumber: prNumber ?? 0,
      title: null,
      author: null,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      migrationsTouched: [],
      credentialShapedAdditions: [],
      testFilesTouched: 0,
      dependencyManifestTouched: false,
      todoAdditions: 0,
    },
    checklist: [],
  };
}

const ctoReviewHandler: TaskHandler = async (ctx: RunContext) => {
  const prNumber = payloadNumber(ctx.task.payload, "pr_number");
  const adapter = new GithubAdapter();

  // DARK PATH — a completion, not a failure. No network is touched.
  if (!adapter.isAvailable()) {
    return notConfiguredEnvelope(prNumber, new Date());
  }

  if (prNumber == null) {
    // A retry cannot conjure a PR number into a write-once payload.
    throw new NonRetryableError("cto_pr_review task has no pr_number in its payload.");
  }

  const diff = await adapter.fetchPullRequestDiff(prNumber);
  if (!diff.ok) {
    if (diff.reason === "not_configured") return notConfiguredEnvelope(prNumber, new Date());
    // unauthorized / transient errors are retryable — the engine re-queues.
    throw new Error(`cto_pr_review: diff fetch failed — ${diff.message}`);
  }

  return computePrReviewChecklist(
    {
      prNumber,
      title: payloadString(ctx.task.payload, "pr_title"),
      author: payloadString(ctx.task.payload, "pr_author"),
      diff: diff.data,
    },
    new Date(),
  );
};

export async function enqueuePrReview(
  prNumber: number,
  meta: { title?: string | null; author?: string | null } = {},
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(CTO_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const payload: Record<string, unknown> = { pr_number: prNumber };
  if (meta.title) payload.pr_title = meta.title;
  if (meta.author) payload.pr_author = meta.author;
  const enq = await enqueueTask({
    taskType: CTO_REVIEW_TASK_TYPE,
    priority: "normal",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${CTO_REVIEW_TASK_TYPE}:${prNumber}`,
    payload,
    origin: "manual",
  });
  if (!enq.ok) {
    console.error("[hq-cto-review-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runPrReviewTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(CTO_AI_SLUG);
  registerTaskHandler(CTO_REVIEW_TASK_TYPE, identity, ctoReviewHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(CTO_REVIEW_TASK_TYPE, ctoReviewHandler, identity),
  );
}

export async function drainPrReviewTasks(limit = 2): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(CTO_AI_SLUG);
  registerTaskHandler(CTO_REVIEW_TASK_TYPE, identity, ctoReviewHandler);
  const summary = await drainTaskType(CTO_REVIEW_TASK_TYPE, ctoReviewHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { CTO_AI_SLUG, CTO_REVIEW_TASK_TYPE, ctoReviewHandler };
