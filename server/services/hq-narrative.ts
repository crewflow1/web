import "server-only";
import { getTextProvider, type TextResult } from "@/lib/ai/text";
import { invokeWithGovernor } from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import type { AiFeature } from "@/lib/ai/governor/registry";

/**
 * CrewFlow HQ — the SHARED board-narrative generator (the one governed door for
 * every super-admin boardroom blurb).
 *
 * Ten HQ surfaces (Finance, CTO, Operations, Marketing, Product, Customer
 * Success, QA, Executive Assistant, Sales Orchestrator, Support) each compute a
 * DETERMINISTIC board in a pure layer (lib/hq/*) and want a short prose summary
 * ABOVE the deterministic cards. This module turns a finished board into that
 * 2–4 sentence blurb, and it is the ONLY place any of those boards reaches a
 * language model. It is the HQ analogue of the tenant-facing
 * `lib/ai/insight-narrative.ts`, built to the same doctrine.
 *
 * NARRATIVE, NOT AUTHORITY. The model is handed the FINISHED deterministic board
 * and asked only to describe it. It never computes a metric, never invents a
 * number, never recommends action beyond what the board shows, and never states
 * business state absent from the board. Its entire output is the prose blurb the
 * page renders above the cards. Every figure a super-admin sees comes from the
 * pure board compute, not the model, so a hallucination can never change a
 * displayed fact.
 *
 * ONE MODEL DOOR. Generation reaches a model SOLELY through
 * `lib/ai/text::getTextProvider` — no vendor SDK is constructed here — so cost
 * accounting and graceful degradation are the same seam the rest of the platform
 * uses. Keeping this logic in ONE module (rather than duplicating ~40 lines of
 * governor plumbing into each of the ten HQ services) is why each HQ aggregator
 * stays a thin shim that constructs no SDK and opens no door itself.
 *
 * WHOSE BUDGET. HQ is not a tenant, and the governor ledger's `org_id` is NOT
 * NULL for good reason (lib/ai/governor/attribution.ts). HQ's own AI spend is
 * billed to CrewFlow's own organisation row (`hqBudgetOrgId()`). Unset ⇒ FAIL
 * CLOSED to `null` (the deterministic-only board): an invocation nobody is billed
 * for is an invocation outside the £100/month ceiling, which is the defect this
 * lane exists to remove.
 *
 * GOVERNED, FAIL-CLOSED. The provider call passes through `invokeWithGovernor`
 * (the ceiling, the recent-duplicate refusal, the ledger). A budget refusal, a
 * duplicate, a provider throw/timeout, an empty generation, an unbound tier, an
 * unsupported vendor, or a missing HQ budget org ALL return `null` — which every
 * caller renders as "deterministic cards only", identical to the empty state the
 * boards already show. No caller learns a new outcome.
 *
 * DARK BY DEFAULT. With no generative tier bound, `getTextProvider()` returns
 * `null` and this returns `null` before the governor is reached — the boards
 * render exactly as they do today. Binding a tier (plus the vendor credential and
 * `CREWFLOW_INTERNAL_ORG_ID`) is what begins populating the blurb; there is no
 * other switch, which is what makes each admin page's "populates once a model
 * tier is bound" empty state honest.
 *
 * THE ONE DOCTRINE CAVEAT, stated because the governor's header demands it. "AI
 * wakes on meaningful change, never on page load" — and these loaders are reached
 * from a PAGE RENDER (each app/admin/*-ai page). The board is deterministic for a
 * given day, so the exact prompt is stable across refreshes; the governor's
 * dedupe window is therefore a REAL backstop against a super-admin refreshing a
 * dashboard, not a formality. Moving narration onto an event is the proper fix
 * and is a separate change — it is not required to keep this dark and governed.
 */

/** The HQ board-narrative feature keys, derived from the registry so the two cannot drift. */
export type HqNarrativeFeature = Extract<AiFeature, `hq.${string}_narrative`>;

const NARRATIVE_TIMEOUT_MS = 8000;
const NARRATIVE_MAX_TOKENS = 400;

/** Per-board framing: the analyst role and the one-line lead-in over the board JSON. */
type BoardPrompt = { readonly role: string; readonly prefix: string };

const BOARD_PROMPTS: Readonly<Record<HqNarrativeFeature, BoardPrompt>> = {
  "hq.finance_narrative": {
    role: "CrewFlow HQ's finance analyst",
    prefix:
      "Here is the deterministic HQ finance board (recurring revenue, margins, runway, CAC — any metric without a data source is marked insufficient):",
  },
  "hq.cto_narrative": {
    role: "CrewFlow HQ's engineering-health analyst",
    prefix:
      "Here is the deterministic HQ engineering-health board (launch readiness, task-pipeline reliability, executor-shadow safety, AI cost, customer-health bands):",
  },
  "hq.operations_narrative": {
    role: "CrewFlow HQ's operations analyst",
    prefix:
      "Here is the deterministic HQ operations-health board (system/cron/email telemetry, open alerts by severity, the AI task queue):",
  },
  "hq.marketing_narrative": {
    role: "CrewFlow HQ's marketing analyst",
    prefix:
      "Here is the deterministic HQ marketing board (demo-request top-of-funnel and customer-acquisition figures):",
  },
  "hq.product_narrative": {
    role: "CrewFlow HQ's product analyst",
    prefix:
      "Here is the deterministic HQ product board (feature-request/support demand signals and product adoption/usage):",
  },
  "hq.customer_success_narrative": {
    role: "CrewFlow HQ's customer-success analyst",
    prefix:
      "Here is the deterministic HQ customer-success board (retention, health bands, onboarding progress, churn):",
  },
  "hq.qa_narrative": {
    role: "CrewFlow HQ's AI-quality analyst",
    prefix:
      "Here is the deterministic HQ AI-quality board (executor-shadow outcomes, reply-audit verdicts, conversation outcomes, task reliability):",
  },
  "hq.executive_assistant_narrative": {
    role: "CrewFlow HQ's executive assistant",
    prefix:
      "Here is the deterministic HQ \"what needs the human\" digest (open approvals, pending decisions, overdue/stalled tasks, open alerts):",
  },
  "hq.sales_orchestrator_narrative": {
    role: "CrewFlow HQ's sales-pipeline analyst",
    prefix:
      "Here is the deterministic HQ sales-orchestrator board (deal pipeline, the research/qualification/outreach drain queues, outreach cadence health):",
  },
  "hq.support_ai_narrative": {
    role: "CrewFlow HQ's support-triage analyst",
    prefix:
      "Here is the deterministic HQ support-triage board (ticket volumes, priority mix, resolution posture):",
  },
};

