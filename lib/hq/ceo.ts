import { closeRate, winRate } from "@/lib/sales/model";
import {
  arrFromMrr,
  replyRate,
  trend,
  type ExecAccent,
  type ExecCard,
  type ExecFormat,
  type ExecTrend,
  type ExecutiveInput,
} from "@/lib/hq/executive";

/**
 * CrewFlow HQ — CEO Dashboard, pure board assembly (CEO Directive 004,
 * Phase 8).
 *
 * Server- and client-safe: NO Supabase imports. The server-only aggregator
 * (`server/services/hq-ceo.ts`) gathers the raw numbers — the shared
 * executive input plus support, AI-workforce and learning counts — and hands
 * a plain `CeoInput` to `assembleCeoBoard` here.
 *
 * The CEO board is deliberately NOT the Phase 2 metric grid. It is a
 * *departmental* read of the whole company: a hero band of five company
 * vitals, then one scorecard per department (Finance, Customers, Pipeline,
 * Sales, Marketing, Research, AI, Learning, Support, Growth) carrying a
 * headline figure, a few supporting stats, an optional trend and — the part
 * that makes it a board rather than a list — a single honest health signal.
 *
 * Health is honest by construction. Departments backed by live data (money,
 * customers, support) report real direction; the nascent AI functions report
 * "foundation" until they log real volume — never a faked green light. All of
 * it is pure, so every health rule is unit-tested with synthetic inputs.
 */

// ---------------------------------------------------------------------
// Input — the executive figures plus the three departments Phase 2 never
// touched (Support, the AI workforce headcount, and the Learning Engine).
// ---------------------------------------------------------------------

export type CeoInput = ExecutiveInput & {
  /**
   * Open support tickets (open / in progress / waiting on customer). `null`
   * when the support_tickets read FAILED — the board must then show Support as
   * insufficient, never fabricate an all-clear from an unreadable queue.
   */
  openSupportTickets: number | null;
  /** AI employees not in the "disabled" state. */
  aiEmployeesActive: number;
  /** Total AI employees on the roster. */
  aiEmployeesTotal: number;
  /** Distilled winning patterns captured in the Learning Engine. */
  learningsTotal: number;
  /** Learnings in the active lifecycle state. */
  learningsActive: number;
  /** Learnings promoted into company-wide Shared Memory. */
  learningsPromoted: number;
};

// ---------------------------------------------------------------------
// Health — a single, honest signal per department.
// ---------------------------------------------------------------------

export type DeptHealthTone =
  | "healthy"
  | "steady"
  | "attention"
  | "foundation"
  | "insufficient";

export type DeptHealth = {
  tone: DeptHealthTone;
  label: string;
};

const HEALTH_LABEL: Record<DeptHealthTone, string> = {
  healthy: "Healthy",
  steady: "Steady",
  attention: "Needs attention",
  foundation: "Foundation",
  // "insufficient" is NOT "foundation": foundation is a CONFIRMED real zero
  // (machinery built, no volume yet); insufficient means the underlying read
  // FAILED, so no honest claim — green or otherwise — can be made. Mirrors the
  // AI Boardroom's honest-label rule (lib/hq/boardroom-cards.ts).
  insufficient: "Unavailable",
};

function health(tone: DeptHealthTone, label?: string): DeptHealth {
  return { tone, label: label ?? HEALTH_LABEL[tone] };
}

/**
 * Revenue health (Finance): real money already flows, so this reflects
 * direction — growing or holding is healthy, shrinking needs attention, and
 * no MRR yet is an honest foundation rather than a false alarm.
 */
export function revenueHealth(mrrGbp: number, mrrTrend: ExecTrend): DeptHealth {
  if (!(mrrGbp > 0)) return health("foundation");
  if (mrrTrend.direction === "down") return health("attention", "Declining");
  return health("healthy", mrrTrend.direction === "up" ? "Growing" : "Stable");
}

/**
 * Customer-base / growth health: derived from the live paying count and its
 * month-over-month change. No paying customers yet → foundation.
 */
export function growthHealth(
  growthPct: number,
  activeCustomers: number,
): DeptHealth {
  if (!(activeCustomers > 0)) return health("foundation");
  if (growthPct > 0) return health("healthy", "Growing");
  if (growthPct < 0) return health("attention", "Contracting");
  return health("steady", "Holding");
}

/**
 * Support health. Honest by construction, split three ways:
 *   - `null`  → the ticket read FAILED; report `insufficient`, never a green
 *               "All clear" conjured from unreadable data.
 *   - `0`     → a CONFIRMED empty queue (query succeeded); genuinely all clear.
 *   - `1..10` → a light queue is steady; a heavier backlog needs attention.
 * The null branch is the whole point: a swallowed-zero upstream would make this
 * department the only one that greens on absent data.
 */
export function supportHealth(openTickets: number | null): DeptHealth {
  if (openTickets === null) return health("insufficient");
  if (!(openTickets > 0)) return health("healthy", "All clear");
  if (openTickets <= 10) return health("steady", "Steady");
  return health("attention", "Backlog");
}

