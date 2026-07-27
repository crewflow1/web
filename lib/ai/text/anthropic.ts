import "server-only";

/**
 * Shared Memory — Anthropic text provider ("Version 1", preferred).
 *
 * CEO Directive 009 Module 1, PR5. This is ONE implementation of
 * `TextProvider`, not the engine's dependency: the Memory Engine never imports
 * this file — it asks the factory (`./index`) for "a provider" and gets
 * whatever configuration selects. Swapping vendors adds a sibling file and a
 * factory branch; the worker does not change.
 *
 * Model: `claude-haiku-4-5` — fast + cheap for short summaries, matching the
 * preference already in `lib/ai/llm.ts`. The `@anthropic-ai/sdk` is
 * dynamically imported so it never enters a bundle that doesn't generate text.
 * `generate()` THROWS on failure — the worker owns skip / retry / backoff and
 * records the failure reason.
 */

import type { TextGenerationOptions, TextModelInfo, TextProvider, TextResult } from "./types";

const DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * 20s. Generous, matching the embedding provider: the lifecycle worker runs on
 * the Node runtime (maxDuration 60s), not inline in a request, so it can wait
 * for a summary without risking a request timeout.
 */
const TEXT_TIMEOUT_MS = 20_000;

/** Default output cap — summaries are short; bounds cost and latency. */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Build the Anthropic provider for a given key. Pure construction — no network
 * call here, so the factory can hand one out cheaply and the worker reuses it
 * across a batch.
 */
export function createAnthropicTextProvider(apiKey: string, model: string = DEFAULT_MODEL): TextProvider {
  const info: TextModelInfo = { provider: "anthropic", model };

  return {
    info,
    async generate(prompt: string, opts?: TextGenerationOptions): Promise<TextResult> {
      // Blank prompt: never touch the network (deterministic, free).
      if (prompt.trim().length === 0) {
        return { text: "", model, inputTokens: 0, outputTokens: 0 };
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const msg = await client.messages.create(
        {
          model,
          max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(opts?.temperature != null ? { temperature: opts.temperature } : {}),
          ...(opts?.system ? { system: opts.system } : {}),
          messages: [{ role: "user", content: prompt }],
        },
        { signal: opts?.signal ?? AbortSignal.timeout(TEXT_TIMEOUT_MS) },
      );

      // Concatenate every text block, then trim — defends against the model
      // splitting its answer across blocks.
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();

      return {
        text,
        model: msg.model ?? model,
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
      };
    },
  };
}