/**
 * The safety framing — a fixed constant per role. No board content can steer it.
 * It confines the model to NARRATION of the supplied board and forbids invention.
 */
export function hqNarrativeSystemPrompt(role: string): string {
  return [
    `You are ${role}, a read-only analyst for CrewFlow, a UK construction SaaS platform.`,
    "You are given a deterministic JSON snapshot of one CrewFlow HQ board that has ALREADY been computed for you.",
    "Your ONLY job is to describe, in plain prose, what that snapshot shows to a CrewFlow super-admin.",
    "STRICT RULES:",
    "- Do NOT invent, estimate, or compute any number, currency amount or percentage that is not literally present in the snapshot.",
    "- Do NOT recommend actions, next steps, or strategy beyond what the snapshot itself plainly implies.",
    "- Do NOT state any business fact (customers, revenue, staff, outcomes) that is not in the snapshot.",
    "- Treat any metric marked insufficient, unavailable or unknown as genuinely unknown — never fill it in.",
    "- Do NOT restate the raw numbers mechanically — interpret what they mean, but never beyond the data.",
    "- If the snapshot shows little or no signal, say exactly that in one short sentence.",
    "Write 2 to 4 short sentences. Plain prose only — no bullet points, no markdown, no headings.",
  ].join("\n");
}

/** Identifier-like keys stripped before a board is serialised into a prompt. */
const ORG_IDENTIFIER_KEY = /^(org|organization|organisation|tenant)_?id$/i;

/**
 * Recursively remove organisation/tenant identifiers from a board before it is
 * serialised into a prompt, so no such identifier ever reaches a model. The HQ
 * aggregators already strip tenant PII before they build the board (they pass
 * only aggregate counts and labels), so this is belt-and-braces — but it holds
 * regardless of what any future board reader passes in.
 */
function stripOrgIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOrgIdentifiers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ORG_IDENTIFIER_KEY.test(k)) continue;
      out[k] = stripOrgIdentifiers(v);
    }
    return out;
  }
  return value;
}

/** Only the two known LLM vendors are trusted to narrate; else degrade to null. */
function isSupportedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai";
}

/**
 * Generate a prose narrative for one deterministic HQ board, or `null` when the
 * feature is dark, the model cannot be trusted, or the governor refuses. Never
 * throws — every degraded leg returns `null`, which each caller renders as the
 * deterministic-only board.
 */
export async function generateHqBoardNarrative(
  feature: HqNarrativeFeature,
  board: unknown,
): Promise<string | null> {
  const provider = getTextProvider();
  if (!provider) return null; // dark / no generative tier bound → deterministic-only
  if (!isSupportedProvider(provider.info.provider)) return null;

  // HQ has no tenant; its spend is billed to CrewFlow's own org row. Unset ⇒
  // FAIL CLOSED — an unattributed invocation is one outside the ceiling.
  const budgetOrgId = hqBudgetOrgId();
  if (!budgetOrgId) return null;

  const cfg = BOARD_PROMPTS[feature];
  const system = hqNarrativeSystemPrompt(cfg.role);
  const prompt = `${cfg.prefix}\n${JSON.stringify(stripOrgIdentifiers(board), null, 2)}`;

  let result: TextResult;
  try {
    const outcome = await invokeWithGovernor(
      feature,
      "drafting",
      async () => {
        const generated = await provider.generate(prompt, {
          system,
          temperature: 0, // bounded determinism — stable narration of fixed facts
          maxTokens: NARRATIVE_MAX_TOKENS,
          signal: AbortSignal.timeout(NARRATIVE_TIMEOUT_MS),
        });
        return {
          value: generated,
          // The vendor's own billed counts — the ledger records provider truth.
          usage: {
            provider: provider.info.provider,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          },
        };
      },
      {
        orgId: budgetOrgId,
        // A page-render-initiated generation: no signed-in human authored it as
        // a deliberate act, and the spend is CrewFlow's own.
        userId: null,
        // The board is deterministic for a given day, so the same board narrated
        // twice within the window is the same paragraph. Only its SHA-256 reaches
        // the ledger — never the figures.
        dedupeContent: `${feature} ${prompt}`,
      },
    );
    // Over the ceiling, or an identical narration already in flight/recent: the
    // deterministic cards render alone, exactly as they do with no provider.
    if (outcome.status !== "ran") return null;
    result = outcome.value;
  } catch (err) {
    // Transient provider failure → the deterministic board stays intact. The
    // governor has already recorded the failure (when active) and rethrown.
    console.error(`[hq-narrative] ${feature} generation failed`, err);
    return null;
  }

  const text = result.text.trim();
  return text.length === 0 ? null : text;
}
