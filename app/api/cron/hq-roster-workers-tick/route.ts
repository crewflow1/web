import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { enqueueSecurityPosture, drainSecurityTasks } from "@/server/services/hq-security-runner";
import { enqueueDevopsHealth, drainDevopsTasks } from "@/server/services/hq-devops-runner";
import {
  enqueueDatabaseIntegrity,
  drainDatabaseTasks,
} from "@/server/services/hq-database-runner";
import { enqueueApiContract, drainApiTasks } from "@/server/services/hq-api-runner";
import {
  enqueueDocumentationDrift,
  drainDocumentationTasks,
  enqueueReleaseNotes,
  drainReleaseNotesTasks,
} from "@/server/services/hq-documentation-runner";
import {
  enqueueOnboardingNudges,
  drainOnboardingTasks,
} from "@/server/services/hq-onboarding-runner";
import { enqueueWorkforceReview, drainWorkforceTasks } from "@/server/services/hq-hr-runner";
import {
  enqueueComplianceReview,
  drainComplianceTasks,
} from "@/server/services/hq-legal-compliance-runner";
import {
  enqueueDesignConsistency,
  drainDesignTasks,
  enqueueDesignReview,
  drainDesignReviewTasks,
} from "@/server/services/hq-design-runner";
import {
  enqueueContentBrief,
  drainContentBriefTasks,
} from "@/server/services/hq-marketing-content-runner";
import {
  enqueueQaCiSnapshot,
  drainQaCiSnapshotTasks,
} from "@/server/services/hq-qa-ci-runner";
import {
  enqueueLeadSourcing,
  drainLeadSourcingTasks,
} from "@/server/services/hq-lead-sourcing-runner";
import {
  enqueueOrchestrationRouting,
  drainOrchestrationTasks,
} from "@/server/services/hq-orchestrator-runner";
import {
  enqueueWorkflowSequencing,
  drainWorkflowTasks,
} from "@/server/services/hq-workflow-runner";
import {
  enqueueMemoryCuration,
  drainMemoryCurationTasks,
} from "@/server/services/hq-memory-manager-runner";

/**
 * CrewFlow HQ — Roster-worker runners tick (HQ roster completion).
 *
 *   GET /api/cron/hq-roster-workers-tick
 *
 * Drives the roster-employee engine legs (twelve workers + the three cadence-shaped department contracts: content brief, design review, release notes) (security, devops, database, api,
 * documentation, onboarding, hr, legal-compliance, design, orchestrator, workflow,
 * memory-manager) on the generic Task Engine. Each tick ENQUEUES one fresh task per worker
 * (deduped per DAY, so a re-tick never piles up a backlog) and then DRAINS the ready tasks
 * through the canonical runner SDK — so each worker's Boardroom card populates from a real
 * `hq_ai_tasks` result rather than reading "insufficient".
 *
 * Every runner is DETERMINISTIC and side-effect-free: it folds the role's own deterministic
 * read into an explainable, sourced result (approvalRequired: true) and completes a task
 * with it. Nothing here sends, commits, decides, or mutates — humans keep final approval;
 * generative (model) enrichment stays dark.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise. Best-effort: a single
 * worker's failure is captured in its section of the summary rather than failing the tick.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Enqueue + a bounded claim-one drain across 15 worker legs back to back.
export const maxDuration = 60;

const WORKERS: ReadonlyArray<{
  label: string;
  enqueue: (now: Date) => Promise<unknown>;
  drain: (limit?: number) => Promise<unknown>;
}> = [
  { label: "security", enqueue: enqueueSecurityPosture, drain: drainSecurityTasks },
  { label: "devops", enqueue: enqueueDevopsHealth, drain: drainDevopsTasks },
  { label: "database", enqueue: enqueueDatabaseIntegrity, drain: drainDatabaseTasks },
  { label: "api", enqueue: enqueueApiContract, drain: drainApiTasks },
  { label: "documentation", enqueue: enqueueDocumentationDrift, drain: drainDocumentationTasks },
  { label: "onboarding", enqueue: enqueueOnboardingNudges, drain: drainOnboardingTasks },
  { label: "hr", enqueue: enqueueWorkforceReview, drain: drainWorkforceTasks },
  { label: "legal_compliance", enqueue: enqueueComplianceReview, drain: drainComplianceTasks },
  { label: "design", enqueue: enqueueDesignConsistency, drain: drainDesignTasks },
  { label: "orchestrator", enqueue: enqueueOrchestrationRouting, drain: drainOrchestrationTasks },
  { label: "workflow", enqueue: enqueueWorkflowSequencing, drain: drainWorkflowTasks },
  {
    label: "memory_manager",
    enqueue: enqueueMemoryCuration,
    drain: drainMemoryCurationTasks,
  },
  // L9a department contracts — the CADENCE-SHAPED engine legs (each dedupes
  // per day / ISO week in its own enqueue, so a re-tick never piles up a
  // backlog). Without these entries the legs were dead code: their handlers
  // registered only inside never-imported functions, so no content_brief,
  // design_review or release_notes_draft task could ever exist in production
  // (the exact zero-production-callers pattern the reconciliation condemned).
  // cto_pr_review is EVENT-shaped (needs a PR number) and is reachable via the
  // /admin/cto-ai queue action instead, mirroring the P13 support seam.
  { label: "marketing_content", enqueue: enqueueContentBrief, drain: drainContentBriefTasks },
  { label: "design_review", enqueue: enqueueDesignReview, drain: drainDesignReviewTasks },
  { label: "release_notes", enqueue: enqueueReleaseNotes, drain: drainReleaseNotesTasks },
  // QA CI-signal leg (R092): per-day snapshot task; DARK-honest — with no
  // GitHub credential the adapter refuses before fetch and the task completes
  // with the stated dark reason, never a fabricated pass rate.
  { label: "qa_ci", enqueue: enqueueQaCiSnapshot, drain: drainQaCiSnapshotTasks },
  // Sales lead-sourcing leg (R088): weekly-deduped task; DARK-honest — with no
  // Companies House key the handler completes { sourced: 0, dark: true } before
  // any fetch. Armed, it inserts DRAFT prospects only through the sanctioned
  // createCompany door.
  { label: "lead_sourcing", enqueue: enqueueLeadSourcing, drain: drainLeadSourcingTasks },
];

async function safe<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[hq-roster-workers-tick] ${label} failed`, error);
    return { ok: false, error };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("hq-roster-workers-tick", async () => {
    const now = new Date();
    const workers: Record<string, unknown> = {};
    for (const worker of WORKERS) {
      workers[worker.label] = await safe(worker.label, async () => {
        // Claim-one per worker per tick — bounded pass across all 12 (limit 1 each).
        const enqueued = await worker.enqueue(now);
        const drained = await worker.drain(1);
        return { enqueued, drained };
      });
    }
    return { ok: true, workers };
  });

  return NextResponse.json(payload, { status });
}
