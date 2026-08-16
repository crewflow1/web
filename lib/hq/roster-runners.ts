/**
 * CrewFlow HQ — Roster runner derivations (MP Wave R3).
 *
 * The dark roster (20261128000000) registered ~15 employee identities with NO runner,
 * so their Boardroom cards read "insufficient". This module gives a meaningful subset
 * REAL work: pure, DETERMINISTIC derivations that turn genuine existing data sources
 * into an explainable result an AI employee completes a Task-Engine task with. The
 * service layer (server/services/hq-*-runner.ts) reads the data with the admin client
 * and defers to these functions; the unit tests exercise them directly.
 *
 * Server/client-safe — NO Supabase / server-only imports, exactly like
 * `lib/hq/boardroom-cards.ts` and `lib/hq/analytics.ts`. `now` is INJECTED everywhere so
 * every derivation is deterministic and testable.
 *
 * Two first principles run through all three:
 *   1. HONEST "insufficient" — when the data cannot support a claim we say so, and never
 *      conjure a green result from absent data. No fabricated metrics, no placeholders.
 *   2. NO irreversible action — these runners COMPUTE and REPORT. Every output is a
 *      read-derived, sourced, explainable envelope; nothing here sends, commits, or
 *      mutates. Humans keep final approval.
 *
 * The shape each derivation returns is a superset of the standard AI output envelope
 * (`AiOutput` in server/sdk/output.ts): `summary` + `confidence` + `reasoning` + a typed
 * domain payload. The runner returns it verbatim and the engine persists it into the
 * task's `result` jsonb the Boardroom already reads.
 */

import type { RevenueAnalytics, CustomerAnalytics } from "@/lib/hq/analytics";

// ---------------------------------------------------------------------
// Shared envelope shape.
// ---------------------------------------------------------------------

/**
 * The common head of every runner result — the standard-envelope fields the Boardroom
 * and the CEO board can read uniformly. `confidence` is 1 for a fully-determined
 * deterministic compute over present data, and 0 when the result is honestly
 * `insufficient` (thin/absent data).
 */
