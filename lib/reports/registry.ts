/**
 * REPORT REGISTRY — the single source of truth for which reports exist.
 *
 * Pure by design (no `server-only`, no SDK), exactly like `lib/csv.ts`, so the
 * page, the subscribe UI, the export routes, the delivery cron AND the hermetic
 * tests all import the SAME key set and labels. A report key appears here ONCE;
 * every surface derives from it, so a page can never offer a report the export
 * route can't build or the cron can't deliver.
 *
 * The `report_subscriptions.report_key` CHECK constraint (migration
 * 20261134000000) mirrors REPORT_KEYS — the two move in lock-step.
 */

export const REPORT_KEYS = [
  "overview",
  "profit",
  "cashflow",
  "utilisation",
  "pipeline",
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(v: unknown): v is ReportKey {
  return typeof v === "string" && (REPORT_KEYS as readonly string[]).includes(v);
}

export const REPORT_FORMATS = ["pdf", "csv"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(v: unknown): v is ReportFormat {
  return v === "pdf" || v === "csv";
}

export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export function isReportCadence(v: unknown): v is ReportCadence {
  return v === "daily" || v === "weekly" || v === "monthly";
}

export type ReportMeta = {
  key: ReportKey;
  /** Reader-facing title (also the PDF title + CSV first line). */
  title: string;
  /** One-line description shown on the cards and the subscribe UI. */
  description: string;
  /** The live report page route (null for the overview, which is /reports itself). */
  href: string | null;
  /** Whether this report exposes money-out figures (cash timeline) — admin-only. */
  managementOnly: boolean;
};

export const REPORTS: Record<ReportKey, ReportMeta> = {
  overview: {
    key: "overview",
    title: "Business overview",
    description:
      "Jobs per week, revenue per month, VAT per quarter and top customers — the /reports dashboard aggregates.",
    href: "/reports",
    managementOnly: false,
  },
  profit: {
    key: "profit",
    title: "Profit & loss",
    description:
      "Revenue, cost and gross profit by month and by job, with margin bands — from the job profitability authority.",
    href: "/reports/profit",
    managementOnly: false,
  },
  cashflow: {
    key: "cashflow",
    title: "Cashflow forecast",
    description:
      "A week-by-week projection of cash movement over the next quarter — invoices due, retention releases, VAT/CIS and recurring spend.",
    href: "/reports/cashflow",
    managementOnly: true,
  },
  utilisation: {
    key: "utilisation",
    title: "Staff utilisation",
    description:
      "Rostered vs recorded hours per member over the last 30 days, with coverage and labour cost.",
    href: "/reports/utilisation",
    managementOnly: false,
  },
  pipeline: {
    key: "pipeline",
    title: "Sales pipeline",
    description:
      "Open pipeline value by stage, lead count and weighted forecast — from the leads kanban authority.",
    href: "/reports/pipeline",
    managementOnly: false,
  },
};

export const REPORT_CADENCE_LABEL: Record<ReportCadence, string> = {
  daily: "Every day",
  weekly: "Every Monday",
  monthly: "1st of the month",
};
