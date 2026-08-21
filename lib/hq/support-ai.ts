import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABEL,
  isActiveStatus,
  type SupportCategory,
  type SupportPriority,
} from "@/lib/hq/support";

/**
 * CrewFlow HQ — SUPPORT AI, pure triage board compute (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-support-ai.ts`) gathers the raw ticket rows
 * from the existing HQ support snapshot and hands a plain `SupportBoardInput`
 * to `computeSupportBoard` here.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/finance.ts) ─────────────────────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from the ticket records (open tickets =
 *                active rows, total tickets). Nothing computed beyond counting
 *                rows.
 *   derived      Exact arithmetic/bucketing over facts (aging buckets, SLA
 *                breaches, oldest-open age, top-category share, unmeasurable
 *                count). Reproducible from the inputs + injected `now` alone.
 *   insufficient The input this figure needs DOES NOT EXIST. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real. With ZERO tickets on record there is
 *                nothing to triage, so EVERY metric is insufficient (an empty
 *                queue is an absence of records, not a measured zero). With
 *                tickets present but NONE active, the queue-shape figures
 *                (oldest-open age, top-category share) are insufficient because
 *                there is no open ticket to measure — while the aging/breach
 *                COUNTS are honest derived zeros, since we genuinely measured
 *                the records and found none breaching.
 *
 * A metric with no source is a first-class honest answer, not a crash and not a
 * zero. `now` is injected so the layer is deterministic and replayable — there
 * is no wall-clock read here.
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type SupportMetricKind = "fact" | "derived" | "insufficient";

export const SUPPORT_KIND_LABEL: Record<SupportMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type SupportMetricFormat = "int" | "hours" | "pct";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors
 * and asserted in the tests).
 */
export interface SupportMetric {
  key: string;
  /** Display name — "Open tickets", "SLA breaches", … */
  label: string;
  kind: SupportMetricKind;
  /** The figure, or `null` when the source does not exist. */
  value: number | null;
  format: SupportMetricFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** A single row of the priority / category distribution over ACTIVE tickets. */
export interface SupportBreakdown {
  /** The priority or category value (e.g. "urgent", "billing"). */
  key: string;
  /** Human label. */
  label: string;
  /** Active tickets in this bucket. */
  count: number;
  /** Percentage of active tickets in this bucket (0 to 100, one decimal). */
  share: number;
}

export interface SupportBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: SupportMetric[];
  /** Distribution of ACTIVE tickets by priority (canonical order). */
  priorityMix: SupportBreakdown[];
  /**
   * Distribution of ACTIVE tickets by category, sorted busiest-first — the
   * recurring-theme signal. Empty when nothing is active.
   */
  categoryMix: SupportBreakdown[];
}

// ---------------------------------------------------------------------------
// Input — the raw ticket rows the board triages over. The pure layer computes
// EVERYTHING (including the open-ticket count) from these rows, so no figure can
// disagree with another and no swallowed head-count error can manufacture a
// zero: the open count IS the number of active rows we were handed.
// ---------------------------------------------------------------------------

/** The subset of a ticket row the triage needs. Client/server-safe. */
export interface SupportBoardTicket {
  status: string;
  priority: string;
  category: string;
  /** ISO timestamp the ticket was created. The aging/SLA clock start. */
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  lastReplyAt: string | null;
  lastReplyKind: "customer" | "hq" | null;
}

export interface SupportBoardInput {
  tickets: ReadonlyArray<SupportBoardTicket>;
}

// ---------------------------------------------------------------------------
// SLA policy — resolution-target hours per priority. Data, so a reviewer can
// see (and change) the promise in one place; the breach count is derived from
// it deterministically.
// ---------------------------------------------------------------------------