/**
 * Engine health for the nascent AI functions (Sales, Pipeline, Marketing,
 * Research): the machinery is built, but it earns a live signal only once it
 * logs real volume. Zero is an honest foundation, never a failure.
 */
export function engineHealth(volume: number): DeptHealth {
  if (!(volume > 0)) return health("foundation");
  return health("healthy", "Live");
}

/**
 * AI workforce health: failing tasks demand attention; an employed,
 * non-failing roster is healthy; an empty roster is foundation.
 */
export function aiHealth(
  activeEmployees: number,
  failedTasks: number,
): DeptHealth {
  if (failedTasks > 0) return health("attention", "Tasks failing");
  if (!(activeEmployees > 0)) return health("foundation");
  return health("healthy", "Operational");
}

/**
 * Learning health: live patterns make the memory engine healthy; an authored
 * but inactive library is steady; an empty library is foundation.
 */
export function learningHealth(active: number, total: number): DeptHealth {
  if (!(total > 0)) return health("foundation");
  if (active > 0) return health("healthy", "Learning");
  return health("steady", "Drafts only");
}

// ---------------------------------------------------------------------
// Board shape.
// ---------------------------------------------------------------------

/** A labelled figure inside a department scorecard. `value` is `null` when the
 * figure could not be read — the UI renders an em-dash, never a fabricated 0. */
export type DeptStat = {
  label: string;
  value: number | null;
  format: ExecFormat;
};

export type DeptCard = {
  key: string;
  title: string;
  /** One-line plain-English description of what the department does. */
  blurb: string;
  /** Deep-link to the department's own surface. */
  href: string;
  /** Icon slug — the page owns the slug → lucide component map. */
  icon: string;
  accent: ExecAccent;
  /** The single headline figure, driving the card's big animated number. */
  headline: DeptStat;
  /** Optional period-over-period trend on the headline. */
  trend?: ExecTrend | null;
  health: DeptHealth;
  /** Supporting figures (0 to 3). */
  stats: DeptStat[];
};

export type CeoBoard = {
  /** Company vital signs — the five numbers a CEO checks first. */
  vitals: ExecCard[];
  departments: DeptCard[];
};

/** Build an ExecTrend straight from a signed percentage (e.g. growth %). */
function pctToTrend(value: number): ExecTrend {
  const rounded = Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
  return {
    pct: rounded,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  };
}

// ---------------------------------------------------------------------
// Board assembly — vitals hero band + the ten department scorecards.
// ---------------------------------------------------------------------

