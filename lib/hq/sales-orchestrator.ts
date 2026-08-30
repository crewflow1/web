import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import {
  buildFunnel,
  isLostStatus,
  isOpenStatus,
  isWonStatus,
  tallyStatuses,
  type FunnelStage,
} from "@/lib/sales/model";

/**
 * CrewFlow HQ — Sales-Orchestrator AI, pure cross-stage pipeline compute
 * (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO wall clock. The server-only
 * aggregator (`server/services/hq-sales-orchestrator.ts`) gathers the raw
 * signals from the EXISTING sales read models — CrewFlow's own sales pipeline
 * (`hq_sales_companies`), the three drain queues on the generic Task Engine
 * (`hq_ai_tasks`: research_company / qualify_company / generate_email) and the
 * outreach cadence on the permanent timeline (`hq_sales_timeline_events`) — and
 * hands a plain `SalesOrchestratorInput` to `computeSalesOrchestratorBoard` here.
 *
 * ── SCOPE: ONE PIPELINE ACROSS THE THREE DRAINS ─────────────────────────────
 * The Sales AI platform already runs three independent drains — Research AI,
 * Lead Qualification AI and Outreach AI — each with its own live view and its own
 * metrics. What was MISSING was a single orchestration board that unifies them
 * into a pipeline-health / deal-progression picture: how many deals sit at each
 * stage, how they convert stage-to-stage, which have stalled, how each drain's
 * backlog is ageing, and whether outreach cadence is being kept. This board is
 * that unifier. It owns NO new data — every figure is read from the existing
 * sales tables and labelled honestly.
 *
 * #456 — HQ-GLOBAL ONLY. Every source here is CrewFlow's OWN sales pipeline
 * (the `hq_sales_*` tables + the HQ task queue), read on the service-role path.
 * NO tenant-scoped product table is ever read; nothing is blended across tenants.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/customer-success.ts & marketing.ts) ──
 * Every figure LABELS ITSELF and carries a plain-English `basis`. Three labels:
 *
 *   fact         A count read straight from an existing read model (deals at a
 *                stage, a drain's backlog / in-flight / failed count). Nothing
 *                beyond counting — and a readable ZERO is a real fact, not
 *                insufficient (no deals at a stage is a factual 0).
 *   derived      Exact arithmetic over facts (stage-to-stage conversion, win /
 *                close rate, average open-deal age, drain backlog age, outreach
 *                cadence health). Reproducible from the inputs.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle, OR the figure
 *                is a ratio/age whose base is empty (undefined, not zero). We
 *                return `value: null` with a one-line basis saying why — NEVER a
 *                fabricated 0-as-real, and NEVER a green card from absent data.
 *
 * THE READABLE-ZERO vs INSUFFICIENT LINE (the invariant this board is careful
 * about): a COUNT that reads as 0 is a `fact` (we counted, the answer is zero).
 * A RATIO or an AGE with no denominator/sample is `insufficient` (we cannot
 * divide by nothing, so the figure is undefined — not zero). A whole SOURCE that
 * could not be read is `insufficient` for every figure it feeds.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction:
 *   · Cohort deal velocity — the schema records a deal's CURRENT status and its
 *     last-change timestamp (`updated_at`) only; there is NO per-stage entry
 *     timestamp, so a true stage-dwell / cohort velocity cannot be computed. The
 *     average open-deal age is surfaced as an honest proxy instead.
 *   · Forecast win probability — there is NO win-probability model or predicted
 *     close-date field in the schema, so a forecasted close cannot be computed.
 * Each carries no input field at all and is emitted as an honest no-data card.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (period label + every age is measured against the clock).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type SalesOrchestratorMetricKind = "fact" | "derived" | "insufficient";

export const SALES_ORCHESTRATOR_KIND_LABEL: Record<
  SalesOrchestratorMetricKind,
  string
> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type SalesOrchestratorFormat = "int" | "pct" | "days";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface SalesOrchestratorMetric {
  key: string;
  /** Display name — "Open pipeline", "Qualification conversion", … */
  label: string;
  kind: SalesOrchestratorMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: SalesOrchestratorFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** One stage of the unified sales funnel, widest → narrowest. */
export interface SalesOrchestratorStage {
  key: string;
  label: string;
  /** Deals that have reached this stage or beyond (a fact from the pipeline). */
  reached: number;
  /** Conversion from the previous stage (%, 1 d.p.); null for the first stage. */
  conversionFromPrev: number | null;
}

