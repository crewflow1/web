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
 *
 * GOVERNED (closure wave). This module was NOT in the audit's list of five — it
 * was found by sweeping for provider-SDK constructions rather than for
 * `isAiConfigured()` gates, and it is the most expensive path of the set: two
 * calls per research run at 2,800 and 3,200 output tokens, on the `complex`
 * class. It read both vendor keys itself and constructed both SDKs itself, so a
 * credential on a deploy would have run them with no £100/month ceiling and no
 * ledger row. Now:
 *
 *   • the gate is `isTierActivated("high")` — this class's OWN bound tier, not a key
 *     and not any-tier-somewhere;
 *   • each call passes through `invokeWithGovernor` under its own feature key
 *     (`research.analysis` / `research.sales_prep`) so the HQ per-feature cost
 *     view can tell the two apart;
 *   • both governor refusals return `null`, which is precisely what this module
 *     already returns for "no key / timeout / unparseable", so the runner's
 *     existing deterministic path handles them with no change.
 *
 * WHOSE BUDGET: HQ research has no tenant, so it bills CrewFlow's own
 * organisation row — see lib/ai/governor/attribution.ts for why that beats a
 * nullable org column, and for the product question it raises.
 */

import {
  invokeWithGovernor,
  isTierActivated,
  type AiFeature,
  type GovernedCall,
} from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
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
 * One GOVERNED JSON-mode completion. Returns the raw text + which provider
 * answered, or null on not-activated / no-budget-org / budget refusal /
 * duplicate / timeout / failure. Anthropic first, OpenAI fallback.
 *
 * `feature` is passed in by each caller rather than fixed here, so the two
 * research calls are accounted for separately in the ledger. The vendor
 * FALLBACK stays inside the governed function on purpose: an Anthropic attempt
 * that fails and an OpenAI attempt that succeeds are ONE unit of work against
 * the budget, and reserving twice for one logical call would double-count the
 * claim against the ceiling.
 */
async function callJson(
  feature: AiFeature,
  system: string,
  user: string,
  maxTokens: number,
): Promise<LlmText | null> {
  // Not activated → null, and the runner proceeds deterministically. This is the
  // gate that makes a stray credential inert; the key reads below are only ever
  // reached once a cost tier is bound.
  // PER-TIER, not global: this service runs 'complex' work on the HIGH tier
  // and constructs its own SDK client, so the global any-tier predicate is the
  // wrong gate — an embedding-only activation (which necessarily ships an
  // OPENAI_API_KEY) would flip it true and this fn would spend ungoverned
  // through the per-tier dark short-circuit. Its OWN tier must be armed.
  if (!isTierActivated("high")) return null;

  const budgetOrgId = hqBudgetOrgId();
  // FAIL CLOSED. No org to bill ⇒ no governed call. Spending unattributed would
  // be spending outside the ceiling, which is the defect, not the fallback.
  if (!budgetOrgId) return null;

  try {
    const outcome = await invokeWithGovernor(
      feature,
      "complex",
      () => callJsonWithProvider(system, user, maxTokens),
      {
        orgId: budgetOrgId,
        userId: null,
        // The exact prompt: re-running an unchanged research prompt inside the
        // window buys the identical interpretation. Only its SHA-256 is stored.
        dedupeContent: `${system} ${user}`,
      },
    );
    // `blocked` / `duplicate` → null, the module's existing "no model" value.
    if (outcome.status !== "ran") return null;
    return outcome.value;
  } catch {
    // Every provider error is already caught inside `callJsonWithProvider`, so
    // reaching here means the governor itself rethrew something. Same contract:
    // null, and the runner proceeds on the deterministic evidence.
    return null;
  }
}

/**
 * The provider leg, isolated so the governor can time it and account for it.
 *
 * NOTE THE ACCOUNTING SUBTLETY. This function may make TWO vendor calls (an
 * Anthropic attempt, then an OpenAI fallback). It reports the usage of whichever
 * one ANSWERED. A failed first attempt has usually billed its input tokens, so
 * that is a known, bounded under-count of at most one failed call per run —
 * stated here rather than hidden, and much smaller than the alternative error of
 * reserving budget twice for one logical call. It never throws: an exhausted
 * fallback chain returns `usage: null`, which tells the governor NO PROVIDER WAS
 * REACHED so it releases the claim instead of inventing a phantom invocation.
 */
async function callJsonWithProvider(
  system: string,
  user: string,
  maxTokens: number,
): Promise<GovernedCall<LlmText | null>> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return { value: null, usage: null };

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
        return {
          value: { text: block.text, provider: "anthropic" },
          usage: {
            provider: "anthropic",
            model: msg.model ?? ANTHROPIC_MODEL,
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          },
        };
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
      if (text) {
        return {
          value: { text, provider: "openai" },
          usage: {
            provider: "openai",
            model: res.model ?? OPENAI_MODEL,
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
          },
        };
      }
    } catch (e) {
      console.error("[research-llm] openai call failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Nothing answered. `usage: null` is load-bearing: it tells the governor no
  // provider was reached, so the budget claim is RELEASED rather than settled as
  // a phantom invocation.
  return { value: null, usage: null };
}

/**
 * True when a governed research call could actually reach a model (the runner
 * branches on it).
 *
 * It used to be `isAiConfigured()` — "a key is present" — which is a different
 * and weaker claim: with a key set and no cost tier bound, the runner would take
 * its AI branch and every call inside it would return null. `isTierActivated("high")`
 * is the honest predicate and it is the SAME one `callJson` gates on, so the
 * runner's branch and the calls inside it can no longer disagree.
 */
export function researchAiEnabled(): boolean {
  return isTierActivated("high");
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
  const out = await callJson("research.analysis", system, user, 2800);
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
  const out = await callJson("research.sales_prep", system, user, 3200);
  if (!out) return null;
  const prep = parseSalesPrep(out.text);
  if (!prep) return null;
  return { prep, provider: out.provider };
}
