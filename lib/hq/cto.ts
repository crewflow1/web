import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import {
  deriveHealth,
  isActiveStatus,
  type BoardroomTask,
  type HealthCard,
} from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — CTO AI, pure engineering-health board compute (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-cto.ts`) gathers the raw signals from the
 * EXISTING read models — launch readiness, the `hq_ai_tasks` queue, the
 * executor-shadow store, the AI-cost snapshot, the customer-health deep dive —
 * and hands a plain `CtoInput` to `computeCtoBoard` here.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/finance.ts & lib/hq/support-ai.ts) ───
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (launch
 *                blockers, stale leases, shadow divergences, blocked orgs).
 *                Nothing computed beyond counting.
 *   derived      Exact arithmetic over facts (task failure ratio =
 *                failed ÷ finished). Reproducible from the inputs alone.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or
 *                a source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction. There is NO CI-run table,
 * NO deployment-history table, and NO uptime/latency telemetry table anywhere in
 * the schema. Deploy frequency, CI pass rate, and platform uptime are therefore
 * ALWAYS `insufficient` on this board — they carry no input field at all and are
 * emitted as honest no-data cards, not invented numbers. When a real source
 * lands, it becomes a new `CtoInput` field and the SAME code computes a real
 * figure; until then the board refuses to guess.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (the reliability health idiom is reused from
 * lib/hq/boardroom-cards, which is itself `now`-injected).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type CtoMetricKind = "fact" | "derived" | "insufficient";

export const CTO_KIND_LABEL: Record<CtoMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type CtoFormat = "gbp" | "int" | "pct";

/** The overall status of a summarised group (launch readiness). */
export type CtoStatus = "green" | "amber" | "red";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors
 * and asserted in the tests).
 */
export interface CtoMetric {
  key: string;
  /** Display name — "Launch blockers", "Task failure ratio", … */
  label: string;
  kind: CtoMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: CtoFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

export interface CtoBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: CtoMetric[];
  /**
   * The launch-readiness summary, surfaced as its own view so the page can list
   * the actual blocker/warning labels rather than just a count. Null when the
   * launch-readiness source could not be read this cycle.
   */
  launch: {
    overall: CtoStatus;
    blockers: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
  } | null;
  /**
   * The estate-wide reliability health card, reusing the boardroom-cards
   * `deriveHealth` idiom over the recent `hq_ai_tasks` window (stalled leases,
   * stale heartbeats, retry pressure, failure ratio). Null when the queue could
   * not be read this cycle. Its own `level` is `insufficient` when the window is
   * empty — never a green card conjured from absent data.
   */
  reliabilityHealth: HealthCard | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from
// an EXISTING read model by the aggregator. A group is `null` when its source
// could not be read this cycle (loud-read failure) → its metrics render as
// honest `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** Launch-readiness summary, from `buildLaunchReadiness()`. */
export interface CtoLaunchInput {
  overall: CtoStatus;
  /** Labels of the RED checklist rows — the true launch blockers. */
  redLabels: ReadonlyArray<string>;
  /** Labels of the AMBER checklist rows — warnings that do not block launch. */
  amberLabels: ReadonlyArray<string>;
  /** Count of GREEN checklist rows. */
  greenCount: number;
}

/** Reliability signal — a lean window of recent `hq_ai_tasks` rows. */
export interface CtoReliabilityInput {
  tasks: ReadonlyArray<BoardroomTask>;
}

/** Executor-shadow outcome totals, from `getExecutorShadowFeed().totals`. */
export interface CtoShadowInput {
  planned: number;
  refused: number;
  error: number;
}

/** AI-cost posture, from `buildAiCostSnapshot()`. Pence throughout. */
export interface CtoAiCostInput {
  committedPence: number;
  reservedPence: number;
  blockedOrgs: number;
  overruns: number;
  ceilingPence: number;
  /** Whether ANY governed call can reach a provider right now. Dark today. */
  governorActivated: boolean;
}

/** Customer-health coverage, from `listHealthDeepDive()` folded to counts. */
export interface CtoHealthInput {
  totalOrgs: number;
  /** Orgs with no cached health_score (band = unknown). */
  unscored: number;
  /** Orgs in the red band (score < 40). */
  critical: number;
  /** Orgs in the yellow band (40 ≤ score < 70). */
  atRisk: number;
}

export interface CtoInput {
  launch: CtoLaunchInput | null;
  reliability: CtoReliabilityInput | null;
  shadow: CtoShadowInput | null;
  aiCost: CtoAiCostInput | null;
  health: CtoHealthInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: CtoFormat,
  basis: string,
): CtoMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: CtoFormat,
  basis: string,
): CtoMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: CtoFormat,
  basis: string,
): CtoMetric {
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

/**
 * Fold the reliability task window into the numeric facts the board surfaces.
 * Mirrors the counting `deriveHealth` performs internally, so the numbers on the
 * cards and the reliability health card can never disagree.
 */
function reliabilityCounts(tasks: ReadonlyArray<BoardroomTask>, nowMs: number) {
  let completed = 0;
  let failed = 0;
  let activeRetrying = 0;
  let staleLeases = 0;
  for (const t of tasks) {
    if (t.status === "completed") completed += 1;
    else if (t.status === "failed") failed += 1;
    if (isActiveStatus(t.status) && t.retry_count > 0) activeRetrying += 1;
    if (t.status === "running" && t.lease_expires_at) {
      const exp = Date.parse(t.lease_expires_at);
      if (!Number.isNaN(exp) && exp < nowMs) staleLeases += 1;
    }
  }
  const finished = completed + failed;
  return { completed, failed, finished, activeRetrying, staleLeases };
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeCtoBoard(input: CtoInput, now: Date): CtoBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: CtoMetric[] = [];

  // ── Launch readiness ──────────────────────────────────────────────────
  if (input.launch == null) {
    metrics.push(
      insufficient("launch_blockers", "Launch blockers", "int", SOURCE_UNAVAILABLE("launch-readiness")),
      insufficient("launch_warnings", "Launch warnings", "int", SOURCE_UNAVAILABLE("launch-readiness")),
    );
  } else {
    const { redLabels, amberLabels } = input.launch;
    metrics.push(
      fact(
        "launch_blockers",
        "Launch blockers",
        redLabels.length,
        "int",
        redLabels.length === 0
          ? "No red checklist rows — nothing is blocking launch."
          : `Red launch-checklist rows: ${redLabels.join("; ")}.`,
      ),
      fact(
        "launch_warnings",
        "Launch warnings",
        amberLabels.length,
        "int",
        amberLabels.length === 0
          ? "No amber checklist rows."
          : `Amber launch-checklist rows (do not block launch): ${amberLabels.join("; ")}.`,
      ),
    );
  }

  // ── Reliability (hq_ai_tasks) ─────────────────────────────────────────
  if (input.reliability == null) {
    metrics.push(
      insufficient("task_failure_ratio", "Task failure ratio", "pct", SOURCE_UNAVAILABLE("AI task queue")),
      insufficient("active_retry_pressure", "Active retry pressure", "int", SOURCE_UNAVAILABLE("AI task queue")),
      insufficient("stale_leases", "Stale leases", "int", SOURCE_UNAVAILABLE("AI task queue")),
    );
  } else {
    const c = reliabilityCounts(input.reliability.tasks, nowMs);
    metrics.push(
      c.finished > 0
        ? derived(
            "task_failure_ratio",
            "Task failure ratio",
            round1((c.failed / c.finished) * 100),
            "pct",
            `${c.failed} failed of ${c.finished} finished tasks (completed + failed) in the recent window.`,
          )
        : insufficient(
            "task_failure_ratio",
            "Task failure ratio",
            "pct",
            "No finished tasks (completed or failed) in the recent window, so a failure ratio is undefined.",
          ),
      fact(
        "active_retry_pressure",
        "Active retry pressure",
        c.activeRetrying,
        "int",
        "Active tasks (pending/running/blocked/claimed/verifying) currently carrying at least one retry.",
      ),
      fact(
        "stale_leases",
        "Stale leases",
        c.staleLeases,
        "int",
        "Running tasks whose worker lease has already expired (a stalled worker).",
      ),
    );
  }

  // ── Executor-shadow divergence ────────────────────────────────────────
  if (input.shadow == null) {
    metrics.push(
      insufficient("shadow_observations", "Shadow observations", "int", SOURCE_UNAVAILABLE("executor-shadow")),
      insufficient("shadow_divergence", "Shadow divergence", "int", SOURCE_UNAVAILABLE("executor-shadow")),
    );
  } else {
    const total = input.shadow.planned + input.shadow.refused + input.shadow.error;
    const diverged = input.shadow.refused + input.shadow.error;
    metrics.push(
      fact(
        "shadow_observations",
        "Shadow observations",
        total,
        "int",
        "Executor-shadow observations recorded (what the executor WOULD have done, execution still dark).",
      ),
      total > 0
        ? fact(
            "shadow_divergence",
            "Shadow divergence",
            diverged,
            "int",
            `${input.shadow.refused} refused + ${input.shadow.error} errored of ${total} shadow observations.`,
          )
        : insufficient(
            "shadow_divergence",
            "Shadow divergence",
            "int",
            "No executor-shadow observations recorded yet, so there is no divergence to measure.",
          ),
    );
  }

  // ── AI-cost posture ───────────────────────────────────────────────────
  if (input.aiCost == null) {
    metrics.push(
      insufficient("ai_spend_committed", "AI spend (committed)", "gbp", SOURCE_UNAVAILABLE("AI-cost snapshot")),
      insufficient("ai_spend_reserved", "AI spend (in flight)", "gbp", SOURCE_UNAVAILABLE("AI-cost snapshot")),
      insufficient("ai_blocked_orgs", "Orgs at AI ceiling", "int", SOURCE_UNAVAILABLE("AI-cost snapshot")),
      insufficient("ai_overruns", "AI cost overruns", "int", SOURCE_UNAVAILABLE("AI-cost snapshot")),
    );
  } else {
    const darkNote = input.aiCost.governorActivated
      ? ""
      : " Governor is dark (no model tier bound), so the ledger is empty and this reads £0 by construction.";
    metrics.push(
      fact(
        "ai_spend_committed",
        "AI spend (committed)",
        round1(input.aiCost.committedPence / 100),
        "gbp",
        `Committed AI spend this month across the estate (ai_invocations ledger).${darkNote}`,
      ),
      fact(
        "ai_spend_reserved",
        "AI spend (in flight)",
        round1(input.aiCost.reservedPence / 100),
        "gbp",
        "Budget claimed by calls in flight right now — not yet spend.",
      ),
      fact(
        "ai_blocked_orgs",
        "Orgs at AI ceiling",
        input.aiCost.blockedOrgs,
        "int",
        `Organisations at or over the £${Math.round(input.aiCost.ceilingPence / 100)}/month AI ceiling right now.`,
      ),
      fact(
        "ai_overruns",
        "AI cost overruns",
        input.aiCost.overruns,
        "int",
        "Settled calls whose real cost exceeded the estimate they were admitted on (reservation envelope too tight).",
      ),
    );
  }

  // ── Platform / customer-health coverage ───────────────────────────────
  if (input.health == null) {
    metrics.push(
      insufficient("customer_health_critical", "Customers critical", "int", SOURCE_UNAVAILABLE("customer-health deep dive")),
      insufficient("customer_health_unscored", "Customers unscored", "int", SOURCE_UNAVAILABLE("customer-health deep dive")),
    );
  } else {
    metrics.push(
      fact(
        "customer_health_critical",
        "Customers critical",
        input.health.critical,
        "int",
        `Organisations in the red health band (score < 40) of ${input.health.totalOrgs} on record.`,
      ),
      fact(
        "customer_health_unscored",
        "Customers unscored",
        input.health.unscored,
        "int",
        "Organisations with no cached health score — a coverage gap in the scoring pipeline, not a healthy zero.",
      ),
    );
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "platform_uptime",
      "Platform uptime",
      "pct",
      "No uptime/latency telemetry table exists in the schema; platform availability is not recorded anywhere queryable, so it is not fabricated.",
    ),
    insufficient(
      "ci_pass_rate",
      "CI pass rate",
      "pct",
      "No CI-run-history table exists in the schema; CI pass rate cannot be computed from any stored data and is not fabricated.",
    ),
    insufficient(
      "deploy_frequency",
      "Deploy frequency",
      "int",
      "No deployment-history table exists in the schema; deploy frequency cannot be computed from any stored data and is not fabricated.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    launch:
      input.launch == null
        ? null
        : {
            overall: input.launch.overall,
            blockers: input.launch.redLabels,
            warnings: input.launch.amberLabels,
          },
    reliabilityHealth:
      input.reliability == null ? null : deriveHealth(input.reliability.tasks, now),
  };
}
