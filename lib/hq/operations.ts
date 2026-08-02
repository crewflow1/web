import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";

/**
 * CrewFlow HQ — Operations AI, pure operations-health board compute (super-admin
 * surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-operations.ts`) gathers the raw signals from
 * the EXISTING HQ read models — the /admin/ops system snapshot (cron telemetry,
 * email queue, required-env presence), the HQ alerts rules engine (open alerts by
 * severity), and the generic AI task-queue overview — and hands a plain
 * `OperationsInput` to `computeOperationsBoard` here.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/cto.ts & lib/hq/finance.ts) ──────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (open alerts,
 *                cron failures, queue depth, backlog). Nothing computed beyond
 *                counting.
 *   derived      Exact arithmetic over facts (queue failure ratio =
 *                failed ÷ finished; attention load = critical + warning; oldest
 *                alert age). Reproducible from the inputs alone.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction:
 *   · SLA compliance — there is NO SLA / response-time telemetry table anywhere
 *     in the schema, so operational SLA compliance is ALWAYS insufficient.
 *   · Estate operational throughput — the estate operations command centre
 *     (server/services/operations-snapshot.ts) is TENANT-SCOPED: it reads ONE
 *     org through that org's own RLS client, org-pinned. There is no cross-tenant
 *     HQ rollup of jobs/assets/inspections completed, and summing per-tenant
 *     figures on this super-admin surface would either require picking an
 *     arbitrary org or blend tenants — the exact leak class fixed in #456. So a
 *     platform-wide operational-throughput figure is emitted insufficient rather
 *     than fabricated or blended. When a real cross-tenant rollup lands it
 *     becomes a new `OperationsInput` field and the SAME code computes it.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (alert aging is measured against the injected clock).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type OperationsMetricKind = "fact" | "derived" | "insufficient";

export const OPERATIONS_KIND_LABEL: Record<OperationsMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type OperationsFormat = "int" | "pct" | "days";

/** The overall operational traffic light (from the /admin/ops snapshot). */
export type OperationsStatus = "green" | "amber" | "red";

