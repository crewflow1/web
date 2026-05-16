/**
 * Slice 6 (deterministic half) — shared response shapes for
 * /api/ai/activity_summary + /api/ai/lead_insights.
 *
 * `summary` is null in this phase — the natural-language prose slot
 * is reserved for when an Anthropic/OpenAI key lands in Vercel. The
 * deterministic fields (counts, latencies, stalled actions) are the
 * meaningful product output today.
 */

export type ActionCounts = {
  /** "job", "quote", "invoice", "finance", "lead", etc. */
  prefix: string;
  count: number;
};

export type StalledQuote = {
  id: string;
  number: string;
  customer_name: string | null;
  total: number;
  sent_at: string;
  days_stale: number;
  href: string;
};

export type StalledInvoice = {
  id: string;
  number: string;
  total: number;
  sent_at: string;
  due_date: string | null;
  days_overdue: number;
  href: string;
};

export type StaffLeaderEntry = {
  user_id: string | null;
  name: string;
  completed_jobs: number;
};

export type QuoteFunnel = {
  sent: number;
  viewed: number;
  accepted: number;
  declined: number;
  /** accepted / (sent's denominator) as a 0-100 integer; null if zero sent */
  conversion_pct: number | null;
  /** Median seconds from viewed_at → accepted_at across decided quotes. */
  median_view_to_accept_sec: number | null;
  /** Average seconds from sent_at → accepted_at across accepted quotes. */
  avg_sent_to_accept_sec: number | null;
};

export type SourceCloseRate = {
  source: string;
  total: number;
  won: number;
  lost: number;
  /** 0-100 int; null if no decisions yet */
  close_pct: number | null;
};

export type DailyVolume = {
  /** ISO date for the bucket. */
  date: string;
  /** Total events that day. */
  count: number;
  /** Per-prefix breakdown. Keys: "job", "quote", "invoice", "finance", "lead", "other". */
  by_prefix: Record<string, number>;
};

export type ActivitySummaryResponse = {
  org_id: string;
  window_days: number;
  /** Natural-language prose. Populated by the LLM in a later phase. */
  summary: string | null;
  action_counts: ActionCounts[];
  /** Per-day volume across the window, pre-filled with zeroes on flat days. */
  daily_volume: DailyVolume[];
  key_metrics: {
    total_events: number;
    quote_funnel: QuoteFunnel;
    staff_leaders: StaffLeaderEntry[];
  };
  stalled_actions: {
    quotes_unviewed_7d: StalledQuote[];
    invoices_overdue_30d: StalledInvoice[];
  };
};

export type LeadInsightsResponse = {
  org_id: string;
  window_days: number;
  summary: string | null;
  funnel: {
    new: number;
    contacted: number;
    qualified: number;
    quoted: number;
    won: number;
    lost: number;
    job_booked: number;
  };
  /** Overall lead-conversion percentage. 0–100 int or null. */
  conversion_pct: number | null;
  source_close_rates: SourceCloseRate[];
  /** Sum of estimated_value across leads in open stages. */
  pipeline_forecast: number;
};
