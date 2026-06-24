/**
 * Shared Memory — text-generation cost accounting.
 *
 * CEO Directive 009 Module 1, PR5. "Every AI action measurable" (Volume X
 * §10): each lifecycle summarisation / consolidation records what it cost. As
 * with embeddings, pricing is PROVIDER METADATA, not a constant of the Memory
 * Engine — adding a provider/model adds a row here and never touches
 * application code. Pure functions, no SDK, no `server-only`, deterministic,
 * unit-tested in isolation.
 */

/**
 * "Version 1" LLM pricing — USD per 1,000,000 tokens, split input/output
 * because LLM vendors bill the two differently. Keyed by `${provider}:${model}`.
 * Values current as of 2026-06.
 */
const PRICE_PER_MTOK_USD: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic:claude-3-5-haiku-latest": { input: 0.8, output: 4 },
  "anthropic:claude-sonnet-4-5": { input: 3, output: 15 },
  // OpenAI
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10 },
};

/**
 * Cost in USD for a generation against a provider/model. Returns `null` when
 * the model's price is unknown — cost is OBSERVABILITY, never a correctness
 * gate, so an unpriced model still runs; its cost is simply recorded as
 * unknown. Mirrors `embeddingCostUsd` exactly.
 */
export function textCostUsd(
  info: { provider: string; model: string },
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const rate = PRICE_PER_MTOK_USD[`${info.provider}:${info.model}`];
  if (rate === undefined) return null;
  return (usage.inputTokens / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
}
