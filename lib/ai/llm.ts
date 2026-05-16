import "server-only";

/**
 * LLM scaffold for the AI insight endpoints.
 *
 * Phase 5 prep: this module is wired into /api/ai/activity_summary and
 * /api/ai/lead_insights but does nothing today because neither key is
 * set in Vercel. When ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY
 * lands in Vercel prod, the call goes live with no further code
 * changes — the response's `summary` field gets populated with prose.
 *
 * Privacy posture:
 *   - The payload passed to the LLM is the aggregate JSON the endpoints
 *     already build — counts, latencies, names already visible to the
 *     org. No actor IDs, JWTs, IP hashes, or accept_signature blobs
 *     are passed in.
 *   - On any error (rate limit, timeout, malformed response) we
 *     swallow the error and return null. The dashboard renders just
 *     the deterministic data — degradation is invisible to the user.
 *
 * Model choices (set in code, not env, so they can be tuned in PR):
 *   - Anthropic: claude-haiku-4-5 — fast + cheap for ~3-sentence summaries
 *   - OpenAI:    gpt-4o-mini
 */

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
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const block = msg.content[0];
      if (block && block.type === "text") {
        return block.text.trim() || null;
      }
      return null;
    }

    // OpenAI fallback if only that key is set.
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: openaiKey });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    // Silent degradation — the deterministic data is still useful.
    console.error("[ai/llm] summary generation failed", err);
    return null;
  }
}
