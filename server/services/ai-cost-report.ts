import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * AI cost observability report (Phase 0).
 *
 * Answers "AI cost today / this week / this month, by tenant / feature / provider /
 * model / engine, with input / output / cached tokens, latency, and fallback events"
 * from the EXISTING ai_invocations ledger via the service-role-only `ai_cost_window`
 * rollup (migration 20261235000000). Read-only; no provider/model behaviour change.
 * HQ/super-admin surface only — the RPC is service-role-only, so no tenant can reach
 * estate-wide spend.
 */

export type AiCostDimensionRow = {
  key: string;
  count: number;
  costPence: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
};

export type AiCostWindow = {
  window: "today" | "week" | "month";
  from: string;
  to: string;
  invocations: number;
  costPence: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  failures: number;
  fallbackEvents: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  byFeature: AiCostDimensionRow[];
  byProvider: AiCostDimensionRow[];
  byModel: AiCostDimensionRow[];
  byEngine: AiCostDimensionRow[];
  /** key = org_id. Top-20 spenders in the window (bounded). */
  topOrgs: AiCostDimensionRow[];
};

export type AiCostReport = {
  today: AiCostWindow;
  week: AiCostWindow;
  month: AiCostWindow;
};

type RawDimRow = {
  key: string | null;
  n?: number | string;
  pence?: number | string;
  in_tok?: number | string;
  out_tok?: number | string;
  cached_tok?: number | string;
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

const mapDim = (rows: unknown): AiCostDimensionRow[] =>
  (Array.isArray(rows) ? (rows as RawDimRow[]) : []).map((r) => ({
    key: r.key ?? "(none)",
    count: num(r.n),
    costPence: num(r.pence),
    inputTokens: r.in_tok === undefined ? undefined : num(r.in_tok),
    outputTokens: r.out_tok === undefined ? undefined : num(r.out_tok),
    cachedInputTokens: r.cached_tok === undefined ? undefined : num(r.cached_tok),
  }));

function mapWindow(window: AiCostWindow["window"], raw: Record<string, unknown>): AiCostWindow {
  return {
    window,
    from: String(raw.from ?? ""),
    to: String(raw.to ?? ""),
    invocations: num(raw.invocations),
    costPence: num(raw.cost_pence),
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cachedInputTokens: num(raw.cached_input_tokens),
    failures: num(raw.failures),
    fallbackEvents: num(raw.fallback_events),
    latencyP50Ms: num(raw.latency_p50_ms),
    latencyP95Ms: num(raw.latency_p95_ms),
    byFeature: mapDim(raw.by_feature),
    byProvider: mapDim(raw.by_provider),
    byModel: mapDim(raw.by_model),
    byEngine: mapDim(raw.by_engine),
    topOrgs: mapDim(raw.top_orgs),
  };
}

/** Fetch one Europe/London window rollup. LOUD: throws on a read error. */
async function fetchWindow(window: AiCostWindow["window"]): Promise<AiCostWindow> {
  const admin = createAdminClient();
  const { data, error } = await (
    admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc("ai_cost_window", { p_window: window });
  if (error) throw new Error(`ai_cost_window(${window}) failed: ${error.message}`);
  return mapWindow(window, (data ?? {}) as Record<string, unknown>);
}

/** The full Phase-0 report: today / this week / this month. */
export async function buildAiCostReport(): Promise<AiCostReport> {
  const [today, week, month] = await Promise.all([
    fetchWindow("today"),
    fetchWindow("week"),
    fetchWindow("month"),
  ]);
  return { today, week, month };
}
