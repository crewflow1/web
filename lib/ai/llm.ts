import "server-only";

/**
 * LLM integration for the AI insight endpoints.
 *
 * Calls Anthropic Claude Haiku 4.5 (preferred) or OpenAI gpt-4o-mini
 * (fallback) to turn the deterministic insight JSON into a 2-3 sentence
 * prose summary.
 *
 * Privacy posture:
 *   - The payload passed to the LLM is the aggregate JSON the endpoints
 *     already build — counts, latencies, names already visible to the
 *     org. No actor IDs, JWTs, IP hashes, or accept_signature blobs
 *     are passed in. Callers also strip org_id before invoking.
 *   - On timeout, rate limit, or any thrown error we swallow and return
 *     null. The dashboard renders the deterministic data only —
 *     degradation is invisible to the user.
 *
 * Model choices (set in code, not env, so they can be tuned in PR):
 *   - Anthropic: claude-haiku-4-5 — fast + cheap for ~3-sentence summaries
 *   - OpenAI:    gpt-4o-mini
 *
 * Timeout: 8s. Tuned for daily/weekly summaries on the Vercel free-tier
 * 10s function limit. Haiku 4.5 typically responds in 600-1200ms.
 */

const LLM_TIMEOUT_MS = 8000;

type SummaryKind = "activity" | "lead";

const PROMPTS: Record<SummaryKind, string> = {
  activity: [
    "You are summarising the past week of operating activity for a UK construction firm using CrewFlow.",
    "Here is the deterministic JSON snapshot of what happened in that org:",
    "{{PAYLOAD}}",
    "Write 2 to 3 short sentences (no bullet points, no markdown).",
    "Focus on: the most consequential conversion/throughput signal, any single stalled item worth attention, the strongest staff or source signal if material.",
    "Do not restate raw numbers — interpret them. Do not speculate beyond the data.",
    "If nothing material happened this week, say so plainly in one sentence.",
  ].join("\n"),
  lead: [
    "You are summarising the lead pipeline for a UK construction firm using CrewFlow.",
    "Here is the JSON snapshot of conversion + close-rate stats:",
    "{{PAYLOAD}}",
    "Write 2 to 3 short sentences (no bullet points, no markdown).",
    "Focus on: where the pipeline is biggest right now, which source is converting best/worst, and any obvious bottleneck stage.",
    "Do not restate raw numbers — interpret them. Do not speculate beyond the data.",
  ].join("\n"),
};

function buildPrompt(kind: SummaryKind, payload: unknown): string {
  // Pretty-print so the LLM sees structure, not a wall of text.
  const serialised = JSON.stringify(payload, null, 2);
  return PROMPTS[kind].replace("{{PAYLOAD}}", serialised);
}

/**
 * Try to generate a one-paragraph natural-language summary.
 *
 * Returns null when no provider is configured or any call fails.
 * Callers should treat null as "render only the deterministic data".
 */
export async function maybeGenerateSummary(
  kind: SummaryKind,
  payload: unknown,
): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return null;

  const prompt = buildPrompt(kind, payload);

  try {
    if (anthropicKey) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create(
        {
          model: "claude-haiku-4-5",
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        },
        { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
      );
      const block = msg.content[0];
      if (block && block.type === "text") {
        return block.text.trim() || null;
      }
      return null;
    }

    // OpenAI fallback if only that key is set.
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: openaiKey });
    const res = await client.chat.completions.create(
      {
        model: "gpt-4o-mini",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
    );
    const text = res.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    // Silent degradation — the deterministic data is still useful.
    console.error("[ai/llm] summary generation failed", err);
    return null;
  }
}
