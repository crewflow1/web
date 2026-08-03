import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildLaunchReadiness } from "@/server/services/launch-readiness";
import { getExecutorShadowFeed } from "@/server/services/executor-shadow-observations";
import { buildAiCostSnapshot } from "@/server/services/ai-cost-snapshot";
import { listHealthDeepDive } from "@/server/services/hq-health-deep-dive";
import { bandFromScore } from "@/lib/hq/health-deep-dive";
import type { BoardroomTask } from "@/lib/hq/boardroom-cards";
import {
  computeCtoBoard,
  type CtoBoard,
  type CtoInput,
} from "@/lib/hq/cto";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

/**
 * CrewFlow HQ — CTO AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-finance.ts` and
 * `server/services/hq-support-ai.ts`: it gathers the raw engineering-health
 * signals from the EXISTING read models and hands a plain `CtoInput` to the
 * pure, deterministic `computeCtoBoard` (lib/hq/cto.ts). All honesty/labelling
 * lives in the pure layer — this module never duplicates health logic; it reads
 * launch readiness, the `hq_ai_tasks` queue, the executor-shadow store, the
 * AI-cost snapshot, and the customer-health deep dive, then folds each to the
 * lean shape the pure layer consumes.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The genuinely
 * absent sources (CI runs, deploy history, uptime telemetry) have NO reader here
 * at all — the pure layer emits them insufficient by construction.
 */

export type CtoBoardResult = {
  board: CtoBoard;
  /**
   * The governed technical narrative — a short prose blurb over the deterministic
   * engineering-health figures, generated via the shared HQ narrative helper.
   * `null` until a model tier is bound (and the vendor credential + HQ budget org
   * are present), on any governor refusal, or on a provider failure. The UI shows
   * an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/** A lean window of recent tasks — enough to keep reliability live, cheap to read. */
const TASK_WINDOW = 5000;
const RELIABILITY_COLUMNS = [
  "status",
  "verification",
  "result",
  "deadline_at",
  "lease_expires_at",
  "heartbeat_at",
  "retry_count",
  "max_retries",
  "pipeline_stage",
].join(", ");

/**
 * Read the recent `hq_ai_tasks` window for the reliability signal. Service-role
 * read only — mirrors `hq-task-pipeline.ts`, which the task-engine-spine security
 * test forbids from writing. Returns `null` on a read failure (loud) so the pure
 * layer marks reliability insufficient.
 */
async function readReliabilityTasks(): Promise<ReadonlyArray<BoardroomTask> | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("hq_ai_tasks" as never)
      .select(RELIABILITY_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(TASK_WINDOW);
    if (error) {
      console.error("[hq-cto] reliability read failed", error);
      return null;
    }
    return (data ?? []) as unknown as BoardroomTask[];
  } catch (e) {
    console.error("[hq-cto] reliability read threw", e);
    return null;
  }
}

/**
 * Assemble the deterministic CTO engineering-health board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadCtoBoard(): Promise<CtoBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [launch, tasks, shadow, aiCost, health] = await Promise.all([
    buildLaunchReadiness().catch((e) => {
      console.error("[hq-cto] launch-readiness read failed", e);
      return null;
    }),
    readReliabilityTasks(),
    getExecutorShadowFeed().catch((e) => {
      console.error("[hq-cto] executor-shadow read failed", e);
      return null;
    }),
    buildAiCostSnapshot().catch((e) => {
      console.error("[hq-cto] ai-cost snapshot read failed", e);
      return null;
    }),
    listHealthDeepDive().catch((e) => {
      console.error("[hq-cto] customer-health read failed", e);
      return null;
    }),
  ]);

  const input: CtoInput = {
    launch:
      launch == null
        ? null
        : {
            overall: launch.overall,
            redLabels: launch.rows.filter((r) => r.status === "red").map((r) => r.label),
            amberLabels: launch.rows.filter((r) => r.status === "amber").map((r) => r.label),
            greenCount: launch.rows.filter((r) => r.status === "green").length,
          },
    reliability: tasks == null ? null : { tasks },
    shadow:
      shadow == null
        ? null
        : {
            planned: shadow.totals.planned,
            refused: shadow.totals.refused,
            error: shadow.totals.error,
          },
    aiCost:
      aiCost == null
        ? null
        : {
            committedPence: aiCost.totalPence,
            reservedPence: aiCost.totalReservedPence,
            blockedOrgs: aiCost.blockedOrgs.length,
            overruns: aiCost.totalOverruns,
            ceilingPence: aiCost.ceilingPence,
            governorActivated: aiCost.readiness.activated,
          },
    health:
      health == null
        ? null
        : {
            totalOrgs: health.length,
            unscored: health.filter((r) => r.health_score == null).length,
            critical: health.filter((r) => bandFromScore(r.health_score) === "red").length,
            atRisk: health.filter((r) => bandFromScore(r.health_score) === "yellow").length,
          },
  };

  const board = computeCtoBoard(input, new Date());
  const narrative = await loadCtoNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Technical narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ
 * narrative helper (server/services/hq-narrative.ts), which reaches a model ONLY
 * through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.cto_narrative` feature key (task class `drafting`), billed to the HQ budget
 * org. The model is handed the FINISHED deterministic board and may only describe
 * it — every displayed figure still comes from `computeCtoBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadCtoNarrative(board: CtoBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.cto_narrative", board);
}