export interface RunnerEnvelope {
  summary: string;
  reasoning: string;
  /** 0..1. Deterministic compute is 1 when data is present, 0 when insufficient. */
  confidence: number;
  /** True when the data source was too thin to support a claim. */
  insufficient: boolean;
  /** ISO stamp of the derivation, injected for determinism. */
  generatedAt: string;
  /** Named data sources the result was derived from — provenance, never fabricated. */
  sources: string[];
  /**
   * The standard AI output envelope (server/sdk/output.ts) admits domain-specific keys
   * via an index signature; declaring it here makes every runner result assignable to
   * `AiOutput` so the Task Engine can persist it verbatim into the task `result` jsonb.
   */
  [key: string]: unknown;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// =====================================================================
// 1. Analytics AI — business & product analytics synthesis.
//    Source: the existing HQ analytics snapshot (orgs + billing invoices), reduced by
//    the existing deterministic derivations computeRevenueAnalytics /
//    computeCustomerAnalytics. This runner recomputes that snapshot as a task.
// =====================================================================

export interface AnalyticsRunnerResult extends RunnerEnvelope {
  kind: "analytics_snapshot";
  metrics: {
    orgs: number;
    activeCustomers: number;
    mrrGbp: number;
    arrGbp: number;
    churnPct: number;
    growthPct: number;
    outstandingGbp: number;
    healthy: number;
    atRisk: number;
    critical: number;
    unscored: number;
  } | null;
}

/**
 * Fold the two deterministic analytics derivations + the raw counts into a single
 * explainable snapshot result. Honest `insufficient` when there is no estate to
 * analyse (zero orgs) — we never report £0 MRR as a finding when there is simply no
 * data.
 */
export function summariseAnalytics(
  input: {
    revenue: RevenueAnalytics;
    customer: CustomerAnalytics;
    orgCount: number;
    invoiceCount: number;
  },
  now: Date,
): AnalyticsRunnerResult {
  const generatedAt = now.toISOString();
  const sources = ["organizations", "billing_invoices"];
  const { revenue, customer, orgCount, invoiceCount } = input;

  if (orgCount === 0) {
    return {
      kind: "analytics_snapshot",
      summary: "Insufficient data — no organizations to analyse yet.",
      reasoning:
        "The analytics snapshot read zero organizations, so no revenue, growth, or health figure can be claimed. This is an honest empty read, not a zero result.",
      confidence: 0,
      insufficient: true,
      generatedAt,
      sources,
      metrics: null,
    };
  }

  const activeCustomers = customer.healthy + customer.atRisk + customer.critical;
  const metrics = {
    orgs: orgCount,
    activeCustomers,
    mrrGbp: round2(revenue.mrrGbp),
    arrGbp: round2(revenue.arrGbp),
    churnPct: round2(revenue.churnPct),
    growthPct: round2(revenue.growthPct),
    outstandingGbp: round2(revenue.outstandingGbp),
    healthy: customer.healthy,
    atRisk: customer.atRisk,
    critical: customer.critical,
    unscored: customer.unscored,
  };

  const summary =
    `£${metrics.mrrGbp.toLocaleString("en-GB")} MRR across ${orgCount} org${orgCount === 1 ? "" : "s"} ` +
    `(${metrics.healthy} healthy, ${metrics.atRisk} at-risk, ${metrics.critical} critical).`;
  const reasoning =
    `Derived deterministically from ${orgCount} organization row${orgCount === 1 ? "" : "s"} and ` +
    `${invoiceCount} billing invoice${invoiceCount === 1 ? "" : "s"}. MRR is the sum of active-org monthly price; ` +
    `growth ${metrics.growthPct}% and churn ${metrics.churnPct}% are the existing HQ analytics derivations. No figure is estimated.`;

  return {
    kind: "analytics_snapshot",
    summary,
    reasoning,
    confidence: 1,
    insufficient: false,
    generatedAt,
    sources,
    metrics,
  };
}

// =====================================================================
// 2. Monitoring & Incident AI — observability over the Task Engine + cron telemetry.
//    Source: hq_ai_tasks (a sanctioned READ, exactly like hq-task-pipeline) for lease /
//    heartbeat / retry / failure signals, and cron_runs for recent cron failures. This
//    runner wraps signals that already exist (the reaper recovers expired leases; this
//    REPORTS the picture, it resolves nothing).
// =====================================================================

/** Lease/heartbeat/retry thresholds — named so the bands are auditable, not magic. */
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The lean subset of an hq_ai_tasks row the monitoring sweep consults. */
export interface MonitoringTaskRow {
  status: string;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  retry_count: number;
  max_retries: number;
  updated_at: string | null;
}

/** The lean subset of a cron_runs row the sweep consults. */
export interface MonitoringCronRow {
  route: string;
  ok: boolean | null;
  completed_at: string | null;
}

export type IncidentSeverity = "ok" | "warning" | "critical";

export interface MonitoringRunnerResult extends RunnerEnvelope {
  kind: "monitoring_sweep";
  severity: IncidentSeverity;
  signals: {
    expiredLeases: number;
    staleHeartbeats: number;
    failedLast24h: number;
    retryExhausted: number;
    failedCronRuns: number;
    failedCronRoutes: string[];
  };
}

/**
 * Sweep the task-engine + cron signals into a single incident picture. Every count is a
 * deterministic read of a real column; the worst signal sets the severity. Honest
 * `insufficient` only when there is literally nothing to observe (no tasks and no cron
 * runs). An all-clear over real rows is a genuine "ok", not "insufficient".
 */
export function summariseMonitoring(
  tasks: ReadonlyArray<MonitoringTaskRow>,
  cronRuns: ReadonlyArray<MonitoringCronRow>,
  now: Date,
): MonitoringRunnerResult {
  const generatedAt = now.toISOString();
  const sources = ["hq_ai_tasks", "cron_runs"];
  const nowMs = now.getTime();

  if (tasks.length === 0 && cronRuns.length === 0) {
    return {
      kind: "monitoring_sweep",
      summary: "Insufficient data — no task or cron activity to observe yet.",
      reasoning:
        "The sweep found zero task rows and zero cron runs in the observed window, so no health claim can be made.",
      confidence: 0,
      insufficient: true,
      generatedAt,
      sources,
      severity: "ok",
      signals: {
        expiredLeases: 0,
        staleHeartbeats: 0,
        failedLast24h: 0,
        retryExhausted: 0,
        failedCronRuns: 0,
        failedCronRoutes: [],
      },
    };
  }

  let expiredLeases = 0;
  let staleHeartbeats = 0;
  let failedLast24h = 0;
  let retryExhausted = 0;

  for (const t of tasks) {
    if (t.status === "running") {
      if (t.lease_expires_at) {
        const exp = Date.parse(t.lease_expires_at);
        if (!Number.isNaN(exp) && exp < nowMs) expiredLeases += 1;
      }
      if (t.heartbeat_at) {
        const hb = Date.parse(t.heartbeat_at);
        if (!Number.isNaN(hb) && nowMs - hb >= HEARTBEAT_STALE_MS) staleHeartbeats += 1;
      }
    }
    if (t.status === "failed") {
      const finishedAt = t.updated_at ? Date.parse(t.updated_at) : NaN;
      if (!Number.isNaN(finishedAt) && nowMs - finishedAt <= FAILED_WINDOW_MS) {
        failedLast24h += 1;
      }
    }
    // A task that has exhausted its retry budget and is not terminal is stuck.
    if (
      (t.status === "running" || t.status === "pending" || t.status === "blocked") &&
      t.retry_count >= t.max_retries &&
      t.max_retries > 0
    ) {
      retryExhausted += 1;
    }
  }

  const failedCronRoutes: string[] = [];
  for (const c of cronRuns) {
    if (c.ok === false) {
      if (!failedCronRoutes.includes(c.route)) failedCronRoutes.push(c.route);
    }
  }
  const failedCronRuns = cronRuns.filter((c) => c.ok === false).length;

  const signals = {
    expiredLeases,
    staleHeartbeats,
    failedLast24h,
    retryExhausted,
    failedCronRuns,
    failedCronRoutes,
  };

  // Severity: expired leases / stale heartbeats / retry-exhaustion are CRITICAL (work is
  // stuck); recent failures or failed cron runs are WARNING; otherwise OK.
  const criticalHit = expiredLeases > 0 || staleHeartbeats > 0 || retryExhausted > 0;
  const warningHit = failedLast24h > 0 || failedCronRuns > 0;
  const severity: IncidentSeverity = criticalHit
    ? "critical"
    : warningHit
      ? "warning"
      : "ok";

  const reasons: string[] = [];
  if (expiredLeases > 0)
    reasons.push(`${expiredLeases} running task${expiredLeases === 1 ? "" : "s"} with an expired lease`);
  if (staleHeartbeats > 0)
    reasons.push(`${staleHeartbeats} task${staleHeartbeats === 1 ? "" : "s"} with no heartbeat for 15m+`);
  if (retryExhausted > 0)
    reasons.push(`${retryExhausted} task${retryExhausted === 1 ? "" : "s"} out of retries but not terminal`);
  if (failedLast24h > 0)
    reasons.push(`${failedLast24h} task${failedLast24h === 1 ? "" : "s"} failed in the last 24h`);
  if (failedCronRuns > 0)
    reasons.push(`${failedCronRuns} failed cron run${failedCronRuns === 1 ? "" : "s"} (${failedCronRoutes.join(", ")})`);

  const summary =
    severity === "ok"
      ? `All clear across ${tasks.length} task${tasks.length === 1 ? "" : "s"} and ${cronRuns.length} cron run${cronRuns.length === 1 ? "" : "s"}.`
      : `${severity === "critical" ? "Critical" : "Warning"}: ${reasons.join("; ")}.`;
  const reasoning =
    `Deterministic sweep of ${tasks.length} recent task row${tasks.length === 1 ? "" : "s"} and ` +
    `${cronRuns.length} recent cron run${cronRuns.length === 1 ? "" : "s"}. Expired-lease and stale-heartbeat ` +
    `(15m) signals are read straight from the lease/heartbeat columns; the reaper cron owns recovery, this ` +
    `sweep only reports. No signal is inferred beyond the recorded columns.`;

  return {
    kind: "monitoring_sweep",
    summary,
    reasoning,
    confidence: 1,
    insufficient: false,
    generatedAt,
    sources,
    severity,
    signals,
  };
}

// =====================================================================
// 3. Notification AI — delivery-backlog digest.
//    Source: the notifications table (unread rows). This runner summarises pending
//    notifications; it counts and reports, it delivers nothing.
// =====================================================================

/**
 * The lean subset of a notifications row the digest consults — the type only. The
 * service pages the COMPLETE unread set (read_at is null) and passes it here, so this
 * never sees title/body/recipient and the count can never silently under-report.
 */
export interface NotificationRow {
  type: string;
}

export interface NotificationRunnerResult extends RunnerEnvelope {
  kind: "notification_digest";
  totalUnread: number;
  byType: Array<{ type: string; count: number }>;
}

/**
 * Digest the pending (unread) notification backlog by type from the COMPLETE unread set
 * (the service filters `read_at is null` and pages it in full). Counts only — never the
 * title/body/recipient — so the digest carries no PII. There is no "insufficient" state:
 * an empty backlog is a genuine, fully-determined "nothing pending" finding, not thin
 * data.
 */
export function summariseNotifications(
  unreadRows: ReadonlyArray<NotificationRow>,
  now: Date,
): NotificationRunnerResult {
  const generatedAt = now.toISOString();
  const sources = ["notifications"];

  const counts = new Map<string, number>();
  const totalUnread = unreadRows.length;
  for (const r of unreadRows) {
    counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  }

  const byType = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const summary =
    totalUnread === 0
      ? "No pending notifications — the delivery backlog is clear."
      : `${totalUnread} pending notification${totalUnread === 1 ? "" : "s"} across ${byType.length} type${byType.length === 1 ? "" : "s"}.`;
  const reasoning =
    `Deterministic count of the COMPLETE unread set (read_at is null), paged in full and grouped by ` +
    `type. Counts only — no title, body, or recipient is read, and no row past a cap is dropped.`;

  return {
    kind: "notification_digest",
    summary,
    reasoning,
    // A complete unread count is always fully determined — empty is a real finding.
    confidence: 1,
    insufficient: false,
    generatedAt,
    sources,
    totalUnread,
    byType,
  };
}
