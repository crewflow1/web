import {
  closeRate,
  pct,
  type StatusCounts,
  type TaskStatusCounts,
} from "@/lib/sales/model";

/**
 * CrewFlow HQ — Executive Command Centre, pure metric assembly
 * (CEO Directive 004, Phase 2).
 *
 * Server- and client-safe: NO Supabase imports. The server-only
 * aggregator (`server/services/hq-executive.ts`) gathers the raw numbers
 * from the snapshot / sales / AI-task services and hands a plain
 * `ExecutiveInput` to `assembleExecutiveSections` here. Keeping the whole
 * card layout pure means the entire control centre is unit-testable with
 * synthetic inputs and the client counter can reuse `formatExec` for a
 * single, consistent formatting source of truth.
 *
 * The directive's ~25 live cards are grouped into six readable sections:
 * Revenue & growth, Sales pipeline, Conversion rates, Outreach activity,
 * AI workforce, and the Research engine.
 */

export type ExecFormat = "gbp" | "int" | "pct";

export type ExecAccent =
  | "indigo"
  | "emerald"
  | "amber"
  | "sky"
  | "fuchsia"
  | "rose"
  | "violet"
  | "slate";

export type ExecTrendDirection = "up" | "down" | "flat";

export type ExecTrend = {
  /** Signed percentage change vs the comparison baseline (1 d.p.). */
  pct: number;
  direction: ExecTrendDirection;
};

export type ExecCard = {
  key: string;
  label: string;
  /** Raw numeric value — drives the animated count-up. */
  value: number;
  format: ExecFormat;
  sub?: string;
  accent: ExecAccent;
  /** Optional period-over-period trend badge. */
  trend?: ExecTrend | null;
  /** No live data source wired yet — render a subtle "Foundation" tag. */
  foundation?: boolean;
  /** Optional deep-link to the section that owns this metric. */
  href?: string;
};

export type ExecSection = {
  key: string;
  title: string;
  subtitle?: string;
  cards: ExecCard[];
};

/** Every raw figure the control centre needs, gathered by the service. */
export type ExecutiveInput = {
  // Revenue & growth.
  mrrGbp: number;
  mrrPrevGbp: number;
  revenueThisMonthGbp: number;
  revenuePrevMonthGbp: number;
  activeCustomers: number;
  trials: number;
  newCustomersThisMonth: number;
  customerGrowthPct: number;
  // Sales pipeline.
  pipelineValueGbp: number;
  wonValueGbp: number;
  totalCompanies: number;
  bookedDemos: number;
  activeDemos: number;
  statusCounts: StatusCounts;
  // Outreach activity.
  coldCallsToday: number;
  emailsSent30d: number;
  linkedinMessages30d: number;
  instagramMessages30d: number;
  whatsappMessages30d: number;
  // AI workforce.
  aiTasks: TaskStatusCounts;
  // Research engine.
  companiesResearched: number;
  companiesQualified: number;
  companiesRejected: number;
  companiesEnriched: number;
};

// ---------------------------------------------------------------------
// Pure derivations.
// ---------------------------------------------------------------------

/** Annual run-rate from monthly recurring revenue. */
export function arrFromMrr(mrrGbp: number): number {
  if (!Number.isFinite(mrrGbp) || mrrGbp <= 0) return 0;
  return Math.round(mrrGbp) * 12;
}

/** Signed period-over-period trend. No baseline → flat (or up from zero). */
export function trend(curr: number, prev: number): ExecTrend {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) {
    return { pct: 0, direction: "flat" };
  }
  if (prev === 0) {
    return curr > 0
      ? { pct: 100, direction: "up" }
      : { pct: 0, direction: "flat" };
  }
  const raw = ((curr - prev) / Math.abs(prev)) * 100;
  const clamped = Math.max(-999, Math.min(999, raw));
  const rounded = Math.round(clamped * 10) / 10;
  return {
    pct: rounded,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  };
}

function trendFromPct(value: number): ExecTrend {
  const rounded = Math.round(value * 10) / 10;
  return {
    pct: rounded,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  };
}

