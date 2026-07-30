import "server-only";
import { buildRetentionSnapshot } from "@/server/services/retention-snapshot";
import { getTextProvider, textCostUsd } from "@/lib/ai/text";
import { invokeWithGovernor } from "@/lib/ai/governor";
import {
  AI_FORBIDDEN_ACTIONS,
  validateAiResponse,
  type AiResponse,
} from "@/lib/ai/safety";

/**
 * Phase 5 — AI question handler (Vision 2030 AI-2: the ONE model door).
 *
 * Customer types a question on /insights. We:
 *   1. Build a SLIM org snapshot (counts + recent totals only — no
 *      PII, no individual customer names, no contact details).
 *   2. Hand the question + snapshot to a model SOLELY through the shared
 *      provider abstraction (`lib/ai/text::getTextProvider`) — no vendor SDK
 *      is instantiated here, no API key is read here. Provider selection,
 *      graceful `null` degradation, and cost accounting are therefore the
 *      SAME seam the rest of the platform uses (Directive 009 Module 1).
 *   3. Return a structured `AiResponse` with confidence + sources.
 *
 * Safety: this handler is READ-ONLY. It cannot mutate any tenant row.
 * The directive's `AI_FORBIDDEN_ACTIONS` list is rendered to the
 * model as part of the system prompt so the LLM also knows the
 * boundaries. Temperature is pinned to 0 — the model DESCRIBES the
 * snapshot, it never invents a number the snapshot does not contain.
 *
 * GOVERNED. The model call passes through `invokeWithGovernor`
 * (lib/ai/governor.ts): the £100/org/month ceiling, the recent-duplicate
 * refusal, and the durable tokens/latency/cost ledger. Until this change the
 * only gates were `isAiConfigured()` and `getTextProvider()` — both bare
 * credential checks — so setting `ANTHROPIC_API_KEY` on a deploy would have
 * switched this TENANT-FACING answer box on with no ceiling and no ledger row.
 * Both refusals return the deterministic answer, which is exactly what this
 * handler already returns when no provider is configured, so the caller and the
 * UI learn no new outcome. The `isAiConfigured()` pre-check is GONE rather than
 * kept: it answered a question that no longer decides anything (a key without a
 * bound tier yields no provider), and leaving it would have left a bare
 * credential gate in the file for the next reader to copy.
 *
 * Cost: every model-backed answer ALSO records the provider's authoritative
 * token counts + `textCostUsd` price to the structured log — kept because it is
 * greppable in a way a database row is not, and because the ledger is empty
 * until a tier is bound.
 *
 * Org isolation: the slim snapshot is a purpose-built projection that carries
 * NO `org_id` and no PII, so nothing tenant-identifying ever reaches the
 * model. `org_id` appears only in the server-side cost log, for attribution.
 *
 * When no provider is configured, returns a deterministic fallback answer
 * built from the retention snapshot. The UI labels the response as
 * "deterministic" so operators know.
 */

const ANSWER_TIMEOUT_MS = 10_000;
const ANSWER_MAX_TOKENS = 800;

const SYSTEM_PROMPT = [
  "You are CrewFlow Insights, a read-only analytical assistant for a UK construction firm.",
  "",
  "STRICT RULES:",
  ...AI_FORBIDDEN_ACTIONS.map((rule) => `- ${rule}`),
  "",
  "RESPONSE FORMAT — return ONE JSON object only, no prose around it:",
  '{ "answer": "...", "confidence": "high"|"medium"|"low", "sources": [{"label": "..."}], "generated_by": "anthropic" }',
  "",
  "Keep `answer` to 2-3 sentences of plain prose. No markdown.",
  "`confidence` should be `high` when the answer is a literal restatement of provided numbers,",
  "`medium` when it's a reasoned interpretation, `low` if the data is thin or absent.",
  "Each item in `sources` is a short label like 'Invoices last 30d' or 'Open quotes'.",
].join("\n");

export async function askAi(input: {
  orgId: string;
  question: string;
}): Promise<AiResponse> {
  const { orgId, question } = input;

  // Always build the snapshot. Even when AI is configured we pass it as the
  // model's ONLY ground-truth source. The slim projection carries no org_id
  // and no PII — org isolation is structural here, not a strip step.
  const snap = await buildRetentionSnapshot(orgId);
  const slim = slimSnapshot(snap);

  // ONE model door — the shared provider abstraction. No vendor SDK, no API
  // key read: `getTextProvider()` owns selection, the governor's activation
  // requirement, and graceful null. When it yields nothing usable, the
  // deterministic answer stands in unchanged.
  const provider = getTextProvider();
  if (!provider || !isSupportedProvider(provider.info.provider)) {
    return deterministicAnswer(question, slim);
  }

  const userPrompt = `ORG SNAPSHOT JSON:\n${JSON.stringify(slim, null, 2)}\n\nQUESTION:\n${question}`;
  const startedAt = Date.now();

  try {
    const outcome = await invokeWithGovernor(
      "insights.question",
      "drafting",
      async () => {
        const generated = await provider.generate(userPrompt, {
          system: SYSTEM_PROMPT,
          temperature: 0,
          maxTokens: ANSWER_MAX_TOKENS,
          signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
        });
        return {
          value: generated,
          usage: {
            provider: provider.info.provider,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          },
        };
      },
      {
        orgId,
        // A tenant asked this, at a keyboard — unlike the narrative, there IS a
        // person. The signed-in user is not threaded this far today (the route
        // authenticates and passes orgId only), so this stays null rather than
        // guessing; the ledger's user_id is nullable for exactly this reason.
        userId: null,
        // The question plus the snapshot it is answered against: re-asking the
        // SAME question while nothing has changed is waste, but asking it again
        // after the data moves is not. Only the SHA-256 reaches the ledger.
        dedupeContent: userPrompt,
      },
    );
    // Over the ceiling, or the identical question already in flight: the
    // deterministic answer stands in, labelled `deterministic` so the UI can
    // say so. Identical to the no-provider leg.
    if (outcome.status !== "ran") {
      return deterministicAnswer(question, slim);
    }
    const result = outcome.value;

    const raw = extractJson(result.text);
    // `generated_by` is OUR truth (the provider that actually ran), not the
    // model's self-report — the model's value is overwritten before validation.
    const parsed = raw
      ? validateAiResponse({ ...raw, generated_by: provider.info.provider })
      : null;

    if (parsed) {
      // Cost — provider truth via textCostUsd, structured + greppable. No
      // per-answer DB row, so this line is the recording sink. org_id is for
      // attribution only; it never reached the model.
      console.info("[ai-question] answered", {
        org_id: orgId,
        provider: provider.info.provider,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: textCostUsd(provider.info, result),
        latency_ms: Date.now() - startedAt,
      });
      return parsed;
    }
  } catch (err) {
    // Unchanged: the governor RECORDS the failure and rethrows, so this catch
    // still owns the degraded path exactly as it did before.
    console.error("[ai-question] LLM call failed", err);
  }

  return deterministicAnswer(question, slim);
}

