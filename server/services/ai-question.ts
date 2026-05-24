import "server-only";
import { createClient } from "@/lib/supabase/server";
import { buildRetentionSnapshot } from "@/server/services/retention-snapshot";
import {
  AI_FORBIDDEN_ACTIONS,
  isAiConfigured,
  validateAiResponse,
  type AiResponse,
} from "@/lib/ai/safety";

/**
 * Phase 5 — AI question handler.
 *
 * Customer types a question on /insights. We:
 *   1. Build a SLIM org snapshot (counts + recent totals only — no
 *      PII, no individual customer names, no contact details).
 *   2. Send the question + snapshot to Claude (or OpenAI fallback).
 *   3. Return a structured `AiResponse` with confidence + sources.
 *
 * Safety: this handler is READ-ONLY. It cannot mutate any tenant row.
 * The directive's `AI_FORBIDDEN_ACTIONS` list is rendered to the
 * model as part of the system prompt so the LLM also knows the
 * boundaries.
 *
 * When no AI key is configured, returns a deterministic fallback
 * answer built from the retention snapshot. The UI labels the
 * response as "deterministic" so operators know.
 */

const ANSWER_TIMEOUT_MS = 10_000;

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

  // Always build the snapshot. Even when AI is configured we pass it
  // as the model's only ground-truth source.
  const snap = await buildRetentionSnapshot(orgId);
  const slim = slimSnapshot(snap);

  if (!isAiConfigured()) {
    return deterministicAnswer(question, slim);
  }

  // Defer model import so client bundles don't pull SDK weight.
  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create(
        {
          model: "claude-haiku-4-5",
          max_tokens: 800,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `ORG SNAPSHOT JSON:\n${JSON.stringify(slim, null, 2)}\n\nQUESTION:\n${question}`,
            },
          ],
        },
        { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) },
      );
      const block = msg.content[0];
      if (block && block.type === "text") {
        const raw = extractJson(block.text);
        const parsed = raw ? validateAiResponse({ ...raw, generated_by: "anthropic" }) : null;
        if (parsed) return parsed;
      }
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: openaiKey });
      const res = await client.chat.completions.create(
        {
          model: "gpt-4o-mini",
          max_tokens: 800,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `ORG SNAPSHOT JSON:\n${JSON.stringify(slim, null, 2)}\n\nQUESTION:\n${question}`,
            },
          ],
        },
        { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) },
      );
      const text = res.choices[0]?.message?.content;
      if (text) {
        const raw = extractJson(text);
        const parsed = raw ? validateAiResponse({ ...raw, generated_by: "openai" }) : null;
        if (parsed) return parsed;
      }
    }
  } catch (err) {
    console.error("[ai-question] LLM call failed", err);
  }

  return deterministicAnswer(question, slim);
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

// silence "unused import" if createClient ever stops being used
void createClient;
