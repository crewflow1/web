import "server-only";

/**
 * Shared vision door — the Anthropic implementation.
 *
 * ONE implementation of `VisionProvider`, not the door's dependency: callers ask
 * ./index for "a provider" and get whatever configuration selects, exactly as
 * ../text/anthropic.ts relates to ../text/index.ts. This file is the ONLY place
 * in the build that constructs a vendor SDK for document/image extraction — the
 * two OCR paths that used to each do it themselves (server/services/expense-drafts.ts
 * and lib/imports/ocr.ts, the latter importing `@anthropic-ai/sdk` at module
 * scope) now share this one seam, and the security ratchet pins that no third
 * construction appears.
 *
 * The SDK is DYNAMICALLY imported so it never enters a bundle that does not
 * extract documents — the idiom ../text/anthropic.ts already established, and
 * the reason the old module-scope import in lib/imports/ocr.ts was worth
 * removing on its own merits.
 *
 * `extract()` THROWS on failure. The worker/caller owns skip, retry and the
 * degraded path; a provider that swallowed its own errors would make the
 * governor unable to record a failure it never heard about.
 */

import type {
  VisionDocument,
  VisionExtractOptions,
  VisionModelInfo,
  VisionProvider,
  VisionResult,
} from "./types";

/**
 * The vision model. Haiku: the cheapest model that reads a UK invoice reliably,
 * and the same one both former OCR paths had hard-coded (one of them pinned to a
 * dated snapshot, one not — a drift this consolidation also removes).
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

/** Default output cap when a caller does not state one. Bounds cost. */
const DEFAULT_MAX_TOKENS = 1024;

/** 20s — a scanned multi-page PDF is slower than a chat completion. */
const VISION_TIMEOUT_MS = 20_000;

/**
 * Build the Anthropic vision provider for a key. Pure construction — no network
 * call and no SDK import until `extract` runs, so the factory can hand one out
 * cheaply and a caller that never extracts pays nothing.
 */
export function createAnthropicVisionProvider(
  apiKey: string,
  model: string = DEFAULT_MODEL,
): VisionProvider {
  const info: VisionModelInfo = { provider: "anthropic", model };

  return {
    info,
    async extract(doc: VisionDocument, opts: VisionExtractOptions): Promise<VisionResult> {
      // No bytes: never touch the network (deterministic, free) — the same
      // blank-input guard the text providers make.
      if (!doc.base64 || doc.base64.length === 0) {
        return { text: "", model, inputTokens: 0, outputTokens: 0 };
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      // PDF `document` blocks postdate the installed SDK's types (^0.32.0); the
      // API accepts them. Cast the block, not the whole request, so everything
      // the SDK does type stays typed. (Both former OCR paths carried this same
      // note; it now lives in one place.)
      const block: Record<string, unknown> =
        doc.kind === "pdf"
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: doc.base64 },
            }
          : {
              type: "image",
              source: { type: "base64", media_type: doc.mediaType, data: doc.base64 },
            };

      const msg = await client.messages.create(
        {
          model,
          max_tokens: opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS,
          system: opts.system,
          messages: [
            {
              role: "user",
              content: [block as never, { type: "text", text: opts.instruction }],
            },
          ],
        },
        { signal: opts.signal ?? AbortSignal.timeout(VISION_TIMEOUT_MS) },
      );

      // Concatenate every text block — defends against the model splitting its
      // JSON across blocks, which silently broke `content[0]`-only parsing.
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