/** One drain's live health block (research / qualification / outreach). */
export interface SalesOrchestratorDrain {
  key: "research" | "qualification" | "outreach";
  label: string;
  /** Pending tasks — the backlog waiting to be worked. */
  backlog: number;
  /** Running tasks — in flight right now. */
  inFlight: number;
  /** Completed tasks — the drain's lifetime throughput. */
  completed: number;
  /** Failed tasks — surfaced honestly, never hidden. */
  failed: number;
}

export interface SalesOrchestratorBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: SalesOrchestratorMetric[];
  /**
   * The unified sales funnel as ORDERED STAGE COUNTS (widest → narrowest), from
   * CrewFlow's OWN `hq_sales_companies` pipeline: new → qualified → outreach-ready
   * → contacted → replied → demo booked → won. A point-in-time position snapshot
   * (a deal at stage N has "reached" stages 1..N), not a cohort flowing through.
   * Empty when the pipeline source could not be read this cycle.
   */
  funnel: ReadonlyArray<SalesOrchestratorStage>;
  /**
   * The three drains' live health blocks (research / qualification / outreach),
   * from the HQ task queue. Null when the queue could not be read this cycle
   * (never a fabricated all-idle split).
   */
  drains: ReadonlyArray<SalesOrchestratorDrain> | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** A lean pipeline row — status + the two timestamps ages are measured from. */
export interface SalesOrchestratorPipelineRow {
  /** hq_sales_companies.status (a PipelineStatus). */
  status: string;
  /** When the deal entered the pipeline. */
  created_at: string;
  /** When the deal last changed status/state — the staleness signal. */
  updated_at: string;
}

/** CrewFlow's OWN sales pipeline (a single global table on the service path). */
export interface SalesOrchestratorPipelineInput {
  companies: ReadonlyArray<SalesOrchestratorPipelineRow>;
}

/** One drain's task-queue snapshot (a single hq_ai_tasks task_type). */
export interface SalesOrchestratorDrainInput {
  /** Pending (queued) tasks. */
  pending: number;
  /** Running (in-flight) tasks. */
  running: number;
  /** Completed tasks. */
  completed: number;
  /** Failed tasks. */
  failed: number;
  /**
   * ISO `created_at` of the OLDEST still-pending task, or `null` when nothing is
   * pending. A null here makes the backlog-age figure honestly insufficient
   * (undefined), NOT a fabricated zero-day age.
   */
  oldestPendingAt: string | null;
}

/** The three drains that make up the sales pipeline, from the HQ task queue. */
export interface SalesOrchestratorDrainsInput {
  research: SalesOrchestratorDrainInput;
  qualification: SalesOrchestratorDrainInput;
  outreach: SalesOrchestratorDrainInput;
}

/**
 * Outreach cadence posture, folded from the permanent timeline: of the open,
 * post-qualification deals that SHOULD be in an active outreach cadence, how many
 * were touched inside the cadence window and how many have gone silent.
 */
export interface SalesOrchestratorCadenceInput {
  /** Open, post-qualification deals expected to be in an active outreach cadence. */
  activeOutreachDeals: number;
  /** Of those, deals with an outbound outreach touch within the cadence window. */
  touchedWithinWindow: number;
  /** Of those, deals gone silent beyond the window — overdue for a touch. */
  overdue: number;
}

