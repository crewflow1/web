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
import { enqueueDesignConsistency, drainDesignTasks } from "@/server/services/hq-design-runner";
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
 * Drives the twelve previously-dark roster employees (security, devops, database, api,
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
// Enqueue + a bounded claim-one drain across 12 workers back to back.
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
