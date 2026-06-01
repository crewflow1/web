/**
 * Activity-feed display helpers.
 *
 * Translates a raw activity_log row into a human-readable line and a
 * deep-link to the affected object. Pure functions, server/client-safe.
 */

export type ActivityRow = {
  id: string;
  actor_name: string | null;
  action: string;
  target_table: string;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
});

export function actionIcon(action: string): string {
  if (action.startsWith("variation.")) return "📐";
  if (action.startsWith("quote.")) return "📝";
  if (action.startsWith("invoice.")) return "💷";
  if (action.startsWith("finance.")) return "🧾";
  if (action.startsWith("job.photo")) return "📸";
  if (action.startsWith("job.")) return "🔧";
  if (action.startsWith("lead.")) return "🎯";
  if (action.startsWith("customer.")) return "👤";
  return "•";
}

function fmtNumber(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return GBP.format(n);
}

function fmtMeta(m: Record<string, unknown> | null, keys: string[]): string {
  if (!m) return "";
  const parts: string[] = [];
  for (const k of keys) {
    const v = m[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(String(v));
  }
  return parts.join(" → ");
}

/** Returns a one-line summary for the feed card. */
export function describeActivity(row: ActivityRow): string {
  const m = row.metadata ?? {};
  switch (row.action) {
    case "job.created":
      return "created a job";
    case "job.status_changed":
      return `moved a job ${fmtMeta(m, ["from", "to"]) || "to a new status"}`;
    case "job.assigned":
      return "reassigned a job";
    case "job.rescheduled":
      return `rescheduled a job ${fmtMeta(m, ["from", "to"]) || ""}`.trim();
    case "job.photos_changed": {
      const before = Number(m["from_count"] ?? 0);
      const after = Number(m["to_count"] ?? 0);
      const delta = after - before;
      if (delta > 0) return `uploaded ${delta} photo${delta === 1 ? "" : "s"} to a job`;
      if (delta < 0)
        return `removed ${-delta} photo${-delta === 1 ? "" : "s"} from a job`;
      return "updated photos on a job";
    }
    case "job.deleted":
      return "deleted a job";
    case "quote.created":
      return `created quote ${m["number"] ?? ""} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "quote.approval_requested":
      return `requested approval on quote ${m["number"] ?? ""}`;
    case "quote.approved":
      return `approved quote ${m["number"] ?? ""} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "quote.rejected":
      return `rejected quote ${m["number"] ?? ""}`;
    case "quote.changes_requested":
      return `requested changes on a quote`;
    case "quote.changed_after_approval":
      return `edited approved quote ${m["number"] ?? ""} — re-approval required`;
    case "quote.sent":
      return `sent quote ${m["number"] ?? ""}`;
    case "quote.viewed":
      return `viewed quote ${m["number"] ?? ""}`;
    case "quote.accepted":
      return `accepted quote ${m["number"] ?? ""} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "quote.declined":
      return `declined quote ${m["number"] ?? ""}`;
    case "invoice.created":
      return `created invoice ${m["number"] ?? ""} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "invoice.sent":
      return `sent invoice ${m["number"] ?? ""}`;
    case "invoice.paid":
      return `marked invoice ${m["number"] ?? ""} paid ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "invoice.overdue":
      return `marked invoice ${m["number"] ?? ""} overdue`;
    case "invoice.draft":
      return `set invoice ${m["number"] ?? ""} to draft`;
    case "finance.created":
      return `added a finance entry ${fmtNumber(m["amount"]) ?? ""} ${m["category"] ? `(${m["category"]})` : ""}`.trim();
    case "finance.updated":
      return `updated a finance entry`;
    case "finance.deleted":
      return `deleted a finance entry`;
    case "lead.created":
      return `captured a new lead ${m["service"] ? `(${m["service"]})` : ""}`.trim();
    case "lead.stage_changed":
      return `moved a lead ${fmtMeta(m, ["from", "to"]) || "to a new stage"}`;
    case "lead.assigned":
      return `reassigned a lead`;
    case "lead.deleted":
      return `deleted a lead`;
    case "variation.created":
      return `created Variation #${String(m["variation_number"] ?? "").padStart(3, "0")} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "variation.sent":
      return `sent Variation #${String(m["variation_number"] ?? "").padStart(3, "0")}`;
    case "variation.viewed":
      return `viewed Variation #${String(m["variation_number"] ?? "").padStart(3, "0")}`;
    case "variation.accepted":
      return `approved Variation #${String(m["variation_number"] ?? "").padStart(3, "0")} ${fmtNumber(m["total"]) ?? ""}`.trim();
    case "variation.declined":
      return `rejected Variation #${String(m["variation_number"] ?? "").padStart(3, "0")}`;
    case "customer.created":
      return `added a new customer ${m["name"] ? `(${m["name"]})` : ""}`.trim();
    case "customer.updated":
      return `updated a customer ${m["name"] ? `(${m["name"]})` : ""}`.trim();
    case "customer.deleted":
      return `deleted a customer ${m["name"] ? `(${m["name"]})` : ""}`.trim();
    default:
      return row.action;
  }
}

/** Internal URL to the affected entity. */
export function activityHref(row: ActivityRow): string | null {
  switch (row.target_table) {
    case "jobs":
      return `/jobs/${row.target_id}`;
    case "quotes":
      return `/quotes/${row.target_id}`;
    case "invoices":
      return `/invoices/${row.target_id}`;
    case "finances":
      return `/finances`;
    case "leads":
      return `/leads/${row.target_id}`;
    case "customers":
      return `/customers/${row.target_id}`;
    default:
      return null;
  }
}

const SHORT_LOCALE = "en-GB";
const RELATIVE = new Intl.RelativeTimeFormat(SHORT_LOCALE, { numeric: "auto" });

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = (then - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return RELATIVE.format(Math.round(diffSec), "second");
  if (abs < 3600) return RELATIVE.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(diffSec / 3600), "hour");
  if (abs < 604800) return RELATIVE.format(Math.round(diffSec / 86400), "day");
  return new Date(iso).toLocaleDateString(SHORT_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

/** Coarse filter prefixes the UI exposes as quick filters. */
export const ACTIVITY_TYPES = [
  { value: "", label: "All" },
  { value: "lead.", label: "Leads" },
  { value: "job.", label: "Jobs" },
  { value: "quote.", label: "Quotes" },
  { value: "invoice.", label: "Invoices" },
  { value: "finance.", label: "Finances" },
  { value: "customer.", label: "Customers" },
  { value: "variation.", label: "Variations" },
] as const;
