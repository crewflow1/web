import "server-only";
import { getTextProvider, textCostUsd, type TextResult } from "@/lib/ai/text";

/**
 * Tenant AI Insights — the NARRATE-ONLY summary generator (Vision 2030 AI-1).
 *
 * Turns the deterministic insight payload (already computed by
 * `lib/ai/aggregates`) into a 2–3 sentence prose narrative. This is the ONLY
 * place the insights layer reaches a language model, and it does so EXCLUSIVELY
 * through the existing provider abstraction (`lib/ai/text::getTextProvider`) —
 * never a vendor SDK — so provider selection, cost accounting and graceful
 * degradation are the SAME seam the receptionist drafts, HQ drafts and the
 * Memory lifecycle already use. It replaces the retired `lib/ai/llm.ts`, which
 * reached a vendor SDK directly and recorded no cost.
 *
 * NARRATIVE, NOT AUTHORITY. The model is handed FINISHED deterministic facts and
 * asked only to describe them. It never computes a metric, never invents a
 * number, never recommends an action beyond what the data shows, and never
 * states business state that isn't in the payload. Its entire output is the
 * prose `summary` string — a clearly-labelled blurb the UI renders ABOVE the
 * deterministic cards. Every number the tenant sees comes from the aggregates,
 * not the model, so a hallucination can never change a displayed fact.
 *
 * ORGANISATION ISOLATION. `org_id` is stripped from the payload here, BEFORE the
 * prompt is built, so no tenant identifier ever reaches a model — regardless of
 * which caller passed the payload in.
 *
 * GRACEFUL BY CONSTRUCTION. No provider configured → `null` (the feature is off;
 * the deterministic UI is unchanged — this is the feature control). An
 * unsupported provider, a provider throw/timeout, or an empty generation → also
 * `null`. The caller treats `null` as "render deterministic only", so
 * degradation is invisible to the tenant.
 */

export type InsightKind = "activity" | "lead";

/** The successful result of one narration — text plus provider-truth cost data. */
export type InsightNarrative = {
  /** The prose narrative, trimmed and guaranteed non-empty. */
  text: string;
  /** Vendor id that actually ran (for observability + cost). */
  provider: string;
  /** Model that actually ran, echoed from the provider. */
  model: string;
  /** Billed prompt tokens (provider truth). */
  inputTokens: number;
  /** Billed completion tokens (provider truth). */
  outputTokens: number;
  /** USD cost via the shared pricing metadata, or `null` for an unpriced model. */
  costUsd: number | null;
  /** Wall-clock generation latency in ms. */
  latencyMs: number;
};

const NARRATIVE_TIMEOUT_MS = 8000;
const NARRATIVE_MAX_TOKENS = 400;

/**
 * The safety framing — a fixed constant. No payload content can steer it. It
 * confines the model to NARRATION of the supplied facts and forbids invention.
 */
export const INSIGHT_NARRATIVE_SYSTEM = [
  "You are CrewFlow Insights, a read-only analyst for a UK construction firm.",
  "You are given a deterministic JSON snapshot of the firm's own data that has ALREADY been computed for you.",
  "Your ONLY job is to describe, in plain prose, what that snapshot shows.",
  "STRICT RULES:",
  "- Do NOT invent, estimate, or compute any number, currency amount or percentage that is not literally present in the snapshot.",
  "- Do NOT recommend actions, next steps, or strategy beyond what the snapshot itself plainly implies.",
  "- Do NOT state any business fact (customers, staff, money, outcomes) that is not in the snapshot.",
  "- Do NOT restate the raw numbers mechanically — interpret what they mean, but never beyond the data.",
  "- If the snapshot shows little or no activity, say exactly that in one short sentence.",
  "Write 2 to 3 short sentences. Plain prose only — no bullet points, no markdown, no headings.",
].join("\n");

const USER_PREFIXES: Record<InsightKind, string> = {
  activity:
    "Here is this period's operating-activity snapshot (quote pipeline, throughput, stalled items, staff):",
  lead:
    "Here is this period's lead-pipeline snapshot (funnel, conversion, close rates by source):",
};

/**
 * Remove `org_id` (the only tenant identifier the aggregates carry) so it never
 * reaches a model. Non-object payloads pass through untouched.
 */
function stripOrgId(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const { org_id: _omit, ...rest } = payload as Record<string, unknown>;
    void _omit;
    return rest;
  }
  return payload;
}

function buildUserPrompt(kind: InsightKind, payload: unknown): string {
  return `${USER_PREFIXES[kind]}\n${JSON.stringify(stripOrgId(payload), null, 2)}`;
}

/** Only the two known LLM vendors are trusted to narrate; else degrade to null. */
function isSupportedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai";
}

/**
 * Generate a narrative for a deterministic insight payload, or `null` when the
 * feature is off or the model cannot be trusted. Never throws.
 */
export async function generateInsightNarrative(
  kind: InsightKind,
  payload: unknown,
): Promise<InsightNarrative | null> {
  const provider = getTextProvider();
  if (!provider) return null; // feature off → deterministic-only
  if (!isSupportedProvider(provider.info.provider)) return null;

  const prompt = buildUserPrompt(kind, payload);

  const startedAt = Date.now();
  let result: TextResult;
  try {
    result = await provider.generate(prompt, {
      system: INSIGHT_NARRATIVE_SYSTEM,
      temperature: 0, // bounded determinism — stable narration of fixed facts
      maxTokens: NARRATIVE_MAX_TOKENS,
      signal: AbortSignal.timeout(NARRATIVE_TIMEOUT_MS),
    });
  } catch (err) {
    // Transient provider failure → the deterministic UI stays intact.
    console.error("[ai/insights] narrative generation failed", err);
    return null;
  }
  const latencyMs = Date.now() - startedAt;

  const text = result.text.trim();
  if (text.length === 0) return null;

  return {
    text,
    provider: provider.info.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: textCostUsd(provider.info, result),
    latencyMs,
  };
}
