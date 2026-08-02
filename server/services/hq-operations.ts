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
   * The governed operations narrative. DARK for now (see `loadOperationsNarrative`)
   * — always `null` until a model tier is bound. The UI shows an empty state.
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
  const narrative = await loadOperationsNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Operations narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the operations-health board belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under a registered AI feature whose
 * tier the registry arms. There is no registered feature/task_class for an HQ
 * operations narrative today, and reusing a tenant-facing key would misattribute
 * HQ spend in the governor ledger.
 *
 * Deliberately NO governor registry key is added for it: an unwired registry
 * entry is a permission granted to nothing, which the governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) treats as drift — the CTO AI
 * and Support AI both deferred their keys for exactly this reason, and the
 * Operations AI follows suit.
 *
 * Rather than mis-key a governed call, this stays dark: it returns `null` and
 * imports no model SDK, so the dark path can construct nothing that could spend
 * money. The page shows a "populates once a model tier is bound" empty state.
 */
async function loadOperationsNarrative(): Promise<string | null> {
  return null;
}
