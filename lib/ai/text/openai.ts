import "server-only";

/**
 * Shared Memory — OpenAI text provider (fallback).
 *
 * CEO Directive 009 Module 1, PR5. ONE implementation of `TextProvider`,
 * selected by configuration when Anthropic is not the active vendor (or as the
 * `auto` fallback when only `OPENAI_API_KEY` is set). The Memory Engine never
 * imports this file directly. Mirrors `lib/ai/text/anthropic.ts`: the `openai`
 * SDK is dynamically imported, and `generate()` THROWS on failure so the worker
 * owns skip / retry / backoff.
 *
 * Model: `gpt-4o-mini` — matches the fallback already in `lib/ai/llm.ts`.
 */

import type { TextGenerationOptions, TextModelInfo, TextProvider, TextResult } from "./types";

const DEFAULT_MODEL = "gpt-4o-mini";
const TEXT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Build the OpenAI provider for a given key. Pure construction — no network
 * call here, so the factory can hand one out cheaply.
 */
export function createOpenAiTextProvider(apiKey: string, model: string = DEFAULT_MODEL): TextProvider {
  const info: TextModelInfo = { provider: "openai", model };

  return {
    info,
    async generate(prompt: string, opts?: TextGenerationOptions): Promise<TextResult> {
      // Blank prompt: never touch the network (deterministic, free).
      if (prompt.trim().length === 0) {
        return { text: "", model, inputTokens: 0, outputTokens: 0 };
      }

      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey });

      const res = await client.chat.completions.create(
        {
          model,
          max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(opts?.temperature != null ? { temperature: opts.temperature } : {}),
          messages: [
            ...(opts?.system ? [{ role: "system" as const, content: opts.system }] : []),
            { role: "user" as const, content: prompt },
          ],
        },
        { signal: opts?.signal ?? AbortSignal.timeout(TEXT_TIMEOUT_MS) },
      );

      const text = res.choices[0]?.message?.content?.trim() ?? "";
      return {
        text,
        model: res.model ?? model,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    },
  };
}