/** Companies at `contacted` or any later stage — the outreach denominator. */
function contactedOrBeyond(counts: StatusCounts): number {
  return (
    counts.contacted + counts.replied + counts.demo_booked + counts.won
  );
}

/** Replied ÷ contacted — how often outreach earns a response. */
export function replyRate(counts: StatusCounts): number {
  const repliedPlus = counts.replied + counts.demo_booked + counts.won;
  return pct(repliedPlus, contactedOrBeyond(counts));
}

/** Demos booked ÷ contacted — how often a conversation reaches a demo. */
export function demoRate(counts: StatusCounts): number {
  const demoPlus = counts.demo_booked + counts.won;
  return pct(demoPlus, contactedOrBeyond(counts));
}

// ---------------------------------------------------------------------
// Formatting — single source of truth shared by SSR and the client counter.
// ---------------------------------------------------------------------

/** Compact GBP: full with separators under £100k, then £NNk / £N.NM. */
export function formatGbpCompact(n: number): string {
  const v = Math.round(n);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    const m = v / 1_000_000;
    return `£${(Math.round(m * 10) / 10).toLocaleString("en-GB")}M`;
  }
  if (abs >= 100_000) {
    return `£${Math.round(v / 1_000).toLocaleString("en-GB")}k`;
  }
  return `£${v.toLocaleString("en-GB")}`;
}

/** Format a (possibly mid-animation, fractional) value for a given card. */
export function formatExec(value: number, format: ExecFormat): string {
  if (format === "pct") {
    const r = Math.round(value * 10) / 10;
    return `${r.toLocaleString("en-GB", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })}%`;
  }
  if (format === "gbp") return formatGbpCompact(value);
  return Math.round(value).toLocaleString("en-GB");
}

// ---------------------------------------------------------------------
// Section assembly — the directive's card set, grouped and ordered.
// ---------------------------------------------------------------------

