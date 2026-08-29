import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import {
  enqueueCeoReview,
  drainCeoReviewTasks,
} from "@/server/services/hq-ceo-exec-runner";
import {
  enqueueCtoReview,
  drainCtoReviewTasks,
} from "@/server/services/hq-cto-exec-runner";
import {
  enqueueCfoReview,
  drainCfoReviewTasks,
} from "@/server/services/hq-cfo-exec-runner";
import {
  enqueueCooReview,
  drainCooReviewTasks,
} from "@/server/services/hq-coo-exec-runner";
import {
  enqueueSalesReview,
  drainSalesReviewTasks,
} from "@/server/services/hq-sales-exec-runner";
import {
  enqueueMarketingReview,
  drainMarketingReviewTasks,
} from "@/server/services/hq-marketing-exec-runner";
import {
  enqueueProductReview,
  drainProductReviewTasks,
} from "@/server/services/hq-product-exec-runner";
import {
  enqueueProductProposalSweep,
  drainProductProposalTasks,
} from "@/server/services/hq-product";
import {
  enqueueQaReview,
  drainQaReviewTasks,
} from "@/server/services/hq-qa-exec-runner";
import {
  enqueueFinanceReview,
  drainFinanceReviewTasks,
} from "@/server/services/hq-finance-exec-runner";
import {
  enqueueOperationsReview,
  drainOperationsReviewTasks,
} from "@/server/services/hq-operations-exec-runner";
import {
  enqueueSupportReview,
  drainSupportReviewTasks,
} from "@/server/services/hq-support-exec-runner";
import {
  enqueueCustomerSuccessReview,
  drainCustomerSuccessReviewTasks,
} from "@/server/services/hq-customer-success-exec-runner";
import {
  enqueueExecAssistantReview,
  drainExecAssistantReviewTasks,
} from "@/server/services/hq-executive-assistant-exec-runner";

/**
 * CrewFlow HQ — Executive runners tick (exec execution path).
 *
 *   GET /api/cron/hq-exec-tick
 *
 * Drives the 13 EXECUTIVE employees (CEO, CTO, CFO, COO, Sales, Marketing, Product, QA,
 * Finance, Operations, Support, Customer Success, Executive Assistant) on the generic
 * Task Engine. Each tick ENQUEUES one fresh `{role}_review` task per exec (deduped per
 * day, so a re-tick never piles up a backlog) and then DRAINS the ready tasks through
 * the canonical runner SDK — so each exec's Boardroom card populates from a real
 * `hq_ai_tasks` result rather than only a static board.
 *
 * Every runner is DETERMINISTIC and side-effect-free: it folds the employee's own
 * deterministic board into an explainable, sourced review (requiresHumanApproval: true,
 * autonomousApply: false) and completes a task with it. Nothing here sends, commits,
 * decides, or mutates — humans keep final approval; generative output stays dark.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise. Best-effort: a single
 * exec's failure is captured in its section of the summary rather than failing the tick.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Enqueue + a bounded claim-one drain across 13 execs back to back.
export const maxDuration = 60;

const EXECS: ReadonlyArray<{
  label: string;
  enqueue: (now: Date) => Promise<unknown>;
  drain: (limit?: number) => Promise<unknown>;
}> = [
  { label: "ceo", enqueue: enqueueCeoReview, drain: drainCeoReviewTasks },
  { label: "cto", enqueue: enqueueCtoReview, drain: drainCtoReviewTasks },
  { label: "cfo", enqueue: enqueueCfoReview, drain: drainCfoReviewTasks },
  { label: "coo", enqueue: enqueueCooReview, drain: drainCooReviewTasks },
  { label: "sales", enqueue: enqueueSalesReview, drain: drainSalesReviewTasks },
  { label: "marketing", enqueue: enqueueMarketingReview, drain: drainMarketingReviewTasks },
  { label: "product", enqueue: enqueueProductReview, drain: drainProductReviewTasks },
  // P11 — Product AI's demand→proposal sweep: converts the board's top demand
  // themes into DRAFT Decision-Centre proposals (openDeterministicProposal;
  // idempotent per theme via source_signal_key). Deterministic, never decides.
  {
    label: "product_proposal",
    enqueue: enqueueProductProposalSweep,
    drain: drainProductProposalTasks,
  },
  { label: "qa", enqueue: enqueueQaReview, drain: drainQaReviewTasks },
  { label: "finance", enqueue: enqueueFinanceReview, drain: drainFinanceReviewTasks },
  { label: "operations", enqueue: enqueueOperationsReview, drain: drainOperationsReviewTasks },
  { label: "support", enqueue: enqueueSupportReview, drain: drainSupportReviewTasks },
  {
    label: "customer_success",
    enqueue: enqueueCustomerSuccessReview,
    drain: drainCustomerSuccessReviewTasks,
  },
  {
    label: "exec_assistant",
    enqueue: enqueueExecAssistantReview,
    drain: drainExecAssistantReviewTasks,
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
    console.error(`[hq-exec-tick] ${label} failed`, error);
    return { ok: false, error };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("hq-exec-tick", async () => {
    const now = new Date();
    const execs: Record<string, unknown> = {};
    for (const exec of EXECS) {
      execs[exec.label] = await safe(exec.label, async () => {
        // Claim-one per exec per tick — bounded pass across all 13 (limit 1 each).
        const enqueued = await exec.enqueue(now);
        const drained = await exec.drain(1);
        return { enqueued, drained };
      });
    }
    return { ok: true, execs };
  });

  return NextResponse.json(payload, { status });
}
