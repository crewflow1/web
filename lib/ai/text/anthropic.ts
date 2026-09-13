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
 * Model: ALWAYS the caller's tier binding — the factory (`./index`) passes
 * `binding.model` and this transport has NO default of its own (2026-09-13
 * hardening: the old inert `DEFAULT_MODEL` fallback was a literal the registry
 * never authorised, one refactor away from running). The `@anthropic-ai/sdk`
 * is dynamically imported so it never enters a bundle that doesn't generate
 * text. `generate()` THROWS on failure — the worker owns skip / retry /
 * backoff and records the failure reason.
 */

import type { TextGenerationOptions, TextModelInfo, TextProvider, TextResult } from "./types";

/** Pre-4.6-generation models (Haiku 4.5) still accept sampling params and do
 *  not run default-on thinking; 4.6+ models (sonnet-5/opus-5) reject
 *  non-default temperature and think by default. */
export function acceptsSampling(model: string): boolean {
  return model.startsWith("claude-haiku-4-5");
}

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
 * across a batch. `model` is REQUIRED: only the factory's tier binding may
 * name a model, so a construction site that forgets one is a compile error,
 * never a silent literal.
 */
export function createAnthropicTextProvider(apiKey: string, model: string): TextProvider {
  const info: TextModelInfo = { provider: "anthropic", model };

  return {
    info,
    async generate(prompt: string, opts?: TextGenerationOptions): Promise<TextResult> {
      // Blank prompt: never touch the network (deterministic, free).
      if (prompt.trim().length === 0) {
        return { text: "", model, inputTokens: 0, outputTokens: 0, stopReason: null };
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const msg = await client.messages.create(
        {
          model,
          max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          // MODEL-AWARE compatibility (activation diff 2026-09-10, verified
          // against platform.claude.com the same day):
          //  · temperature is DEPRECATED on the 4.7+ generation — a
          //    non-default value 400s on claude-sonnet-5 / claude-opus-5 —
          //    but still honoured on Haiku 4.5, where our extraction callers'
          //    temperature:0 genuinely buys output stability. Forward it only
          //    where the API accepts it.
          //  · thinking is ON BY DEFAULT (adaptive) on sonnet-5/opus-5, and
          //    thinking tokens are drawn from max_tokens — a 200-token draft
          //    cap shared with thinking returns truncated/empty text. These
          //    single-shot, tool-free drafting calls disable it explicitly
          //    (accepted at default effort on both models).
          ...(acceptsSampling(model) && opts?.temperature != null
            ? { temperature: opts.temperature }
            : {}),
          ...(acceptsSampling(model) ? {} : { thinking: { type: "disabled" as const } }),
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
        // Vendor truth: "max_tokens" here means the text above is TRUNCATED.
        stopReason: msg.stop_reason ?? null,
      };
    },
  };
}
