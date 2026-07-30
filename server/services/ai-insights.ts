import "server-only";
import {
  buildCacheKey,
  cacheGet,
  cacheSet,
  isKvConfigured,
} from "@/lib/cache/kv";
import {
  generateInsightNarrative,
  type InsightKind,
} from "@/lib/ai/insight-narrative";
import type { CacheStatus } from "@/lib/ai/types";

/**
 * Tenant AI Insights — the ONE narrative funnel (Vision 2030 AI-1).
 *
 * Both the tenant `/insights` page and the `/api/ai/*` insight routes resolve
 * the prose summary THROUGH HERE — a single owner for "the deterministic
 * compute is done; now (maybe) narrate it, cache it, and record what it cost".
 * There is no second summary path: the previous ad-hoc `lib/ai/llm.ts` (which
 * reached a vendor SDK directly and recorded no cost) is retired in favour of
 * the shared provider abstraction, reached only via
 * `generateInsightNarrative`.
 *
 * CACHE. The narrative is day-bucketed per org+kind+window in KV (24h TTL) so a
 * configured model is called at most once per org per day per window; every
 * other render is a cache hit. When KV is absent (CI / preview) it degrades to
 * a live call, and when no provider is configured the generator returns null —
 * the deterministic body is ALWAYS intact.
 *
 * COST. Every fresh generation's cost (provider truth via `textCostUsd`, inside
 * the generator) is recorded to the structured log and carried on the cached
 * artifact. Insights produce no per-summary domain row, so — consistent with
 * the repo's "cost is observability, never a correctness gate" doctrine — this
 * is the recording sink. A durable cross-AI cost ledger is a separate,
 * deliberate increment.
 *
 * ORG ISOLATION. `org_id` is part of the KV key ONLY (server-side, token-gated,
 * never exposed to clients). The generator strips `org_id` before the prompt
 * ever reaches a model.
 */

const CACHE_TTL_HOURS = 24;
const CACHE_NAMESPACE = "ai:narrative";

/** What we persist for a generated narrative — the text plus its cost record. */
type CachedNarrative = {
  text: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  generated_at: string;
};

export type ResolvedNarrative = {
  /** Prose narrative, or `null` when the feature is off / generation failed. */
  summary: string | null;
  /** Where the summary came from — meaningful only when `summary !== null`. */
  cache: CacheStatus;
};

/**
 * Resolve the prose narrative for an already-computed deterministic payload.
 * Never throws: a cache fault or a model failure degrades to
 * `{ summary: null, cache: "disabled" }` and the caller renders the
 * deterministic body alone.
 */
export async function resolveInsightNarrative(args: {
  orgId: string;
  kind: InsightKind;
  windowDays: number;
  payload: unknown;
}): Promise<ResolvedNarrative> {
  const { orgId, kind, windowDays, payload } = args;

  // Day-bucketed key so summaries roll over at UTC midnight. org_id lives in the
  // key only — the generator strips it before any model sees the payload.
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = buildCacheKey([
    CACHE_NAMESPACE,
    kind,
    orgId,
    today,
    String(windowDays),
  ]);

  if (isKvConfigured()) {
    const cached = await cacheGet<CachedNarrative>(cacheKey);
    if (cached?.text) {
      return { summary: cached.text, cache: "hit" };
    }
  }

  // The org id is passed for BUDGET ATTRIBUTION only — the generator strips it
  // from the payload before the prompt is built, so it still never reaches a
  // model. `userId: null`: a narration is a render-time enrichment, not an
  // action a person took, which is the same reason the ledger's user_id is
  // nullable for system work.
  const narrative = await generateInsightNarrative(kind, payload, { orgId, userId: null });
  if (!narrative) {
    // No provider configured, or the model failed / returned nothing.
    return { summary: null, cache: "disabled" };
  }

  // Record cost — structured + greppable. Insights have no per-summary DB row,
  // so this log line plus the cached artifact below ARE the cost record.
  console.info("[ai/insights] narrative generated", {
    org_id: orgId,
    kind,
    window_days: windowDays,
    provider: narrative.provider,
    model: narrative.model,
    input_tokens: narrative.inputTokens,
    output_tokens: narrative.outputTokens,
    cost_usd: narrative.costUsd,
    latency_ms: narrative.latencyMs,
  });

  const written = await cacheSet(
    cacheKey,
    {
      text: narrative.text,
      provider: narrative.provider,
      model: narrative.model,
      input_tokens: narrative.inputTokens,
      output_tokens: narrative.outputTokens,
      cost_usd: narrative.costUsd,
      generated_at: new Date().toISOString(),
    } satisfies CachedNarrative,
    CACHE_TTL_HOURS,
  );

  return { summary: narrative.text, cache: written ? "miss" : "disabled" };
}