export function assembleCeoBoard(i: CeoInput): CeoBoard {
  const mrrTrend = trend(i.mrrGbp, i.mrrPrevGbp);
  const growthTrend = pctToTrend(i.customerGrowthPct);
  const arrGbp = arrFromMrr(i.mrrGbp);
  const socialMessages =
    i.linkedinMessages30d + i.instagramMessages30d + i.whatsappMessages30d;
  const directOutreach = i.coldCallsToday + i.emailsSent30d;

  const vitals: ExecCard[] = [
    {
      key: "mrr",
      label: "MRR",
      value: i.mrrGbp,
      format: "gbp",
      sub: "monthly recurring",
      accent: "emerald",
      trend: mrrTrend,
    },
    {
      key: "arr",
      label: "ARR",
      value: arrGbp,
      format: "gbp",
      sub: "annual run-rate",
      accent: "emerald",
    },
    {
      key: "active_customers",
      label: "Active customers",
      value: i.activeCustomers,
      format: "int",
      sub: "paying",
      accent: "sky",
      trend: growthTrend,
    },
    {
      key: "pipeline_value",
      label: "Pipeline value",
      value: i.pipelineValueGbp,
      format: "gbp",
      sub: "open deals",
      accent: "indigo",
    },
    {
      key: "win_rate",
      label: "Win rate",
      value: winRate(i.statusCounts),
      format: "pct",
      sub: "won ÷ all",
      accent: "violet",
    },
  ];

  const departments: DeptCard[] = [
    {
      key: "finance",
      title: "Finance",
      blurb: "Recurring revenue, run-rate and the cash the company books.",
      href: "/admin/billing",
      icon: "banknote",
      accent: "emerald",
      headline: { label: "MRR", value: i.mrrGbp, format: "gbp" },
      trend: mrrTrend,
      health: revenueHealth(i.mrrGbp, mrrTrend),
      stats: [
        { label: "ARR", value: arrGbp, format: "gbp" },
        { label: "Revenue (mo)", value: i.revenueThisMonthGbp, format: "gbp" },
        { label: "Won value", value: i.wonValueGbp, format: "gbp" },
      ],
    },
    {
      key: "customers",
      title: "Customers",
      blurb: "The paying base — who's live, who's trialling, who's new.",
      href: "/admin/customers",
      icon: "users",
      accent: "sky",
      headline: { label: "Active", value: i.activeCustomers, format: "int" },
      trend: growthTrend,
      health: growthHealth(i.customerGrowthPct, i.activeCustomers),
      stats: [
        { label: "Trials", value: i.trials, format: "int" },
        { label: "New (mo)", value: i.newCustomersThisMonth, format: "int" },
        { label: "Growth", value: i.customerGrowthPct, format: "pct" },
      ],
    },
    {
      key: "pipeline",
      title: "Pipeline",
      blurb: "Open deals the AI sales engine is working toward close.",
      href: "/admin/sales/companies",
      icon: "target",
      accent: "indigo",
      headline: {
        label: "Pipeline value",
        value: i.pipelineValueGbp,
        format: "gbp",
      },
      health: engineHealth(i.pipelineValueGbp),
      stats: [
        { label: "Won value", value: i.wonValueGbp, format: "gbp" },
        { label: "Booked demos", value: i.bookedDemos, format: "int" },
        { label: "Close rate", value: closeRate(i.statusCounts), format: "pct" },
      ],
    },
    {
      key: "sales",
      title: "Sales",
      blurb: "Direct outreach — cold calls and email sequences, all logged.",
      href: "/admin/sales",
      icon: "phone",
      accent: "rose",
      headline: { label: "Emails (30d)", value: i.emailsSent30d, format: "int" },
      health: engineHealth(directOutreach),
      stats: [
        { label: "Calls today", value: i.coldCallsToday, format: "int" },
        { label: "Reply rate", value: replyRate(i.statusCounts), format: "pct" },
        { label: "Companies", value: i.totalCompanies, format: "int" },
      ],
    },
    {
      key: "marketing",
      title: "Marketing",
      blurb: "Social reach across LinkedIn, Instagram and WhatsApp.",
      href: "/admin/sales/communications",
      icon: "megaphone",
      accent: "fuchsia",
      headline: { label: "Social (30d)", value: socialMessages, format: "int" },
      health: engineHealth(i.linkedinMessages30d + i.instagramMessages30d),
      stats: [
        { label: "LinkedIn", value: i.linkedinMessages30d, format: "int" },
        { label: "Instagram", value: i.instagramMessages30d, format: "int" },
        { label: "WhatsApp", value: i.whatsappMessages30d, format: "int" },
      ],
    },
    {
      key: "research",
      title: "Research",
      blurb: "How the AI qualifies the market before a human spends a minute.",
      href: "/admin/research",
      icon: "microscope",
      accent: "violet",
      headline: {
        label: "Researched",
        value: i.companiesResearched,
        format: "int",
      },
      health: engineHealth(i.companiesResearched),
      stats: [
        { label: "Qualified", value: i.companiesQualified, format: "int" },
        { label: "Enriched", value: i.companiesEnriched, format: "int" },
        { label: "Rejected", value: i.companiesRejected, format: "int" },
      ],
    },
    {
      key: "ai",
      title: "AI workforce",
      blurb: "The autonomous workforce and its task queue — every action traced.",
      href: "/admin/ai-boardroom",
      icon: "bot",
      accent: "indigo",
      headline: {
        label: "Active employees",
        value: i.aiEmployeesActive,
        format: "int",
      },
      health: aiHealth(i.aiEmployeesActive, i.aiTasks.failed),
      stats: [
        { label: "Roster", value: i.aiEmployeesTotal, format: "int" },
        { label: "Running", value: i.aiTasks.running, format: "int" },
        { label: "Failed", value: i.aiTasks.failed, format: "int" },
      ],
    },
    {
      key: "learning",
      title: "Learning",
      blurb: "Winning plays distilled into reusable, audited company memory.",
      href: "/admin/sales/learning",
      icon: "brain",
      accent: "amber",
      headline: { label: "Patterns", value: i.learningsTotal, format: "int" },
      health: learningHealth(i.learningsActive, i.learningsTotal),
      stats: [
        { label: "Active", value: i.learningsActive, format: "int" },
        { label: "Promoted", value: i.learningsPromoted, format: "int" },
      ],
    },
    {
      key: "support",
      title: "Support",
      blurb: "Open customer conversations the team owes a response.",
      href: "/admin/support",
      icon: "life-buoy",
      accent: "sky",
      headline: {
        label: "Open tickets",
        value: i.openSupportTickets,
        format: "int",
      },
      health: supportHealth(i.openSupportTickets),
      stats: [],
    },
    {
      key: "growth",
      title: "Growth",
      blurb: "The trajectory — net new customers and where momentum heads.",
      href: "/admin/command-centre",
      icon: "trending-up",
      accent: "emerald",
      headline: { label: "Growth", value: i.customerGrowthPct, format: "pct" },
      trend: growthTrend,
      health: growthHealth(i.customerGrowthPct, i.activeCustomers),
      stats: [
        { label: "New (mo)", value: i.newCustomersThisMonth, format: "int" },
        { label: "Trials", value: i.trials, format: "int" },
        { label: "ARR", value: arrGbp, format: "gbp" },
      ],
    },
  ];

  return { vitals, departments };
}
