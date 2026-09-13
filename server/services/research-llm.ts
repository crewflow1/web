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
  TIER_MODEL,
} from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import { acceptsSampling } from "@/lib/ai/text/anthropic";
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
 * SINGLE-VENDOR BY DESIGN (2026-09-10 census fix). This leg used to fall back
 * to a hard-coded `gpt-4o-mini` when `OPENAI_API_KEY` was present — a model
 * the registry never authorised, executed while the governor settled at the
 * bound high-tier (Opus) envelope. Execution and accounting must never
 * diverge, so the fallback is gone: the ONLY model this leg may run is the
 * one the high-tier binding names. A failed call returns `usage: null`, which
 * tells the governor NO PROVIDER WAS REACHED so it releases the claim instead
 * of inventing a phantom invocation, and the runner proceeds on the
 * deterministic evidence (`degradesTo`).
 */
async function callJsonWithProvider(
  system: string,
  user: string,
  maxTokens: number,
): Promise<GovernedCall<LlmText | null>> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { value: null, usage: null };

  // Resolved from the canonical HIGH binding — this service registered its two
  // features as complex→high, so the ONLY model this leg may run is the one
  // the high-tier binding names. HARD READ, no literal fallback (2026-09-13
  // hardening): callJson's isTierActivated("high") gate refuses before this
  // leg when the tier is dark, so a null binding here means that guarantee
  // broke. `usage: null` tells the governor NO PROVIDER WAS REACHED — the
  // claim is released and the runner proceeds on the deterministic evidence.
  const binding = TIER_MODEL.high;
  if (!binding) return { value: null, usage: null };
  const anthropicModel = binding.model;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicKey });
    const msg = await client.messages.create(
      {
        model: anthropicModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        // 4.6+ models think ADAPTIVELY by default and thinking tokens consume
        // max_tokens — a research cap shared with thinking risks truncated or
        // empty JSON. Same compatibility rule as the shared adapter
        // (lib/ai/text/anthropic.ts).
        ...(acceptsSampling(anthropicModel)
          ? {}
          : { thinking: { type: "disabled" as const } }),
      },
      { signal: AbortSignal.timeout(RESEARCH_LLM_TIMEOUT_MS) },
    );
    const block = msg.content[0];
    if (block && block.type === "text" && block.text.trim()) {
      return {
        value: { text: block.text, provider: "anthropic" },
        usage: {
          provider: "anthropic",
          model: msg.model ?? anthropicModel,
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
        },
      };
    }
  } catch (e) {
    console.error("[research-llm] anthropic call failed", {
      err: e instanceof Error ? e.message : String(e),
    });
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