export const SUPPORT_SLA_HOURS: Record<SupportPriority, number> = {
  urgent: 4,
  high: 24,
  normal: 72,
  low: 168, // 7 days
};

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: SupportMetricFormat,
  basis: string,
): SupportMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: SupportMetricFormat,
  basis: string,
): SupportMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: SupportMetricFormat,
  basis: string,
): SupportMetric {
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

/**
 * Hours between `now` and an ISO timestamp, or `null` when the timestamp is
 * missing/malformed. Returning `null` (never 0) is the whole point: a broken
 * `createdAt` must NOT read as a brand-new ticket that silently never ages and
 * never breaches SLA. Callers exclude the nulls from aging/SLA and surface the
 * count as the `unmeasurable` data-quality signal instead.
 */
function hoursSinceOrNull(now: Date, iso: string): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

/** The "no tickets at all" board — every metric insufficient, mixes empty. */
const NO_TICKETS_BASIS =
  "No support tickets exist on record yet, so there is nothing to triage.";

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeSupportBoard(
  input: SupportBoardInput,
  now: Date,
): SupportBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const tickets = input.tickets;

  // ── Zero-tickets: an absence of records, not a measured zero. Every metric
  // is insufficient and both mixes are empty. ──────────────────────────────
  if (tickets.length === 0) {
    return {
      asOf: now.toISOString(),
      periodLabel,
      priorityMix: [],
      categoryMix: [],
      metrics: [
        insufficient("open_tickets", "Open tickets", "int", NO_TICKETS_BASIS),
        insufficient("total_tickets", "Total tickets", "int", NO_TICKETS_BASIS),
        insufficient("unresolved_over_24h", "Unresolved > 24h", "int", NO_TICKETS_BASIS),
        insufficient("unresolved_over_72h", "Unresolved > 72h", "int", NO_TICKETS_BASIS),
        insufficient("unresolved_over_7d", "Unresolved > 7d", "int", NO_TICKETS_BASIS),
        insufficient("oldest_open_age", "Oldest open ticket", "hours", NO_TICKETS_BASIS),
        insufficient("urgent_open", "Urgent open", "int", NO_TICKETS_BASIS),
        insufficient("awaiting_reply", "Awaiting our reply", "int", NO_TICKETS_BASIS),
        insufficient("sla_breaches", "SLA breaches", "int", NO_TICKETS_BASIS),
        insufficient("top_category_share", "Top category share", "pct", NO_TICKETS_BASIS),
        insufficient("unmeasurable", "Unmeasurable age", "int", NO_TICKETS_BASIS),
      ],
    };
  }

  const total = tickets.length;
  const active = tickets.filter((t) => isActiveStatus(t.status));
  const activeTotal = active.length;

  // Split active tickets by whether their created timestamp is measurable. A
  // malformed/missing `createdAt` is NEVER treated as 0h-old (which would read
  // as a healthy brand-new ticket); such tickets are excluded from aging/SLA
  // and counted into the honest `unmeasurable` data-quality signal below.
  const measurable = active
    .map((t) => ({ t, h: hoursSinceOrNull(now, t.createdAt) }))
    .filter((x): x is { t: SupportBoardTicket; h: number } => x.h !== null);
  const unmeasurableCount = activeTotal - measurable.length;

  // Aging buckets over ACTIVE, MEASURABLE (unresolved) tickets, by created age.
  const ages = measurable.map((x) => x.h);
  const over24 = ages.filter((h) => h > 24).length;
  const over72 = ages.filter((h) => h > 72).length;
  const over7d = ages.filter((h) => h > 168).length;

  // Priority headline + "we owe them a reply". These are timestamp-independent,
  // so they cover every active ticket (measurable or not).
  const urgentOpen = active.filter((t) => t.priority === "urgent").length;
  const awaitingReply = active.filter((t) => t.lastReplyKind === "customer").length;

  // SLA breaches: an active, MEASURABLE ticket whose created-age exceeds its
  // priority's resolution target. Unknown priorities fall back to the "normal"
  // target so an unexpected value can never silently escape the breach count.
  const slaBreaches = measurable.filter(({ t, h }) => {
    const target =
      SUPPORT_SLA_HOURS[(t.priority as SupportPriority)] ??
      SUPPORT_SLA_HOURS.normal;
    return h > target;
  }).length;

  // Priority mix over active tickets, canonical order, zeros included. Empty
  // when nothing is active — there is no live distribution to show.
  const priorityMix: SupportBreakdown[] =
    activeTotal === 0
      ? []
      : SUPPORT_PRIORITIES.map((p) => {
          const count = active.filter((t) => t.priority === p).length;
          return {
            key: p,
            label: SUPPORT_PRIORITY_LABEL[p as SupportPriority],
            count,
            share: round1((count / activeTotal) * 100),
          };
        });

  // Category mix over active tickets, busiest-first — the recurring-theme
  // signal. Categories with no active tickets are dropped from the list.
  const categoryMix: SupportBreakdown[] = SUPPORT_CATEGORIES.map((c) => {
    const count = active.filter((t) => t.category === c).length;
    return {
      key: c,
      label: SUPPORT_CATEGORY_LABEL[c as SupportCategory],
      count,
      share: activeTotal > 0 ? round1((count / activeTotal) * 100) : 0,
    };
  })
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const oldestOpenAge = ages.length > 0 ? Math.max(...ages) : 0;
  const topCategory = categoryMix[0] ?? null;

  const metrics: SupportMetric[] = [
    fact(
      "open_tickets",
      "Open tickets",
      activeTotal,
      "int",
      "Active tickets (open / in progress / waiting on customer), counted from the ticket rows.",
    ),
    fact(
      "total_tickets",
      "Total tickets",
      total,
      "int",
      "Every support ticket on record, any status.",
    ),
    derived(
      "unresolved_over_24h",
      "Unresolved > 24h",
      over24,
      "int",
      "Active (unresolved) tickets created more than 24 hours ago.",
    ),
    derived(
      "unresolved_over_72h",
      "Unresolved > 72h",
      over72,
      "int",
      "Active (unresolved) tickets created more than 72 hours ago.",
    ),
    derived(
      "unresolved_over_7d",
      "Unresolved > 7d",
      over7d,
      "int",
      "Active (unresolved) tickets created more than 7 days ago.",
    ),
    // Oldest open age — insufficient when there is no active ticket with a
    // measurable created timestamp to age (none active, or all unmeasurable).
    ages.length > 0
      ? derived(
          "oldest_open_age",
          "Oldest open ticket",
          round1(oldestOpenAge),
          "hours",
          "Hours since the oldest still-active ticket was created.",
        )
      : insufficient(
          "oldest_open_age",
          "Oldest open ticket",
          "hours",
          activeTotal > 0
            ? "Active tickets exist but none has a valid created timestamp, so no age can be measured."
            : "No active tickets — there is no open ticket whose age to report.",
        ),
    derived(
      "urgent_open",
      "Urgent open",
      urgentOpen,
      "int",
      "Active tickets flagged priority = urgent.",
    ),
    derived(
      "awaiting_reply",
      "Awaiting our reply",
      awaitingReply,
      "int",
      "Active tickets where the customer replied last — the ball is with us.",
    ),
    derived(
      "sla_breaches",
      "SLA breaches",
      slaBreaches,
      "int",
      "Active tickets past their priority resolution target (urgent 4h / high 24h / normal 72h / low 7d).",
    ),
    // Top-category share — undefined when nothing is active.
    activeTotal > 0 && topCategory
      ? derived(
          "top_category_share",
          "Top category share",
          topCategory.share,
          "pct",
          `${topCategory.label} is the most common active category (${topCategory.count} of ${activeTotal}).`,
        )
      : insufficient(
          "top_category_share",
          "Top category share",
          "pct",
          "No active tickets — there is no live category distribution to rank.",
        ),
    // Data-quality signal: active tickets with a missing/malformed created
    // timestamp, excluded from aging and SLA above. A derived zero here means
    // we checked every active ticket's timestamp and all were valid — never a
    // silent 0h-old ticket masquerading as healthy.
    derived(
      "unmeasurable",
      "Unmeasurable age",
      unmeasurableCount,
      "int",
      unmeasurableCount > 0
        ? `${unmeasurableCount} active ticket${unmeasurableCount === 1 ? " has" : "s have"} no valid created timestamp, so ${unmeasurableCount === 1 ? "it is" : "they are"} excluded from aging and SLA.`
        : "Every active ticket has a valid created timestamp; none excluded from aging or SLA.",
    ),
  ];

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    priorityMix,
    categoryMix,
  };
}
