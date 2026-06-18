import "server-only";

/**
 * CrewFlow HQ — Research AI model layer (CEO Directive 005, Phases 2–5).
 *
 * The ONLY place Research AI calls a model provider. It takes the prompt
 * messages built from REAL fetched evidence (lib/research/prompts.ts), runs
 * them through Anthropic Claude Haiku 4.5 (preferred) → OpenAI gpt-4o-mini
 * (fallback), parses + re-validates the JSON, and returns typed contracts with
 * provenance.
 *
 * Graceful degradation is a first-class behaviour, not an error path: when no
 * provider key is configured, or a call times out / fails / returns
 * unparseable output, this returns null. The runner then proceeds on the
 * deterministic evidence alone and stamps the artifacts `deterministic` — the
 * directive's "unknown is acceptable" applied to the model itself.
 *
 * Timeout is generous (22s) versus the dashboard summaries' 8s because the
 * runner route sets maxDuration=60 and makes at most two of these calls; Haiku
 * typically returns in 1–3s, so the ceiling only bites on a degraded provider.
 */

import { isAiConfigured } from "@/lib/ai/safety";
import type { ResearchProvenance } from "@/lib/research/model";
import {
  buildAnalysisMessages,
  buildSalesMessages,
  parseAnalysis,
  parseSalesPrep,
  type AnalysisPromptInput,
  type ParsedAnalysis,
  type ParsedSalesPrep,
  type SalesPromptInput,
} from "@/lib/research/prompts";

const RESEARCH_LLM_TIMEOUT_MS = 22_000;
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_MODEL = "gpt-4o-mini";

type LlmProvider = Exclude<ResearchProvenance, "deterministic">;

type LlmText = { text: string; provider: LlmProvider };

/**
 * One JSON-mode completion. Returns the raw text + which provider answered,
 * or null on no-key / timeout / failure. Anthropic first, OpenAI fallback.
 */
async function callJson(
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmText | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return null;

  if (anthropicKey) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        },
        { signal: AbortSignal.timeout(RESEARCH_LLM_TIMEOUT_MS) },
      );
      const block = msg.content[0];
      if (block && block.type === "text" && block.text.trim()) {
        return { text: block.text, provider: "anthropic" };
      }
    } catch (e) {
      console.error("[research-llm] anthropic call failed", {
        err: e instanceof Error ? e.message : String(e),
      });
      // Fall through to OpenAI if we have a key for it.
    }
  }

  if (openaiKey) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: openaiKey });
      const res = await client.chat.completions.create(
        {
          model: OPENAI_MODEL,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        { signal: AbortSignal.timeout(RESEARCH_LLM_TIMEOUT_MS) },
      );
      const text = res.choices[0]?.message?.content?.trim();
      if (text) return { text, provider: "openai" };
    } catch (e) {
      console.error("[research-llm] openai call failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return null;
}

/** True when at least one provider key is present (the runner branches on it). */
export function researchAiEnabled(): boolean {
  return isAiConfigured();
}

export type AnalysisOutcome = {
  analysis: ParsedAnalysis;
  provider: LlmProvider;
} | null;

/** Phases 2–3: interpret the fetched evidence into intelligence + DMs. */
export async function runResearchAnalysis(
  input: AnalysisPromptInput,
): Promise<AnalysisOutcome> {
  const { system, user } = buildAnalysisMessages(input);
  const out = await callJson(system, user, 2800);
  if (!out) return null;
  const analysis = parseAnalysis(out.text);
  if (!analysis) return null;
  return { analysis, provider: out.provider };
}

export type SalesPrepOutcome = {
  prep: ParsedSalesPrep;
  provider: LlmProvider;
} | null;

/** Phases 4–5: turn the analysis + score into a brief + draft outreach. */
export async function runResearchSalesPrep(
  input: SalesPromptInput,
): Promise<SalesPrepOutcome> {
  const { system, user } = buildSalesMessages(input);
  const out = await callJson(system, user, 3200);
  if (!out) return null;
  const prep = parseSalesPrep(out.text);
  if (!prep) return null;
  return { prep, provider: out.provider };
}
