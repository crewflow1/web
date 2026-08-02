import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import {
  deriveHealth,
  isActiveStatus,
  type BoardroomTask,
  type HealthCard,
} from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — QA AI, pure AI-quality / reliability board compute (super-admin
 * surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-qa.ts`) gathers the raw quality signals from
 * the EXISTING read models — the executor-shadow store (what the AI executor
 * WOULD have done, divergence/error), the AI-reply audit ledger
 * (`ai_reply_audits` verdicts: accepted `allow` vs held `review` vs refused
 * `block`), the conversation-outcome ledger, and the `hq_ai_tasks` queue (task
 * failure / retry pressure) — and hands a plain `QaInput` to `computeQaBoard`.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/finance.ts & lib/hq/cto.ts) ──────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (shadow
 *                observations, audited replies, recorded outcomes, stale leases).
 *                Nothing computed beyond counting.
 *   derived      Exact arithmetic over facts (reply acceptance rate =
 *                allow ÷ audited; shadow divergence rate = (refused+error) ÷
 *                observations). Reproducible from the inputs alone.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction. Traditional QA telemetry —
 * browser / regression / end-to-end test results, accessibility-audit scores, and
 * release-approval sign-off — has NO source table anywhere in the schema. There is
 * no CI-run table, no test-results table, no a11y-audit table, and no
 * release-approval table. Those signals are therefore ALWAYS `insufficient` on
 * this board — they carry no input field at all and are emitted as honest no-data
 * cards, not invented pass rates. When a real source lands it becomes a new
 * `QaInput` field and the SAME code computes a real figure; until then the board
 * refuses to guess.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (the reliability-health idiom is reused from
 * lib/hq/boardroom-cards, which is itself `now`-injected).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type QaMetricKind = "fact" | "derived" | "insufficient";

export const QA_KIND_LABEL: Record<QaMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type QaFormat = "int" | "pct";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface QaMetric {
  key: string;
  /** Display name — "Reply acceptance rate", "Shadow divergence rate", … */
  label: string;
  kind: QaMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: QaFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

export interface QaBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: QaMetric[];
  /**
   * The estate-wide reliability health card, reusing the boardroom-cards
   * `deriveHealth` idiom over the recent `hq_ai_tasks` window (stalled leases,
   * stale heartbeats, retry pressure, failure ratio). Null when the queue could
   * not be read this cycle. Its own `level` is `insufficient` when the window is
   * empty — never a green card conjured from absent data.
   */
  reliabilityHealth: HealthCard | null;
  /**
   * The AI-reply verdict breakdown, surfaced as its own view so the page can
   * show the accepted / held / refused split rather than only the derived rates.
   * Null when the reply-audit source could not be read this cycle.
   */
  replyQuality: {
    total: number;
    /** Clean `allow` verdicts — auto-sendable, accepted. */
    allow: number;
    /** `review` verdicts — held for human review (escalated). */
    review: number;
    /** `block` verdicts — refused by the guardrail. */
    block: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** Executor-shadow outcome totals, from `getExecutorShadowFeed().totals`. */
export interface QaShadowInput {
  planned: number;
  refused: number;
  error: number;
}

/**
 * AI-reply verdict totals, from the `ai_reply_audits` ledger. Each audited reply
 * carries exactly one guardrail verdict: `allow` (accepted, auto-sendable),
 * `review` (held for a human), or `block` (refused).
 */
export interface QaReplyInput {
  allow: number;
  review: number;
  block: number;
}

/** Conversation-outcome totals, from the `receptionist_conversation_outcomes` ledger. */
export interface QaOutcomeInput {
  /**
   * Count of recorded outcome rows. The ledger's `status` is CHECK-pinned to
   * `recorded`, so the schema records NO accepted/failed/escalated split for a
   * conversation outcome — only that one was resolved and filed.
   */
  recorded: number;
}

/** Reliability signal — a lean window of recent `hq_ai_tasks` rows. */
export interface QaReliabilityInput {
  tasks: ReadonlyArray<BoardroomTask>;
}

export interface QaInput {
  shadow: QaShadowInput | null;
  reply: QaReplyInput | null;
  outcome: QaOutcomeInput | null;
  reliability: QaReliabilityInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: QaFormat,
  basis: string,
): QaMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: QaFormat,
  basis: string,
): QaMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: QaFormat,
  basis: string,
): QaMetric {
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

/** The absent-schema basis — a signal that has no source table at all. */
const NO_SCHEMA_SOURCE = (what: string) =>
  `No ${what} table exists in the schema; it cannot be computed from any stored data and is not fabricated.`;

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

export function computeQaBoard(input: QaInput, now: Date): QaBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: QaMetric[] = [];

  // ── Executor-shadow divergence (AI-execution quality) ─────────────────
  if (input.shadow == null) {
    metrics.push(
      insufficient("shadow_observations", "Shadow observations", "int", SOURCE_UNAVAILABLE("executor-shadow")),
      insufficient("shadow_divergence_rate", "Shadow divergence rate", "pct", SOURCE_UNAVAILABLE("executor-shadow")),
      insufficient("shadow_error_rate", "Shadow error rate", "pct", SOURCE_UNAVAILABLE("executor-shadow")),
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
        "Executor-shadow observations recorded (what the AI executor WOULD have done; execution still dark).",
      ),
      total > 0
        ? derived(
            "shadow_divergence_rate",
            "Shadow divergence rate",
            round1((diverged / total) * 100),
            "pct",
            `${input.shadow.refused} refused + ${input.shadow.error} errored of ${total} shadow observations.`,
          )
        : insufficient(
            "shadow_divergence_rate",
            "Shadow divergence rate",
            "pct",
            "No executor-shadow observations recorded yet, so there is no divergence rate to measure.",
          ),
      total > 0
        ? derived(
            "shadow_error_rate",
            "Shadow error rate",
            round1((input.shadow.error / total) * 100),
            "pct",
            `${input.shadow.error} errored of ${total} shadow observations (a hard failure, not a clean refusal).`,
          )
        : insufficient(
            "shadow_error_rate",
            "Shadow error rate",
            "pct",
            "No executor-shadow observations recorded yet, so there is no error rate to measure.",
          ),
    );
  }

  // ── AI-reply quality (ai_reply_audits verdicts) ───────────────────────
  if (input.reply == null) {
    metrics.push(
      insufficient("reply_audits", "Replies audited", "int", SOURCE_UNAVAILABLE("AI-reply audit ledger")),
      insufficient("reply_acceptance_rate", "Reply acceptance rate", "pct", SOURCE_UNAVAILABLE("AI-reply audit ledger")),
      insufficient("reply_review_rate", "Reply review rate", "pct", SOURCE_UNAVAILABLE("AI-reply audit ledger")),
      insufficient("reply_block_rate", "Reply block rate", "pct", SOURCE_UNAVAILABLE("AI-reply audit ledger")),
    );
  } else {
    const total = input.reply.allow + input.reply.review + input.reply.block;
    if (total > 0) {
      metrics.push(
        fact(
          "reply_audits",
          "Replies audited",
          total,
          "int",
          "AI-drafted replies with a recorded guardrail verdict in the recent window (ai_reply_audits).",
        ),
        derived(
          "reply_acceptance_rate",
          "Reply acceptance rate",
          round1((input.reply.allow / total) * 100),
          "pct",
          `${input.reply.allow} clean 'allow' (auto-sendable) verdicts of ${total} audited replies.`,
        ),
        derived(
          "reply_review_rate",
          "Reply review rate",
          round1((input.reply.review / total) * 100),
          "pct",
          `${input.reply.review} held for human review ('review', escalated) of ${total} audited replies.`,
        ),
        derived(
          "reply_block_rate",
          "Reply block rate",
          round1((input.reply.block / total) * 100),
          "pct",
          `${input.reply.block} refused by the guardrail ('block') of ${total} audited replies.`,
        ),
      );
    } else {
      metrics.push(
        fact(
          "reply_audits",
          "Replies audited",
          0,
          "int",
          "No AI-drafted replies have been audited yet — an empty ledger, honestly zero.",
        ),
        insufficient(
          "reply_acceptance_rate",
          "Reply acceptance rate",
          "pct",
          "No audited replies in the window, so an acceptance rate is undefined.",
        ),
        insufficient(
          "reply_review_rate",
          "Reply review rate",
          "pct",
          "No audited replies in the window, so a review rate is undefined.",
        ),
        insufficient(
          "reply_block_rate",
          "Reply block rate",
          "pct",
          "No audited replies in the window, so a block rate is undefined.",
        ),
      );
    }
  }

  // ── Conversation outcomes ─────────────────────────────────────────────
  if (input.outcome == null) {
    metrics.push(
      insufficient("conversation_outcomes", "Conversation outcomes recorded", "int", SOURCE_UNAVAILABLE("conversation-outcome ledger")),
    );
  } else {
    metrics.push(
      fact(
        "conversation_outcomes",
        "Conversation outcomes recorded",
        input.outcome.recorded,
        "int",
        "Resolved conversation outcomes filed to the ledger. The ledger's status is pinned to 'recorded', so the schema records no accepted/failed split — only that an outcome was resolved.",
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

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  // Traditional QA telemetry has NO source table in the schema. These carry no
  // QaInput field and are emitted insufficient by construction.
  metrics.push(
    insufficient(
      "regression_test_pass_rate",
      "Regression test pass rate",
      "pct",
      NO_SCHEMA_SOURCE("test-results / CI-run"),
    ),
    insufficient(
      "browser_test_pass_rate",
      "Browser test pass rate",
      "pct",
      NO_SCHEMA_SOURCE("end-to-end / browser-test-results"),
    ),
    insufficient(
      "a11y_audit_score",
      "Accessibility audit score",
      "pct",
      NO_SCHEMA_SOURCE("accessibility-audit"),
    ),
    insufficient(
      "release_approval",
      "Releases approved",
      "int",
      NO_SCHEMA_SOURCE("release-approval / sign-off"),
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    reliabilityHealth:
      input.reliability == null ? null : deriveHealth(input.reliability.tasks, now),
    replyQuality:
      input.reply == null
        ? null
        : {
            total: input.reply.allow + input.reply.review + input.reply.block,
            allow: input.reply.allow,
            review: input.reply.review,
            block: input.reply.block,
          },
  };
}
