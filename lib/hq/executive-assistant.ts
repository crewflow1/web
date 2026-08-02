import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS, isActiveStatus } from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — Executive-Assistant AI, pure "what needs the human" digest
 * (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-executive-assistant.ts`) gathers the raw
 * signals from the EXISTING HQ substrate — open `hq_approvals`, pending/delayed
 * `hq_decisions`, overdue/stalled `hq_ai_tasks`, and the current alert load — and
 * hands a plain `ExecutiveAssistantInput` to `computeExecutiveAssistantBoard`.
 *
 * ── SCOPE: A PURE CROSS-BOARD PROJECTION, NO NEW CAPABILITY ───────────────────
 * The Executive-Assistant owns nothing of its own. It COMPOSES the queues that
 * already exist across HQ into a single prioritised digest answering exactly one
 * question: "what needs the human right now?" Every count it emits is read from a
 * queue another surface already owns — the Approval Engine, the Decision Centre,
 * the generic Task Engine, and the deterministic alerts rules engine. It NEVER
 * decides, approves, executes, or acts; it only surfaces and orders.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/operations.ts) ──────────────────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing queue (open approvals,
 *                proposed decisions, overdue tasks, open alerts). Nothing computed
 *                beyond counting/filtering.
 *   derived      Exact arithmetic over facts (attention alerts = critical +
 *                warning; total items needing the human = the sum across queues;
 *                oldest age). Reproducible from the inputs alone.
 *   insufficient A source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a fabricated
 *                0-as-real.
 *
 * ── THE CRITICAL NUANCE FOR THIS BOARD: EMPTY-READABLE IS A TRUE ZERO ─────────
 * Unlike a deliberately-absent schema source, an EMPTY but READABLE queue here is
 * a legitimate factual zero — "no approvals are waiting" is a real, useful answer
 * ("all clear"), NOT insufficient. So a readable-empty queue emits `fact: 0`, and
 * `insufficient` is reserved for a queue that genuinely could not be READ this
 * cycle (a loud-read failure → the group arrives `null`). A failed read must never
 * render as "all clear": the board's top-level status becomes `insufficient`, not
 * `all_clear`, whenever ANY source was unreadable — even if every readable queue
 * happened to be empty. The one exception to "empty is a fact" is an AGE over an
 * empty set (oldest-open-approval age when there are zero open approvals): an age
 * with no member to measure is undefined, so it is honestly insufficient, while
 * the zero COUNT beside it stays a fact.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (every age/overdue/stall check is measured against the
 * injected clock).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-read state (a failed read, never an empty queue).
// ---------------------------------------------------------------------------

export type ExecutiveAssistantMetricKind = "fact" | "derived" | "insufficient";

export const EXECUTIVE_ASSISTANT_KIND_LABEL: Record<ExecutiveAssistantMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type ExecutiveAssistantFormat = "int" | "days";

/** How urgently an item in the "what needs the human" queue wants attention. */
export type HumanUrgency = "critical" | "high" | "normal";

/** Deterministic rank for the urgency bands (lower = surfaced first). */
const URGENCY_RANK: Record<HumanUrgency, number> = { critical: 0, high: 1, normal: 2 };

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface ExecutiveAssistantMetric {
  key: string;
  /** Display name — "Approvals awaiting review", "Decisions awaiting a call", … */
  label: string;
  kind: ExecutiveAssistantMetricKind;
  /** The figure, or `null` when the source could not be read this cycle. */
  value: number | null;
  format: ExecutiveAssistantFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** One prioritised entry in the "what needs the human now" digest. */
export interface HumanActionItem {
  key: string;
  /** Which queue this draws from — "approvals" | "decisions" | "tasks" | "alerts". */
  source: "approvals" | "decisions" | "tasks" | "alerts";
  /** Display headline — "Approvals escalated for review". */
  label: string;
  /** How many items in this category need the human. Always > 0 (a zero item is omitted). */
  count: number;
  urgency: HumanUrgency;
  /** Days since the oldest item in this category first appeared; null when not age-tracked. */
  oldestAgeDays: number | null;
  /** Plain English: exactly what the human is being asked to do. */
  detail: string;
}

/** The overall digest posture. */
export type ExecutiveAssistantStatus = "all_clear" | "attention" | "insufficient";

export interface ExecutiveAssistantBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: ExecutiveAssistantMetric[];
  /**
   * The headline verdict.
   *   all_clear    every queue was readable AND every actionable count is zero.
   *   attention    at least one item needs the human now (needsHuman is non-empty).
   *   insufficient no item needs the human among the READABLE queues, but at least
   *                one queue could not be read — so "all clear" cannot be claimed.
   */
  summary: {
    status: ExecutiveAssistantStatus;
    /** Total items needing the human across the readable queues. */
    itemsNeedingHuman: number;
    /** Names of the queues that could not be read this cycle (loud-read failures). */
    unreadableSources: ReadonlyArray<string>;
  };
  /**
   * The prioritised "what needs the human now" list — deterministic ordering:
   * urgency band, then oldest-age (older first), then count (more first), then key.
   * Empty when everything readable is clear.
   */
  needsHuman: ReadonlyArray<HumanActionItem>;
  /** Open-approval load. Null when the approvals source could not be read this cycle. */
  approvalLoad: {
    pending: number;
    escalated: number;
    total: number;
    oldestAgeDays: number | null;
  } | null;
  /** Decision-queue load. Null when the decisions source could not be read this cycle. */
  decisionLoad: {
    awaiting: number;
    delayed: number;
    delayedDue: number;
    total: number;
    oldestAgeDays: number | null;
  } | null;
  /** Task-queue attention load. Null when the tasks source could not be read this cycle. */
  taskLoad: {
    overdue: number;
    stalled: number;
    total: number;
    oldestOverdueAgeDays: number | null;
    /** Overdue tasks grouped by product pipeline stage (ordered; only non-empty stages). */
    byStage: ReadonlyArray<{ stage: string; label: string; count: number }>;
  } | null;
  /** Alert load by severity. Null when the alerts source could not be read this cycle. */
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
// EXISTING queue by the aggregator. A group is `null` when its source could not
// be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`. A group present but EMPTY is a true zero (an empty queue is a
// real answer here), NOT insufficient.
// ---------------------------------------------------------------------------

/** One open approval, reduced to the two fields the digest needs. */
export interface ExecutiveAssistantApprovalRow {
  /** Open-state only: 'pending' or 'escalated' (the aggregator filters terminals out). */
  state: "pending" | "escalated";
  /** ISO timestamp the approval was requested (hq_approvals.requested_at). */
  requestedAt: string;
}

export interface ExecutiveAssistantApprovalsInput {
  approvals: ReadonlyArray<ExecutiveAssistantApprovalRow>;
}

/** One decision that still needs the human, reduced to the fields the digest needs. */
export interface ExecutiveAssistantDecisionRow {
  /** 'proposed' (awaiting a call) or 'delayed' (parked for revisit). */
  status: "proposed" | "delayed";
  /** ISO timestamp the decision was raised (hq_decisions.created_at). */
  createdAt: string;
  /** ISO date to revisit — only meaningful for 'delayed' rows. */
  delayUntil: string | null;
}

export interface ExecutiveAssistantDecisionsInput {
  decisions: ReadonlyArray<ExecutiveAssistantDecisionRow>;
}

/** One non-terminal task, reduced to the fields the overdue/stall checks need. */
export interface ExecutiveAssistantTaskRow {
  /** hq_ai_tasks execution status (aggregator passes active rows only). */
  status: string;
  /** SLA/Health seam — the task's deadline (hq_ai_tasks.deadline_at). */
  deadlineAt: string | null;
  /** Worker lease expiry (hq_ai_tasks.lease_expires_at). */
  leaseExpiresAt: string | null;
  /** Last worker heartbeat (hq_ai_tasks.heartbeat_at). */
  heartbeatAt: string | null;
  /** Product pipeline stage, or null when unstaged (hq_ai_tasks.pipeline_stage). */
  pipelineStage: string | null;
}

export interface ExecutiveAssistantTasksInput {
  tasks: ReadonlyArray<ExecutiveAssistantTaskRow>;
}

/** One open alert, reduced to the two fields the digest buckets. */
export interface ExecutiveAssistantAlertRow {
  severity: "critical" | "warning" | "info";
  /** ISO timestamp the underlying condition fired (Alert.occurredAt). */
  occurredAt: string;
}

export interface ExecutiveAssistantAlertsInput {
  alerts: ReadonlyArray<ExecutiveAssistantAlertRow>;
}

export interface ExecutiveAssistantInput {
  approvals: ExecutiveAssistantApprovalsInput | null;
  decisions: ExecutiveAssistantDecisionsInput | null;
  tasks: ExecutiveAssistantTasksInput | null;
  alerts: ExecutiveAssistantAlertsInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: ExecutiveAssistantFormat,
  basis: string,
): ExecutiveAssistantMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: ExecutiveAssistantFormat,
  basis: string,
): ExecutiveAssistantMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: ExecutiveAssistantFormat,
  basis: string,
): ExecutiveAssistantMetric {
  return { key, label, kind: "insufficient", value: null, format, basis };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** A running task with no heartbeat for this long reads as STALLED. Mirrors the boardroom band. */
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero — this board never renders "all clear" over a failed read.`;

/** Whole days between an ISO stamp and `now`, clamped at 0 (never a negative age). */
function ageDays(iso: string, nowMs: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/** The oldest (largest) age among a set of ISO stamps; null when the set is empty. */
function oldestAge(isos: ReadonlyArray<string>, nowMs: number): number | null {
  let oldest: number | null = null;
  for (const iso of isos) {
    const age = ageDays(iso, nowMs);
    if (age != null && (oldest == null || age > oldest)) oldest = age;
  }
  return oldest;
}

// ---------------------------------------------------------------------------
// Folds — one per queue, each turning the lean rows into the counts + ages the
// board surfaces.
// ---------------------------------------------------------------------------

interface ApprovalFold {
  pending: number;
  escalated: number;
  total: number;
  oldestAgeDays: number | null;
}

function foldApprovals(rows: ReadonlyArray<ExecutiveAssistantApprovalRow>, nowMs: number): ApprovalFold {
  let pending = 0;
  let escalated = 0;
  for (const r of rows) {
    if (r.state === "escalated") escalated += 1;
    else pending += 1;
  }
  return {
    pending,
    escalated,
    total: pending + escalated,
    oldestAgeDays: oldestAge(rows.map((r) => r.requestedAt), nowMs),
  };
}

interface DecisionFold {
  awaiting: number;
  delayed: number;
  delayedDue: number;
  total: number;
  oldestAgeDays: number | null;
}

function foldDecisions(rows: ReadonlyArray<ExecutiveAssistantDecisionRow>, nowMs: number): DecisionFold {
  let awaiting = 0;
  let delayed = 0;
  let delayedDue = 0;
  for (const r of rows) {
    if (r.status === "delayed") {
      delayed += 1;
      // A parked decision becomes actionable again once its revisit date has passed.
      if (r.delayUntil) {
        const due = Date.parse(r.delayUntil);
        if (!Number.isNaN(due) && due <= nowMs) delayedDue += 1;
      }
    } else {
      awaiting += 1;
    }
  }
  return {
    awaiting,
    delayed,
    delayedDue,
    total: awaiting + delayed,
    oldestAgeDays: oldestAge(rows.map((r) => r.createdAt), nowMs),
  };
}

interface TaskFold {
  overdue: number;
  stalled: number;
  total: number;
  oldestOverdueAgeDays: number | null;
  byStage: Array<{ stage: string; label: string; count: number }>;
}

/** Is this active task past its deadline? */
function isOverdue(t: ExecutiveAssistantTaskRow, nowMs: number): boolean {
  if (!isActiveStatus(t.status) || !t.deadlineAt) return false;
  const ms = Date.parse(t.deadlineAt);
  return !Number.isNaN(ms) && ms < nowMs;
}

/** Is this a running task whose worker has stalled (lease expired or heartbeat gone quiet)? */
function isStalled(t: ExecutiveAssistantTaskRow, nowMs: number): boolean {
  if (t.status !== "running") return false;
  if (t.leaseExpiresAt) {
    const exp = Date.parse(t.leaseExpiresAt);
    if (!Number.isNaN(exp) && exp < nowMs) return true;
  }
  if (t.heartbeatAt) {
    const hb = Date.parse(t.heartbeatAt);
    if (!Number.isNaN(hb) && nowMs - hb >= HEARTBEAT_STALE_MS) return true;
  }
  return false;
}

function foldTasks(rows: ReadonlyArray<ExecutiveAssistantTaskRow>, nowMs: number): TaskFold {
  let overdue = 0;
  let stalled = 0;
  const overdueDeadlines: string[] = [];
  const stageCounts = new Map<string, number>();

  for (const t of rows) {
    if (isOverdue(t, nowMs)) {
      overdue += 1;
      if (t.deadlineAt) overdueDeadlines.push(t.deadlineAt);
      const stage = t.pipelineStage && t.pipelineStage.trim() !== "" ? t.pipelineStage : "unstaged";
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    }
    if (isStalled(t, nowMs)) stalled += 1;
  }

  // Deterministic stage order: pipeline order first, then "unstaged" last.
  const byStage: Array<{ stage: string; label: string; count: number }> = [];
  for (const stage of PIPELINE_STAGES) {
    const count = stageCounts.get(stage);
    if (count) byStage.push({ stage, label: PIPELINE_STAGE_LABELS[stage], count });
  }
  const unstaged = stageCounts.get("unstaged");
  if (unstaged) byStage.push({ stage: "unstaged", label: "Unstaged", count: unstaged });

  return {
    overdue,
    stalled,
    total: overdue + stalled,
    oldestOverdueAgeDays: oldestAge(overdueDeadlines, nowMs),
    byStage,
  };
}

interface AlertFold {
  critical: number;
  warning: number;
  info: number;
  total: number;
  oldestAgeDays: number | null;
}

function foldAlerts(rows: ReadonlyArray<ExecutiveAssistantAlertRow>, nowMs: number): AlertFold {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const a of rows) {
    if (a.severity === "critical") critical += 1;
    else if (a.severity === "warning") warning += 1;
    else info += 1;
  }
  return {
    critical,
    warning,
    info,
    total: rows.length,
    oldestAgeDays: oldestAge(rows.map((a) => a.occurredAt), nowMs),
  };
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeExecutiveAssistantBoard(
  input: ExecutiveAssistantInput,
  now: Date,
): ExecutiveAssistantBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: ExecutiveAssistantMetric[] = [];
  const needsHuman: HumanActionItem[] = [];
  const unreadableSources: string[] = [];

  // ── Approvals — the review queue (pending + escalated) ─────────────────
  let approvalLoad: ExecutiveAssistantBoard["approvalLoad"] = null;
  if (input.approvals == null) {
    unreadableSources.push("open approvals");
    metrics.push(
      insufficient("approvals_pending", "Approvals awaiting review", "int", SOURCE_UNAVAILABLE("open approvals")),
      insufficient("approvals_escalated", "Approvals escalated", "int", SOURCE_UNAVAILABLE("open approvals")),
      insufficient("approvals_open_total", "Open approvals", "int", SOURCE_UNAVAILABLE("open approvals")),
      insufficient("approvals_oldest_age", "Oldest open approval age", "days", SOURCE_UNAVAILABLE("open approvals")),
    );
  } else {
    const a = foldApprovals(input.approvals.approvals, nowMs);
    approvalLoad = { pending: a.pending, escalated: a.escalated, total: a.total, oldestAgeDays: a.oldestAgeDays };
    metrics.push(
      fact(
        "approvals_pending",
        "Approvals awaiting review",
        a.pending,
        "int",
        "AI-proposed actions sitting in the Approval Engine at 'pending', waiting for a human decision.",
      ),
      fact(
        "approvals_escalated",
        "Approvals escalated",
        a.escalated,
        "int",
        "Open approvals a reviewer has flagged for higher attention ('escalated') — the sharpest end of the review queue.",
      ),
      fact(
        "approvals_open_total",
        "Open approvals",
        a.total,
        "int",
        "All open approvals (pending + escalated) awaiting a human across every AI employee.",
      ),
      a.total > 0 && a.oldestAgeDays != null
        ? fact(
            "approvals_oldest_age",
            "Oldest open approval age",
            a.oldestAgeDays,
            "days",
            "Days since the oldest still-open approval was requested.",
          )
        : insufficient(
            "approvals_oldest_age",
            "Oldest open approval age",
            "days",
            "No open approvals, so there is no aging to measure (a true 'all clear', not a fabricated zero).",
          ),
    );
    if (a.escalated > 0) {
      needsHuman.push({
        key: "approvals_escalated",
        source: "approvals",
        label: "Approvals escalated for review",
        count: a.escalated,
        urgency: "critical",
        oldestAgeDays: oldestAge(
          input.approvals.approvals.filter((r) => r.state === "escalated").map((r) => r.requestedAt),
          nowMs,
        ),
        detail: "A reviewer flagged these for higher attention — decide them first.",
      });
    }
    if (a.pending > 0) {
      needsHuman.push({
        key: "approvals_pending",
        source: "approvals",
        label: "Approvals awaiting a decision",
        count: a.pending,
        urgency: "high",
        oldestAgeDays: oldestAge(
          input.approvals.approvals.filter((r) => r.state === "pending").map((r) => r.requestedAt),
          nowMs,
        ),
        detail: "AI employees are blocked on these until a human approves, edits, or rejects.",
      });
    }
  }

  // ── Decisions — the strategic queue (proposed + delayed) ───────────────
  let decisionLoad: ExecutiveAssistantBoard["decisionLoad"] = null;
  if (input.decisions == null) {
    unreadableSources.push("pending decisions");
    metrics.push(
      insufficient("decisions_awaiting", "Decisions awaiting a call", "int", SOURCE_UNAVAILABLE("pending decisions")),
      insufficient("decisions_delayed", "Decisions parked (delayed)", "int", SOURCE_UNAVAILABLE("pending decisions")),
      insufficient("decisions_delayed_due", "Delayed decisions now due", "int", SOURCE_UNAVAILABLE("pending decisions")),
      insufficient("decisions_oldest_age", "Oldest awaiting decision age", "days", SOURCE_UNAVAILABLE("pending decisions")),
    );
  } else {
    const d = foldDecisions(input.decisions.decisions, nowMs);
    decisionLoad = {
      awaiting: d.awaiting,
      delayed: d.delayed,
      delayedDue: d.delayedDue,
      total: d.total,
      oldestAgeDays: d.oldestAgeDays,
    };
    metrics.push(
      fact(
        "decisions_awaiting",
        "Decisions awaiting a call",
        d.awaiting,
        "int",
        "Strategic decisions in the Decision Centre at 'proposed', awaiting approve / reject / delay / delegate.",
      ),
      fact(
        "decisions_delayed",
        "Decisions parked (delayed)",
        d.delayed,
        "int",
        "Decisions a human parked for later ('delayed') — not lost, scheduled to revisit.",
      ),
      fact(
        "decisions_delayed_due",
        "Delayed decisions now due",
        d.delayedDue,
        "int",
        "Parked decisions whose revisit date has passed — actionable again, not still on hold.",
      ),
      d.awaiting > 0 && d.oldestAgeDays != null
        ? fact(
            "decisions_oldest_age",
            "Oldest awaiting decision age",
            d.oldestAgeDays,
            "days",
            "Days since the oldest decision still needing the human was raised.",
          )
        : insufficient(
            "decisions_oldest_age",
            "Oldest awaiting decision age",
            "days",
            "No decisions are awaiting a call, so there is no aging to measure (a true 'all clear', not a fabricated zero).",
          ),
    );
    if (d.delayedDue > 0) {
      needsHuman.push({
        key: "decisions_delayed_due",
        source: "decisions",
        label: "Parked decisions now due to revisit",
        count: d.delayedDue,
        urgency: "high",
        oldestAgeDays: oldestAge(
          input.decisions.decisions
            .filter((r) => r.status === "delayed" && r.delayUntil != null)
            .map((r) => r.createdAt),
          nowMs,
        ),
        detail: "Their revisit date has passed — bring them back to the Decision Centre.",
      });
    }
    if (d.awaiting > 0) {
      needsHuman.push({
        key: "decisions_awaiting",
        source: "decisions",
        label: "Decisions awaiting a call",
        count: d.awaiting,
        urgency: "high",
        oldestAgeDays: oldestAge(
          input.decisions.decisions.filter((r) => r.status === "proposed").map((r) => r.createdAt),
          nowMs,
        ),
        detail: "Proposed strategic decisions need a human to approve, reject, delay, or delegate.",
      });
    }
  }

  // ── Tasks — overdue against SLA + stalled workers ──────────────────────
  let taskLoad: ExecutiveAssistantBoard["taskLoad"] = null;
  if (input.tasks == null) {
    unreadableSources.push("AI tasks");
    metrics.push(
      insufficient("tasks_overdue", "Tasks overdue", "int", SOURCE_UNAVAILABLE("AI tasks")),
      insufficient("tasks_stalled", "Tasks stalled", "int", SOURCE_UNAVAILABLE("AI tasks")),
      insufficient("tasks_oldest_overdue_age", "Oldest overdue task age", "days", SOURCE_UNAVAILABLE("AI tasks")),
    );
  } else {
    const t = foldTasks(input.tasks.tasks, nowMs);
    taskLoad = {
      overdue: t.overdue,
      stalled: t.stalled,
      total: t.total,
      oldestOverdueAgeDays: t.oldestOverdueAgeDays,
      byStage: t.byStage,
    };
    metrics.push(
      fact(
        "tasks_overdue",
        "Tasks overdue",
        t.overdue,
        "int",
        "Active tasks past their deadline (deadline_at) — the AI is behind SLA and may need a human to unblock or re-scope.",
      ),
      fact(
        "tasks_stalled",
        "Tasks stalled",
        t.stalled,
        "int",
        "Running tasks whose worker has gone quiet (lease expired or no heartbeat for 15+ minutes) — likely stuck, not progressing.",
      ),
      t.overdue > 0 && t.oldestOverdueAgeDays != null
        ? fact(
            "tasks_oldest_overdue_age",
            "Oldest overdue task age",
            t.oldestOverdueAgeDays,
            "days",
            "Days since the most overdue task's deadline passed.",
          )
        : insufficient(
            "tasks_oldest_overdue_age",
            "Oldest overdue task age",
            "days",
            "No overdue tasks, so there is no overrun to measure (a true 'all clear', not a fabricated zero).",
          ),
    );
    if (t.stalled > 0) {
      needsHuman.push({
        key: "tasks_stalled",
        source: "tasks",
        label: "Tasks stalled (worker gone quiet)",
        count: t.stalled,
        urgency: "critical",
        oldestAgeDays: null,
        detail: "Running tasks with an expired lease or dead heartbeat — check whether the worker died.",
      });
    }
    if (t.overdue > 0) {
      needsHuman.push({
        key: "tasks_overdue",
        source: "tasks",
        label: "Tasks overdue against deadline",
        count: t.overdue,
        urgency: "high",
        oldestAgeDays: t.oldestOverdueAgeDays,
        detail: "Active tasks past their deadline — unblock, re-scope, or accept the slip.",
      });
    }
  }

  // ── Alerts — the deterministic HQ rules engine ─────────────────────────
  let alertLoad: ExecutiveAssistantBoard["alertLoad"] = null;
  if (input.alerts == null) {
    unreadableSources.push("HQ alerts");
    metrics.push(
      insufficient("alerts_critical", "Open alerts (critical)", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_warning", "Open alerts (warning)", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_attention", "Alerts needing attention", "int", SOURCE_UNAVAILABLE("HQ alerts")),
      insufficient("alerts_oldest_age", "Oldest open alert age", "days", SOURCE_UNAVAILABLE("HQ alerts")),
    );
  } else {
    const al = foldAlerts(input.alerts.alerts, nowMs);
    alertLoad = { critical: al.critical, warning: al.warning, info: al.info, total: al.total, oldestAgeDays: al.oldestAgeDays };
    const attention = al.critical + al.warning;
    metrics.push(
      fact(
        "alerts_critical",
        "Open alerts (critical)",
        al.critical,
        "int",
        "Critical-severity alerts the deterministic HQ rules engine currently fires (failed payment, migration stalled, urgent support, …).",
      ),
      fact(
        "alerts_warning",
        "Open alerts (warning)",
        al.warning,
        "int",
        "Warning-severity alerts currently firing (setup fee unpaid, low usage, trial ending, …).",
      ),
      derived(
        "alerts_attention",
        "Alerts needing attention",
        attention,
        "int",
        `${al.critical} critical + ${al.warning} warning alerts need operator attention (info-level events excluded).`,
      ),
      al.total > 0 && al.oldestAgeDays != null
        ? fact(
            "alerts_oldest_age",
            "Oldest open alert age",
            al.oldestAgeDays,
            "days",
            "Days since the oldest currently-open alert's condition first fired.",
          )
        : insufficient(
            "alerts_oldest_age",
            "Oldest open alert age",
            "days",
            "No open alerts, so there is no aging to measure (a true 'all clear', not a fabricated zero).",
          ),
    );
    if (al.critical > 0) {
      needsHuman.push({
        key: "alerts_critical",
        source: "alerts",
        label: "Critical alerts firing",
        count: al.critical,
        urgency: "critical",
        oldestAgeDays: oldestAge(
          input.alerts.alerts.filter((a) => a.severity === "critical").map((a) => a.occurredAt),
          nowMs,
        ),
        detail: "The rules engine is flagging critical conditions across the estate — triage now.",
      });
    }
    if (al.warning > 0) {
      needsHuman.push({
        key: "alerts_warning",
        source: "alerts",
        label: "Warning alerts firing",
        count: al.warning,
        urgency: "normal",
        oldestAgeDays: oldestAge(
          input.alerts.alerts.filter((a) => a.severity === "warning").map((a) => a.occurredAt),
          nowMs,
        ),
        detail: "Warning-level conditions worth a look before they escalate.",
      });
    }
  }

  // ── The prioritised digest — deterministic ordering ────────────────────
  // urgency band, then oldest-age (older first; unknown age sorts last within a
  // band), then count (more first), then key (stable tiebreak).
  needsHuman.sort((x, y) => {
    const byUrgency = URGENCY_RANK[x.urgency] - URGENCY_RANK[y.urgency];
    if (byUrgency !== 0) return byUrgency;
    const ax = x.oldestAgeDays ?? -1;
    const ay = y.oldestAgeDays ?? -1;
    if (ax !== ay) return ay - ax;
    if (x.count !== y.count) return y.count - x.count;
    return x.key.localeCompare(y.key);
  });

  const itemsNeedingHuman = needsHuman.reduce((sum, i) => sum + i.count, 0);

  // ── The "items needing the human" roll-up metric ───────────────────────
  // Derived over the READABLE queues. Insufficient only when nothing was readable
  // at all — a partial read still yields an honest sum over what we could see.
  const anyReadable =
    input.approvals != null || input.decisions != null || input.tasks != null || input.alerts != null;
  metrics.push(
    anyReadable
      ? derived(
          "items_needing_human",
          "Items needing the human",
          itemsNeedingHuman,
          "int",
          unreadableSources.length === 0
            ? "Sum of every open item across the four queues (approvals, decisions, tasks, alerts) that needs a human now."
            : `Sum across the READABLE queues only; ${unreadableSources.join(", ")} could not be read this cycle and are excluded (so this is a floor, not a total).`,
        )
      : insufficient(
          "items_needing_human",
          "Items needing the human",
          "int",
          "No queue could be read this cycle, so the number of items needing a human cannot be computed — the board never claims 'all clear' over a total read failure.",
        ),
  );

  // ── The headline verdict ───────────────────────────────────────────────
  // A failed read NEVER renders as all_clear: with any unreadable source and no
  // pending items, the status is insufficient, not all_clear.
  const status: ExecutiveAssistantStatus =
    itemsNeedingHuman > 0
      ? "attention"
      : unreadableSources.length > 0
        ? "insufficient"
        : "all_clear";

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    summary: { status, itemsNeedingHuman, unreadableSources },
    needsHuman,
    approvalLoad,
    decisionLoad,
    taskLoad,
    alertLoad,
  };
}