/**
 * The shared factory only ever yields Anthropic / OpenAI providers; this guard
 * is defence-in-depth and keeps `generated_by` truthful (an unknown vendor
 * would be mislabelled by the validator, so we degrade to deterministic).
 */
function isSupportedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai";
}

// ---------------------------------------------------------------------
// Slim snapshot — what the LLM is allowed to see
// ---------------------------------------------------------------------

type SlimSnapshot = {
  onboarding_pct: number;
  counts: {
    customers: number;
    quotes: number;
    invoices: number;
    staff: number;
    imports_committed: number;
  };
  overdue_invoices: number;
  support_open: number;
  unresolved_alerts: number;
  invoiced_total_gbp: number;
  last_7d: {
    customers_added: number;
    quotes_created: number;
    quotes_accepted: number;
    invoices_sent: number;
    invoiced_gbp: number;
    payments_received_gbp: number;
  };
  days_since_activity: number | null;
};

function slimSnapshot(snap: Awaited<ReturnType<typeof buildRetentionSnapshot>>): SlimSnapshot {
  const last = snap.last_activity_at;
  const days = last
    ? Math.floor(
        (new Date(snap.now).getTime() - new Date(last).getTime()) / 86_400_000,
      )
    : null;
  return {
    onboarding_pct: 0, // computed below
    counts: {
      customers: snap.onboarding.counts.customers,
      quotes: snap.onboarding.counts.quotes,
      invoices: snap.onboarding.counts.invoices,
      staff: snap.onboarding.counts.staffMembers,
      imports_committed: snap.onboarding.counts.importsCommitted,
    },
    overdue_invoices: snap.overdue_invoice_count,
    support_open: snap.support_open_count,
    unresolved_alerts: snap.unresolved_alerts_count,
    invoiced_total_gbp: snap.invoiced_total_gbp,
    last_7d: snap.windows.last_7d,
    days_since_activity: days,
  };
}

// ---------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------

function deterministicAnswer(
  question: string,
  slim: SlimSnapshot,
): AiResponse {
  const q = question.toLowerCase();
  const sources = [
    { label: "Customer + quote + invoice counts" },
    { label: "Last 7 days activity" },
  ];

  // Tiny keyword routing — covers the directive's "What should I
  // focus on" / "Which customers owe me" / "Where am I losing
  // profit" / "Summarise" pattern when AI isn't configured.
  if (q.includes("focus") || q.includes("this week") || q.includes("recommend")) {
    const top: string[] = [];
    if (slim.support_open > 0) top.push(`${slim.support_open} open support ticket${slim.support_open === 1 ? "" : "s"}`);
    if (slim.overdue_invoices > 0) top.push(`${slim.overdue_invoices} overdue invoice${slim.overdue_invoices === 1 ? "" : "s"}`);
    if (slim.last_7d.quotes_created === 0 && slim.counts.quotes > 0) top.push("no new quotes this week");
    const summary = top.length
      ? `Focus on: ${top.join(" · ")}.`
      : "Pipeline looks calm. A new quote keeps momentum.";
    return {
      answer: summary,
      confidence: "medium",
      sources,
      generated_by: "deterministic",
    };
  }

  if (q.includes("owe") || q.includes("overdue") || q.includes("unpaid")) {
    return {
      answer:
        slim.overdue_invoices > 0
          ? `You have ${slim.overdue_invoices} overdue invoice${slim.overdue_invoices === 1 ? "" : "s"}. Chase them from /invoices?status=overdue.`
          : "No overdue invoices right now.",
      confidence: "high",
      sources: [{ label: "Invoices (status=overdue)", href: "/invoices?status=overdue" }],
      generated_by: "deterministic",
    };
  }

  // Generic snapshot summary fallback.
  return {
    answer: [
      `You have ${slim.counts.customers} customers, ${slim.counts.quotes} quotes and ${slim.counts.invoices} invoices on the system.`,
      slim.last_7d.invoiced_gbp > 0
        ? `£${Math.round(slim.last_7d.invoiced_gbp).toLocaleString()} invoiced in the last 7 days.`
        : "No invoicing activity in the last 7 days.",
    ].join(" "),
    confidence: "high",
    sources,
    generated_by: "deterministic",
  };
}

// ---------------------------------------------------------------------
// JSON parsing helper — Claude/OpenAI sometimes wrap JSON in fences
// ---------------------------------------------------------------------

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip ```json fences if present.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    // Find the first { ... } block as a last resort.
    const m = unfenced.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