export function assembleExecutiveSections(i: ExecutiveInput): ExecSection[] {
  return [
    {
      key: "revenue",
      title: "Revenue & growth",
      subtitle: "The money the company is making right now",
      cards: [
        {
          key: "mrr",
          label: "MRR",
          value: i.mrrGbp,
          format: "gbp",
          sub: "monthly recurring",
          accent: "emerald",
          trend: trend(i.mrrGbp, i.mrrPrevGbp),
        },
        {
          key: "arr",
          label: "ARR",
          value: arrFromMrr(i.mrrGbp),
          format: "gbp",
          sub: "annual run-rate",
          accent: "emerald",
        },
        {
          key: "revenue",
          label: "Revenue",
          value: i.revenueThisMonthGbp,
          format: "gbp",
          sub: "this month",
          accent: "indigo",
          trend: trend(i.revenueThisMonthGbp, i.revenuePrevMonthGbp),
        },
        {
          key: "active_customers",
          label: "Active customers",
          value: i.activeCustomers,
          format: "int",
          sub: "paying",
          accent: "sky",
          trend: trendFromPct(i.customerGrowthPct),
        },
        {
          key: "trials",
          label: "Trials",
          value: i.trials,
          format: "int",
          sub: "in onboarding",
          accent: "amber",
          href: "/admin/onboarding",
        },
        {
          key: "conversions",
          label: "Conversions",
          value: i.newCustomersThisMonth,
          format: "int",
          sub: "new customers · this month",
          accent: "violet",
        },
      ],
    },
    {
      key: "pipeline",
      title: "Sales pipeline",
      subtitle: "The deals the AI sales engine is working",
      cards: [
        {
          key: "pipeline_value",
          label: "Pipeline value",
          value: i.pipelineValueGbp,
          format: "gbp",
          sub: "open deals",
          accent: "indigo",
          href: "/admin/sales",
        },
        {
          key: "won_value",
          label: "Won value",
          value: i.wonValueGbp,
          format: "gbp",
          sub: "closed-won",
          accent: "emerald",
        },
        {
          key: "total_companies",
          label: "Companies",
          value: i.totalCompanies,
          format: "int",
          sub: "in the database",
          accent: "sky",
          href: "/admin/sales/companies",
        },
        {
          key: "booked_demos",
          label: "Booked demos",
          value: i.bookedDemos,
          format: "int",
          sub: "scheduled",
          accent: "violet",
          href: "/admin/demos",
        },
        {
          key: "active_demos",
          label: "Active demos",
          value: i.activeDemos,
          format: "int",
          sub: "awaiting contact",
          accent: "amber",
          href: "/admin/demos",
        },
      ],
    },
    {
      key: "rates",
      title: "Conversion rates",
      subtitle: "How efficiently leads move down the funnel",
      cards: [
        {
          key: "reply_rate",
          label: "Reply rate",
          value: replyRate(i.statusCounts),
          format: "pct",
          sub: "replied ÷ contacted",
          accent: "sky",
        },
        {
          key: "demo_rate",
          label: "Demo rate",
          value: demoRate(i.statusCounts),
          format: "pct",
          sub: "demos ÷ contacted",
          accent: "violet",
        },
        {
          key: "close_rate",
          label: "Close rate",
          value: closeRate(i.statusCounts),
          format: "pct",
          sub: "won ÷ decided",
          accent: "emerald",
        },
      ],
    },
    {
      key: "outreach",
      title: "Outreach activity",
      subtitle: "Every channel the engine touches — logged and searchable",
      cards: [
        {
          key: "cold_calls",
          label: "Cold calls",
          value: i.coldCallsToday,
          format: "int",
          sub: "today",
          accent: "rose",
        },
        {
          key: "emails_sent",
          label: "Emails sent",
          value: i.emailsSent30d,
          format: "int",
          sub: "last 30 days",
          accent: "indigo",
        },
        {
          key: "linkedin",
          label: "LinkedIn",
          value: i.linkedinMessages30d,
          format: "int",
          sub: "messages · 30 days",
          accent: "sky",
        },
        {
          key: "instagram",
          label: "Instagram",
          value: i.instagramMessages30d,
          format: "int",
          sub: "messages · 30 days",
          accent: "fuchsia",
        },
        {
          key: "whatsapp",
          label: "WhatsApp",
          value: i.whatsappMessages30d,
          format: "int",
          sub: "channel not yet wired",
          accent: "emerald",
          foundation: true,
        },
      ],
    },
    {
      key: "ai",
      title: "AI workforce",
      subtitle: "What the autonomous task queue is doing",
      cards: [
        {
          key: "ai_running",
          label: "Tasks running",
          value: i.aiTasks.running,
          format: "int",
          sub: "in progress now",
          accent: "sky",
          href: "/admin/sales/tasks",
        },
        {
          key: "ai_pending",
          label: "Tasks queued",
          value: i.aiTasks.pending,
          format: "int",
          sub: "waiting to run",
          accent: "amber",
          href: "/admin/sales/tasks",
        },
        {
          key: "ai_completed",
          label: "Tasks completed",
          value: i.aiTasks.completed,
          format: "int",
          sub: "all-time",
          accent: "emerald",
        },
        {
          key: "ai_failed",
          label: "Tasks failed",
          value: i.aiTasks.failed,
          format: "int",
          sub: "need attention",
          accent: "rose",
          href: "/admin/sales/tasks",
        },
      ],
    },
    {
      key: "research",
      title: "Research engine",
      subtitle: "How the AI is qualifying the market",
      cards: [
        {
          key: "researched",
          label: "Researched",
          value: i.companiesResearched,
          format: "int",
          sub: "companies",
          accent: "indigo",
        },
        {
          key: "qualified",
          label: "Qualified",
          value: i.companiesQualified,
          format: "int",
          sub: "AI score ≥ 60",
          accent: "emerald",
        },
        {
          key: "enriched",
          label: "Enriched",
          value: i.companiesEnriched,
          format: "int",
          sub: "intelligence added",
          accent: "violet",
        },
        {
          key: "rejected",
          label: "Rejected",
          value: i.companiesRejected,
          format: "int",
          sub: "disqualified",
          accent: "rose",
        },
      ],
    },
  ];
}