/** Alert severities the board buckets — mirrors lib/hq/alert-rules.AlertSeverity. */
export type OperationsAlertSeverity = "critical" | "warning" | "info";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface OperationsMetric {
  key: string;
  /** Display name — "Open alerts (critical)", "Queue depth", … */
  label: string;
  kind: OperationsMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: OperationsFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

export interface OperationsBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: OperationsMetric[];
  /**
   * The system-health summary from the /admin/ops snapshot, surfaced as its own
   * panel so the page shows the traffic light + reasons rather than just counts.
   * Null when the ops snapshot could not be read this cycle.
   */
  systemHealth: {
    status: OperationsStatus;
    summary: string;
    reasons: ReadonlyArray<string>;
  } | null;
  /**
   * The alert-load breakdown by severity, plus the oldest open-alert age (null
   * when there are no open alerts, so aging is undefined — never a spurious 0).
   * Null when the alerts source could not be read this cycle.
   */
  alertLoad: {
    critical: number;
    warning: number;
    info: number;
    total: number;
    oldestAgeDays: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** System-health posture, from `buildOpsSnapshot()` (server/services/ops-snapshot.ts). */
export interface OperationsSystemInput {
  status: OperationsStatus;
  summary: string;
  /** Names of REQUIRED env vars that are absent (gates the ops traffic light red). */
  missingRequiredEnv: ReadonlyArray<string>;
  /** Sum of cron failures across all tracked routes in the last 7 days. */
  cronFailures7d: number;
  /** Count of cron routes that both ran AND failed at least once in the last 7d. */
  cronRoutesFailing: number;
  /** Count of cron routes that did NOT run at all in the last 7 days (silent). */
  cronRoutesStale: number;
  /** Total tracked cron routes. */
  cronRoutesTotal: number;
  /** Emails currently queued (a backlog signal). */
  emailQueued: number;
  /** Emails that have permanently failed to send. */
  emailPermanentFailures: number;
}

/** One open alert, reduced to the two fields the board needs. */
export interface OperationsAlertInput {
  severity: OperationsAlertSeverity;
  /** ISO timestamp the underlying condition fired (Alert.occurredAt). */
  occurredAt: string;
}

/** Alert load, from `runAlertRules(buildAlertsSnapshot())` folded to a lean list. */
export interface OperationsAlertsInput {
  alerts: ReadonlyArray<OperationsAlertInput>;
}

/** AI task-queue posture, from `getTaskQueueOverview().totals`. Exact head-counts. */
export interface OperationsQueueInput {
  total: number;
  queued: number;
  active: number;
  waitingApproval: number;
  completed: number;
  failed: number;
}

export interface OperationsInput {
  system: OperationsSystemInput | null;
  alerts: OperationsAlertsInput | null;
  queue: OperationsQueueInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: OperationsFormat,
  basis: string,
): OperationsMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: OperationsFormat,
  basis: string,
): OperationsMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: OperationsFormat,
  basis: string,
): OperationsMetric {
  return { key, label, kind: "insufficient", value: null, format, basis };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero.`;

/** Whole days between an ISO stamp and `now`, clamped at 0 (never a negative age). */
function ageDays(iso: string, nowMs: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeOperationsBoard(input: OperationsInput, now: Date): OperationsBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: OperationsMetric[] = [];

  // ── System health (cron / email / env) ────────────────────────────────
  if (input.system == null) {
    metrics.push(
      insufficient("system_cron_failures", "Cron failures (7d)", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
      insufficient("system_crons_failing", "Cron routes failing", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
      insufficient("system_crons_stale", "Cron routes silent (7d)", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
      insufficient("system_email_backlog", "Email backlog", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
      insufficient("system_email_permanent_failures", "Email permanent failures", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
      insufficient("system_env_missing", "Required env missing", "int", SOURCE_UNAVAILABLE("system-health snapshot")),
    );
  } else {
    const s = input.system;
    metrics.push(
      fact(
        "system_cron_failures",
        "Cron failures (7d)",
        s.cronFailures7d,
        "int",
        `Total failed cron runs across all ${s.cronRoutesTotal} tracked routes in the last 7 days.`,
      ),
      fact(
        "system_crons_failing",
        "Cron routes failing",
        s.cronRoutesFailing,
        "int",
        `Tracked cron routes that ran AND failed at least once in the last 7 days (of ${s.cronRoutesTotal}).`,
      ),
      fact(
        "system_crons_stale",
        "Cron routes silent (7d)",
        s.cronRoutesStale,
        "int",
        "Tracked cron routes with NO run recorded in the last 7 days — a scheduler that has gone silent, not a healthy zero.",
      ),
      fact(
        "system_email_backlog",
        "Email backlog",
        s.emailQueued,
        "int",
        "Notification emails currently queued and not yet sent.",
      ),
      fact(
        "system_email_permanent_failures",
        "Email permanent failures",
        s.emailPermanentFailures,
        "int",
        "Notification emails that exhausted their retries and will never send without intervention.",
      ),
      fact(
        "system_env_missing",
        "Required env missing",
        s.missingRequiredEnv.length,
        "int",
        s.missingRequiredEnv.length === 0
          ? "Every required environment variable is present."
          : `Required environment variables absent: ${s.missingRequiredEnv.join(", ")}.`,
      ),
    );
  }

  // ── Alert load (HQ alerts rules engine) ───────────────────────────────
  let alertLoad: OperationsBoard["alertLoad"] = null;
  if (input.alerts == null) {
    metrics.push(
      insufficient("alerts_open_total", "Open alerts", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_critical", "Open alerts (critical)", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_warning", "Open alerts (warning)", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_attention", "Attention required", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_oldest_age", "Oldest open alert age", "days", SOURCE_UNAVAILABLE("HQ alerts")),
    );
  } else {
    const alerts = input.alerts.alerts;
    let critical = 0;
    let warning = 0;
    let info = 0;
    let oldest: number | null = null;
    for (const a of alerts) {
      if (a.severity === "critical") critical += 1;
      else if (a.severity === "warning") warning += 1;
      else info += 1;
      const age = ageDays(a.occurredAt, nowMs);
      if (age != null && (oldest == null || age > oldest)) oldest = age;
    }
    const total = alerts.length;
    const attention = critical + warning;
    alertLoad = { critical, warning, info, total, oldestAgeDays: oldest };

    metrics.push(
      fact(
        "alerts_open_total",
        "Open alerts",
        total,
        "int",
        "Distinct alerts the deterministic HQ rules engine currently fires across the estate.",
      ),
      fact(
        "alerts_critical",
        "Open alerts (critical)",
        critical,
        "int",
        "Alerts at critical severity (failed payment, migration stalled, urgent support, and the like).",
      ),
      fact(
        "alerts_warning",
        "Open alerts (warning)",
        warning,
        "int",
        "Alerts at warning severity (setup fee unpaid, low usage, trial ending, and the like).",
      ),
      derived(
        "alerts_attention",
        "Attention required",
        attention,
        "int",
        `${critical} critical + ${warning} warning alerts need operator attention (info-level events excluded).`,
      ),
      total > 0 && oldest != null
        ? fact(
            "alerts_oldest_age",
            "Oldest open alert age",
            oldest,
            "days",
            "Days since the oldest currently-open alert's underlying condition first fired.",
          )
        : insufficient(
            "alerts_oldest_age",
            "Oldest open alert age",
            "days",
            "No open alerts, so there is no aging to measure.",
          ),
    );
  }

  // ── AI task-queue health ──────────────────────────────────────────────
  if (input.queue == null) {
    metrics.push(
      insufficient("queue_depth", "Queue depth", "int", SOURCE_UNAVAILABLE("AI task-queue overview")),
      insufficient("queue_active", "Tasks in flight", "int", SOURCE_UNAVAILABLE("AI task-queue overview")),
      insufficient("queue_waiting_approval", "Awaiting approval", "int", SOURCE_UNAVAILABLE("AI task-queue overview")),
      insufficient("queue_completed", "Tasks completed", "int", SOURCE_UNAVAILABLE("AI task-queue overview")),
      insufficient("queue_failure_ratio", "Queue failure ratio", "pct", SOURCE_UNAVAILABLE("AI task-queue overview")),
    );
  } else {
    const q = input.queue;
    const finished = q.completed + q.failed;
    metrics.push(
      fact(
        "queue_depth",
        "Queue depth",
        q.queued,
        "int",
        "Tasks pending on the generic AI task engine, waiting for a worker to claim them.",
      ),
      fact(
        "queue_active",
        "Tasks in flight",
        q.active,
        "int",
        "Tasks a worker currently holds (claimed, running, or verifying).",
      ),
      fact(
        "queue_waiting_approval",
        "Awaiting approval",
        q.waitingApproval,
        "int",
        "Tasks paused for a human approval decision before they can proceed.",
      ),
      fact(
        "queue_completed",
        "Tasks completed",
        q.completed,
        "int",
        "Tasks the engine has finished successfully (engine-wide lifetime count).",
      ),
      finished > 0
        ? derived(
            "queue_failure_ratio",
            "Queue failure ratio",
            round1((q.failed / finished) * 100),
            "pct",
            `${q.failed} failed of ${finished} finished tasks (completed + failed), engine-wide.`,
          )
        : insufficient(
            "queue_failure_ratio",
            "Queue failure ratio",
            "pct",
            "No finished tasks (completed or failed) on the engine, so a failure ratio is undefined.",
          ),
    );
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "sla_compliance",
      "SLA compliance",
      "pct",
      "No SLA / response-time telemetry table exists in the schema; operational SLA compliance is not recorded anywhere queryable, so it is not fabricated.",
    ),
    insufficient(
      "estate_operational_throughput",
      "Estate operational throughput",
      "int",
      "No cross-tenant estate-operations rollup table exists; the operations command centre is tenant-scoped and cannot be blended across tenants on this HQ surface, so a platform-wide throughput figure is not fabricated.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    systemHealth:
      input.system == null
        ? null
        : {
            status: input.system.status,
            summary: input.system.summary,
            reasons: buildSystemReasons(input.system),
          },
    alertLoad,
  };
}

/**
 * Plain-English reasons behind the system traffic light — mirrors the summary the
 * ops snapshot itself computes, restated as bullets for the panel. Empty when
 * everything is nominal (the panel then shows the summary line alone).
 */
function buildSystemReasons(s: OperationsSystemInput): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (s.missingRequiredEnv.length > 0) {
    reasons.push(`Missing required env: ${s.missingRequiredEnv.join(", ")}.`);
  }
  if (s.cronRoutesFailing > 0) {
    reasons.push(
      `${s.cronFailures7d} cron failure${s.cronFailures7d === 1 ? "" : "s"} across ${s.cronRoutesFailing} route${s.cronRoutesFailing === 1 ? "" : "s"} in the last 7 days.`,
    );
  }
  if (s.cronRoutesStale > 0) {
    reasons.push(
      `${s.cronRoutesStale} cron route${s.cronRoutesStale === 1 ? "" : "s"} recorded no run in the last 7 days.`,
    );
  }
  if (s.emailPermanentFailures > 0) {
    reasons.push(`${s.emailPermanentFailures} email${s.emailPermanentFailures === 1 ? "" : "s"} permanently failed.`);
  }
  if (s.emailQueued > 0) {
    reasons.push(`${s.emailQueued} email${s.emailQueued === 1 ? "" : "s"} queued.`);
  }
  return reasons;
}
