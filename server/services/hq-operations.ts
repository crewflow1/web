import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { buildOpsSnapshot } from "@/server/services/ops-snapshot";
import { buildAlertsSnapshot } from "@/server/services/hq-alerts-snapshot";
import { getTaskQueueOverview } from "@/server/services/hq-task-queue";
import { runAlertRules, applyStateToAlerts } from "@/lib/hq/alert-rules";
import {
  computeOperationsBoard,
  type OperationsBoard,
  type OperationsInput,
} from "@/lib/hq/operations";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

/**
 * CrewFlow HQ — Operations AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-cto.ts` and
 * `server/services/hq-support-ai.ts`: it gathers the raw operations-health signals
 * from the EXISTING HQ read models and hands a plain `OperationsInput` to the pure,
 * deterministic `computeOperationsBoard` (lib/hq/operations.ts). All
 * honesty/labelling lives in the pure layer — this module never duplicates
 * health logic; it reads the /admin/ops system snapshot (cron telemetry, email
 * queue, required-env presence), the HQ alerts rules engine (open alerts by
 * severity), and the generic AI task-queue overview, then folds each to the lean
 * shape the pure layer consumes.
 *
 * WHY NOT server/services/operations-snapshot.ts? That estate command centre is
 * TENANT-SCOPED — it reads ONE org through that org's RLS client, org-pinned. It
 * has no cross-tenant HQ rollup, and blending per-tenant figures on this
 * super-admin surface would leak across tenants (the #456 class). The pure layer
 * emits the platform-wide operational-throughput figure as honest `insufficient`
 * for exactly that reason, so this aggregator does not (and must not) read it.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The
 * genuinely absent sources (SLA telemetry, cross-tenant throughput) have NO
 * reader here at all — the pure layer emits them insufficient by construction.
 */

export type OperationsBoardResult = {
  board: OperationsBoard;
  /**
   * The governed operations narrative — a short prose blurb over the deterministic
   * operations-health figures, generated via the shared HQ narrative helper.
   * `null` until a model tier is bound (and the vendor credential + HQ budget org
   * are present), on any governor refusal, or on a provider failure. The UI shows
   * an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Read the /admin/ops system snapshot and fold it to the pure layer's system
 * shape. Returns `null` on failure (loud) so the pure layer marks system health
 * insufficient rather than fabricating a green board.
 */
async function readSystem(): Promise<OperationsInput["system"]> {
  try {
    const ops = await buildOpsSnapshot();
    return {
      status: ops.status,
      summary: ops.summary,
      missingRequiredEnv: ops.env.filter((e) => e.required && !e.present).map((e) => e.name),
      cronFailures7d: ops.crons.reduce((acc, c) => acc + c.failures_7d, 0),
      cronRoutesFailing: ops.crons.filter((c) => c.failures_7d > 0 && c.runs_7d > 0).length,
      cronRoutesStale: ops.crons.filter((c) => c.runs_7d === 0).length,
      cronRoutesTotal: ops.crons.length,
      emailQueued: ops.email.queued,
      emailPermanentFailures: ops.email.permanent_failures,
    };
  } catch (e) {
    console.error("[hq-operations] system snapshot read failed", e);
    return null;
  }
}

/**
 * Run the deterministic HQ alerts rules engine and reduce to the lean list the
 * board buckets. Applies alert lifecycle state so RESOLVED and SNOOZED alerts are
 * excluded — the board counts what is genuinely OPEN. Returns `null` on failure.
 */
async function readAlerts(): Promise<OperationsInput["alerts"]> {
  try {
    const { snapshot, states } = await buildAlertsSnapshot();
    const alerts = runAlertRules(snapshot);
    const withState = applyStateToAlerts(alerts, states, snapshot.now);
    const open = withState.filter((a) => !a.resolved && !a.snoozed);
    return {
      alerts: open.map((a) => ({ severity: a.severity, occurredAt: a.occurredAt })),
    };
  } catch (e) {
    console.error("[hq-operations] alerts read failed", e);
    return null;
  }
}

/** Read the generic AI task-queue overview totals. Returns `null` on failure. */
async function readQueue(): Promise<OperationsInput["queue"]> {
  try {
    const overview = await getTaskQueueOverview();
    const t = overview.totals;
    return {
      total: t.total,
      queued: t.queued,
      active: t.active,
      waitingApproval: t.waitingApproval,
      completed: t.completed,
      failed: t.failed,
    };
  } catch (e) {
    console.error("[hq-operations] task-queue read failed", e);
    return null;
  }
}

/**
 * Assemble the deterministic operations-health board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadOperationsBoard(): Promise<OperationsBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [system, alerts, queue] = await Promise.all([
    readSystem(),
    readAlerts(),
    readQueue(),
  ]);

  const input: OperationsInput = { system, alerts, queue };

  const board = computeOperationsBoard(input, new Date());
  const narrative = await loadOperationsNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Operations narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ
 * narrative helper (server/services/hq-narrative.ts), which reaches a model ONLY
 * through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.operations_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeOperationsBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadOperationsNarrative(board: OperationsBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.operations_narrative", board);
}