export interface SalesOrchestratorInput {
  pipeline: SalesOrchestratorPipelineInput | null;
  drains: SalesOrchestratorDrainsInput | null;
  cadence: SalesOrchestratorCadenceInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: SalesOrchestratorFormat,
  basis: string,
): SalesOrchestratorMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: SalesOrchestratorFormat,
  basis: string,
): SalesOrchestratorMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: SalesOrchestratorFormat,
  basis: string,
): SalesOrchestratorMetric {
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

/** Whole days between an ISO timestamp and `now` (>= 0); null if unparseable. */
function daysSince(iso: string, nowMs: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero.`;

/** An open deal untouched (no status movement) for longer than this is stalled. */
const STALL_DAYS = 14;
/** Minimum decided (won+lost) deals before a measured win rate feeds the
 *  pipeline forecast — mirrors the finance board's minimum-sample doctrine. */
const FORECAST_MIN_DECIDED = 8;
/** The outreach cadence window — a live deal should be touched inside this. */
const CADENCE_DAYS = 7;

/** The three drains, in pipeline order, with their display labels. */
const DRAIN_ORDER: ReadonlyArray<{
  key: SalesOrchestratorDrain["key"];
  label: string;
  metricLabel: string;
}> = [
  { key: "research", label: "Research", metricLabel: "Research" },
  { key: "qualification", label: "Qualification", metricLabel: "Qualification" },
  { key: "outreach", label: "Outreach", metricLabel: "Outreach" },
];

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeSalesOrchestratorBoard(
  input: SalesOrchestratorInput,
  now: Date,
): SalesOrchestratorBoard {
  const nowMs = now.getTime();
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  const metrics: SalesOrchestratorMetric[] = [];
  const funnel: SalesOrchestratorStage[] = [];
  let drainBlocks: SalesOrchestratorDrain[] | null = null;

  // ── Pipeline — CrewFlow's own hq_sales_companies deal stages ──────────
  if (input.pipeline == null) {
    metrics.push(
      insufficient("open_pipeline", "Open pipeline", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_new", "New (awaiting qualification)", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_qualified", "Qualified", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_outreach_ready", "Outreach ready", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_in_conversation", "In conversation", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_won", "Won", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("deals_lost", "Lost / disqualified", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("pipeline_forecast_expected_wins", "Pipeline forecast (expected wins)", "int", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("qualification_conversion", "Qualification conversion", "pct", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("outreach_conversion", "Outreach conversion", "pct", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("win_rate", "Win rate", "pct", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("close_rate", "Close rate (decided deals)", "pct", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("avg_open_deal_age", "Avg open-deal age", "days", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("oldest_open_deal_age", "Oldest open deal", "days", SOURCE_UNAVAILABLE("sales pipeline")),
      insufficient("stalled_deals", "Stalled deals", "int", SOURCE_UNAVAILABLE("sales pipeline")),
    );
  } else {
    const rows = input.pipeline.companies;
    const counts = tallyStatuses(rows);
    const totalAll = rows.length;

    const open = rows.filter((r) => isOpenStatus(r.status));
    const openCount = open.length;
    const wonCount = rows.filter((r) => isWonStatus(r.status)).length;
    const lostCount = rows.filter((r) => isLostStatus(r.status)).length;
    const inConversation =
      counts.contacted + counts.replied + counts.demo_booked;

    // The unified funnel (reached counts + stage-to-stage conversion display).
    const stages: FunnelStage[] = buildFunnel(counts);
    for (const s of stages) {
      funnel.push({
        key: `stage_${s.stage}`,
        label: s.label,
        reached: s.reached,
        conversionFromPrev: s.conversionFromPrev,
      });
    }
    // Reached[0] = the whole funnel base (new-or-beyond); reached at qualified /
    // outreach are the conversion denominators, computed here with EXPLICIT base
    // guards so an empty base is `insufficient` (undefined), never a phantom 0%.
    const reachedNew = stages.find((s) => s.stage === "new")?.reached ?? 0;
    const reachedQualified =
      stages.find((s) => s.stage === "qualified")?.reached ?? 0;
    const reachedOutreach =
      stages.find((s) => s.stage === "outreach_ready")?.reached ?? 0;

    // Ages over the OPEN pipeline (a deal at a terminal status has no "age" in
    // the pipeline sense). Unparseable timestamps are skipped from the sample.
    let ageSum = 0;
    let ageN = 0;
    let oldest = 0;
    let stalled = 0;
    for (const r of open) {
      const age = daysSince(r.created_at, nowMs);
      if (age != null) {
        ageSum += age;
        ageN += 1;
        if (age > oldest) oldest = age;
      }
      const idle = daysSince(r.updated_at, nowMs);
      if (idle != null && idle > STALL_DAYS) stalled += 1;
    }

    metrics.push(
      fact(
        "open_pipeline",
        "Open pipeline",
        openCount,
        "int",
        "Deals in an open pipeline status (new → demo booked) — the live workload across all three drains.",
      ),
      fact(
        "deals_new",
        "New (awaiting qualification)",
        counts.new,
        "int",
        "Deals captured but not yet qualified — the Research → Qualification hand-off queue.",
      ),
      fact(
        "deals_qualified",
        "Qualified",
        counts.qualified,
        "int",
        "Deals assessed as a genuine fit, sitting at the qualified stage awaiting outreach preparation.",
      ),
      fact(
        "deals_outreach_ready",
        "Outreach ready",
        counts.outreach_ready,
        "int",
        "Deals researched with an angle prepared, ready for the Outreach drain to contact.",
      ),
      fact(
        "deals_in_conversation",
        "In conversation",
        inConversation,
        "int",
        "Deals actively engaged — contacted, replied or with a demo booked.",
      ),
      fact(
        "deals_won",
        "Won",
        wonCount,
        "int",
        "Closed-won deals — the pipeline's realised output.",
      ),
      fact(
        "deals_lost",
        "Lost / disqualified",
        lostCount,
        "int",
        "Deals closed-lost or disqualified — surfaced honestly, not hidden from the funnel picture.",
      ),
      reachedNew > 0
        ? derived(
            "qualification_conversion",
            "Qualification conversion",
            round1((reachedQualified / reachedNew) * 100),
            "pct",
            `${reachedQualified} of ${reachedNew} deals have reached qualified-or-beyond — a point-in-time position ratio, not a cohort.`,
          )
        : insufficient(
            "qualification_conversion",
            "Qualification conversion",
            "pct",
            "No deals in the funnel yet, so a qualification conversion is undefined (not zero).",
          ),
      reachedQualified > 0
        ? derived(
            "outreach_conversion",
            "Outreach conversion",
            round1((reachedOutreach / reachedQualified) * 100),
            "pct",
            `${reachedOutreach} of ${reachedQualified} qualified-or-beyond deals have reached outreach-ready-or-beyond — a point-in-time position ratio, not a cohort.`,
          )
        : insufficient(
            "outreach_conversion",
            "Outreach conversion",
            "pct",
            "No qualified-or-beyond deals yet, so an outreach conversion is undefined (not zero).",
          ),
      totalAll > 0
        ? derived(
            "win_rate",
            "Win rate",
            round1((wonCount / totalAll) * 100),
            "pct",
            `${wonCount} won of ${totalAll} total deals on record.`,
          )
        : insufficient(
            "win_rate",
            "Win rate",
            "pct",
            "No deals on record, so a win rate is undefined (not zero).",
          ),
      wonCount + lostCount > 0
        ? derived(
            "close_rate",
            "Close rate (decided deals)",
            round1((wonCount / (wonCount + lostCount)) * 100),
            "pct",
            `${wonCount} won of ${wonCount + lostCount} decided (won + lost/disqualified) deals.`,
          )
        : insufficient(
            "close_rate",
            "Close rate (decided deals)",
            "pct",
            "No deals have been decided (won or lost) yet, so a close rate is undefined (not zero).",
          ),
      ageN > 0
        ? derived(
            "avg_open_deal_age",
            "Avg open-deal age",
            round1(ageSum / ageN),
            "days",
            "Average days since creation across open deals — an honest deal-progression proxy (no per-stage entry timestamp exists for a true cohort velocity).",
          )
        : insufficient(
            "avg_open_deal_age",
            "Avg open-deal age",
            "days",
            "No open deals, so an average open-deal age is undefined (not zero).",
          ),
      ageN > 0
        ? derived(
            "oldest_open_deal_age",
            "Oldest open deal",
            round1(oldest),
            "days",
            "Days since creation of the oldest open deal — the age of the longest-waiting deal in the pipeline.",
          )
        : insufficient(
            "oldest_open_deal_age",
            "Oldest open deal",
            "days",
            "No open deals, so an oldest-open-deal age is undefined (not zero).",
          ),
      fact(
        "stalled_deals",
        "Stalled deals",
        stalled,
        "int",
        `Open deals with no status movement for over ${STALL_DAYS} days — the intervention queue, not a healthy zero.`,
      ),
    );

  // ── Pipeline forecast (roadmap R229) — expected closed-won from the OPEN
  // pipeline at the MEASURED historical win rate (won / decided). Purely
  // deterministic and replayable; below the minimum decided sample the rate
  // is statistical noise, so the metric is honestly insufficient rather
  // than a figure conjured from three data points. Expected WINS, not value:
  // the prospect pipeline carries no monetary value column, and inventing
  // one is exactly what this board refuses to do.
  {
    const decided = wonCount + lostCount;
    if (decided >= FORECAST_MIN_DECIDED && openCount > 0) {
      const winRate = wonCount / decided;
      metrics.push(
        derived(
          "pipeline_forecast_expected_wins",
          "Pipeline forecast (expected wins)",
          Math.round(openCount * winRate * 10) / 10,
          "int",
          `${openCount} open deal${openCount === 1 ? "" : "s"} × the measured historical win rate (${wonCount}/${decided} decided = ${Math.round(winRate * 100)}%). Deterministic expected closed-won count — not a per-deal probability model, and never a revenue figure (the pipeline carries no deal value).`,
        ),
      );
    } else {
      metrics.push(
        insufficient(
          "pipeline_forecast_expected_wins",
          "Pipeline forecast (expected wins)",
          "int",
          decided < FORECAST_MIN_DECIDED
            ? `Only ${decided} decided deal${decided === 1 ? "" : "s"} (won + lost) — below the ${FORECAST_MIN_DECIDED}-deal minimum a measured win rate needs to be more than noise.`
            : "No open deals — there is nothing to forecast over.",
        ),
      );
    }
  }
  }

  // ── Drains — the three HQ task queues (research/qualification/outreach) ─
  if (input.drains == null) {
    for (const d of DRAIN_ORDER) {
      metrics.push(
        insufficient(`${d.key}_backlog`, `${d.metricLabel} backlog`, "int", SOURCE_UNAVAILABLE("HQ task queue")),
        insufficient(`${d.key}_in_flight`, `${d.metricLabel} in flight`, "int", SOURCE_UNAVAILABLE("HQ task queue")),
        insufficient(`${d.key}_failed`, `${d.metricLabel} failed`, "int", SOURCE_UNAVAILABLE("HQ task queue")),
        insufficient(`${d.key}_oldest_backlog_age`, `${d.metricLabel} oldest backlog`, "days", SOURCE_UNAVAILABLE("HQ task queue")),
      );
    }
  } else {
    drainBlocks = [];
    for (const d of DRAIN_ORDER) {
      const q = input.drains[d.key];
      drainBlocks.push({
        key: d.key,
        label: d.label,
        backlog: q.pending,
        inFlight: q.running,
        completed: q.completed,
        failed: q.failed,
      });
      const backlogAge =
        q.oldestPendingAt != null ? daysSince(q.oldestPendingAt, nowMs) : null;
      metrics.push(
        fact(
          `${d.key}_backlog`,
          `${d.metricLabel} backlog`,
          q.pending,
          "int",
          `Pending ${d.label.toLowerCase()} tasks waiting to be worked — the drain's queued backlog.`,
        ),
        fact(
          `${d.key}_in_flight`,
          `${d.metricLabel} in flight`,
          q.running,
          "int",
          `${d.label} tasks running right now.`,
        ),
        fact(
          `${d.key}_failed`,
          `${d.metricLabel} failed`,
          q.failed,
          "int",
          `${d.label} tasks that ended in failure — surfaced honestly as a reliability signal, never hidden.`,
        ),
        backlogAge != null
          ? derived(
              `${d.key}_oldest_backlog_age`,
              `${d.metricLabel} oldest backlog`,
              round1(backlogAge),
              "days",
              `Days the oldest pending ${d.label.toLowerCase()} task has waited — the drain's worst-case latency.`,
            )
          : insufficient(
              `${d.key}_oldest_backlog_age`,
              `${d.metricLabel} oldest backlog`,
              "days",
              `No pending ${d.label.toLowerCase()} tasks, so an oldest-backlog age is undefined (not zero).`,
            ),
      );
    }
  }

  // ── Outreach cadence — the permanent timeline ─────────────────────────
  if (input.cadence == null) {
    metrics.push(
      insufficient("active_outreach_deals", "Active outreach deals", "int", SOURCE_UNAVAILABLE("sales timeline")),
      insufficient("outreach_cadence_health", "Outreach cadence health", "pct", SOURCE_UNAVAILABLE("sales timeline")),
      insufficient("overdue_outreach_deals", "Overdue for a touch", "int", SOURCE_UNAVAILABLE("sales timeline")),
    );
  } else {
    const c = input.cadence;
    metrics.push(
      fact(
        "active_outreach_deals",
        "Active outreach deals",
        c.activeOutreachDeals,
        "int",
        "Open, post-qualification deals expected to be in an active outreach cadence.",
      ),
      c.activeOutreachDeals > 0
        ? derived(
            "outreach_cadence_health",
            "Outreach cadence health",
            round1((c.touchedWithinWindow / c.activeOutreachDeals) * 100),
            "pct",
            `${c.touchedWithinWindow} of ${c.activeOutreachDeals} active outreach deals had an outbound touch within the last ${CADENCE_DAYS} days.`,
          )
        : insufficient(
            "outreach_cadence_health",
            "Outreach cadence health",
            "pct",
            "No active outreach deals, so a cadence health rate is undefined (not zero).",
          ),
      fact(
        "overdue_outreach_deals",
        "Overdue for a touch",
        c.overdue,
        "int",
        `Active outreach deals gone silent beyond ${CADENCE_DAYS} days — the follow-up queue, not a healthy zero.`,
      ),
    );
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "deal_velocity_cohort",
      "Deal velocity (cohort)",
      "days",
      "The schema records a deal's current status and last-change timestamp only — there is no per-stage entry timestamp, so a true stage-dwell / cohort velocity cannot be computed. Average open-deal age is surfaced above as an honest proxy instead.",
    ),
    insufficient(
      "forecast_win_probability",
      "Forecast win probability",
      "pct",
      "There is no win-probability model or predicted close-date field in the schema, so a forecasted win probability cannot be computed and is not fabricated.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    funnel,
    drains: drainBlocks,
  };
}
