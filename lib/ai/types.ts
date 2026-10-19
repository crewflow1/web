/**
 * Slice 6 (deterministic half) — shared response shapes for the insight
 * aggregates (lib/ai/aggregates.ts), consumed IN-PROCESS by /insights and
 * the dashboard insight cards. The /api/ai/{activity_summary,lead_insights}
 * HTTP twins were removed 2026-10-19 (orphan-route remediation — nothing
 * ever fetched them; ADR 0008 makes internal services, not per-capability
 * endpoints, the stable interface).
 *
 * `summary` carries the governed narrative when a text tier is bound; the
 * deterministic fields (counts, latencies, stalled actions) are always the
 * authoritative product output.
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
  /**
   * Nullable: overdue is derived from `due_date`, not from having been sent
   * through the app (lib/invoices/overdue.ts). An imported or manually-managed
   * invoice can be genuinely overdue with no `sent_at` stamp, so this can't be
   * required. It was previously non-null only because the old definition
   * filtered on `sent_at` itself.
   */
  sent_at: string | null;
  due_date: string | null;
  /** Days past `due_date` — the deadline missed, not time since sending. */
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
  /**
   * Win rate among decided quotes: accepted / (accepted + declined), as a
   * 0–100 integer. null when no quotes have been decided yet. Matches the
   * dashboard's definition; bounded to ≤100 (L3).
   */
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

/**
 * Cache status surfaced in API responses so callers (and the QA report)
 * can see whether the prose came from KV or a fresh LLM call.
 *   - "hit"      summary served from cache
 *   - "miss"     LLM was called this request; result was written to cache
 *   - "disabled" no LLM key set OR LLM call failed; summary is null
 */
export type CacheStatus = "hit" | "miss" | "disabled";

export type ActivitySummaryResponse = {
  org_id: string;
  window_days: number;
  /** Natural-language prose. Populated when LLM key is set and call succeeds. */
  summary: string | null;
  /** Where the summary came from. Only meaningful when summary !== null. */
  cache: CacheStatus;
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
  cache: CacheStatus;
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
