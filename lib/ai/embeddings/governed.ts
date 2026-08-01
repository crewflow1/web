import "server-only";

/**
 * THE GOVERNED EMBEDDING DOOR — the one call path a paid embedding may take.
 *
 * Embeddings were the last ungoverned AI modality in the build: the factory
 * (./index) used to hand back a live OpenAI provider on `OPENAI_API_KEY`
 * alone, and both call sites (the memory worker, HQ recall's query embed)
 * called `provider.embed()` directly — no ceiling, no ledger, no dedupe.
 *
 * This module closes that the same way text and vision were closed, with one
 * addition the other modalities did not need: a DETERMINISTIC EXEMPTION.
 *
 *   - PAID provider (openai, and any future vendor): every call runs inside
 *     `invokeWithGovernor` under the `embedding` task class — the identical
 *     atomic reserve→settle, per-org ceiling, SHA-256 dedupe and immutable
 *     ledger accounting as every generative call. The factory itself refuses
 *     to construct a paid provider unless the `embedding` tier is bound
 *     (see ./index), so this wrapper is the second lock on the same door.
 *
 *   - DETERMINISTIC provider (CI/dev, `MEMORY_EMBEDDING_PROVIDER=hash`): runs
 *     DIRECTLY, outside the governor, on purpose. It is pure local compute —
 *     zero egress, zero cost, no vendor. Reserving pence for it would be
 *     accounting fiction, and the ledger's task_class CHECK deliberately has
 *     no row cheap enough for "free". The exemption is pinned by the ratchet
 *     suite: it is the ONLY branch that may reach `provider.embed()` without
 *     the governor, and it is identified by the provider's own `info.provider`
 *     tag, not by anything a caller can pass in.
 *
 * CALLERS NEVER SEE THE GOVERNOR'S VOCABULARY. They get vectors, or one of
 * two degraded answers they already know how to handle:
 *   `{ unavailable }` — no provider (dark, unbound, or misconfigured);
 *   `{ refused }`     — the governor said no (ceiling, duplicate in flight).
 * Both mean "no vectors this time, and that is fine": recall serves
 * lexical/structural results, the worker leaves the batch queued.
 */

import {
  invokeWithGovernor,
  type AiFeature,
  type GovernorOutcome,
} from "@/lib/ai/governor";
import { resolveModel } from "@/lib/ai/governor/registry";
import { estimateTokens } from "./versioning";
import { getEmbeddingProvider } from "./index";
import type { EmbeddingModelInfo, EmbeddingResult } from "./types";

/** The registry keys allowed to embed. A closed set on purpose — a new
 * embedding surface must register a feature (a reviewed diff) to spend. */
export type EmbeddingFeature = "memory.embedding_write" | "memory.embedding_query";

export type GovernedEmbedOutcome =
  /** Vectors produced. `governed` is false only on the deterministic exemption. */
  | {
      status: "embedded";
      vectors: number[][];
      tokens: number;
      info: EmbeddingModelInfo;
      governed: boolean;
    }
  /** No provider is reachable — dark tier, no key, or unknown configuration —
   * or the provider call itself failed (reason carries the message so the
   * caller's own retry accounting stays as diagnostic as it was). */
  | { status: "unavailable"; reason?: string }
  /**
   * The governor refused: the org has no headroom this month, the reservation
   * store is unreachable (fails CLOSED), or an identical request is in
   * flight / recently succeeded. Nothing was charged.
   */
  | { status: "refused"; reason: string };

export async function governedEmbed(input: {
  texts: string[];
  feature: EmbeddingFeature;
  /** The org whose budget this spends (HQ memory bills hqBudgetOrgId()). */
  orgId: string;
  /** Null for system jobs — the cron worker has no human. */
  userId?: string | null;
  signal?: AbortSignal;
}): Promise<GovernedEmbedOutcome> {
  const provider = getEmbeddingProvider();
  if (!provider) return { status: "unavailable" };

  // Empty input never touches a network or a ledger, whoever the provider is.
  if (input.texts.length === 0) {
    return {
      status: "embedded",
      vectors: [],
      tokens: 0,
      info: provider.info,
      governed: false,
    };
  }

  // THE DETERMINISTIC EXEMPTION — see the module note. Identified by the
  // provider's own tag; a caller cannot opt into it. Same failure contract as
  // the paid branch: a throw becomes `unavailable` with the reason, so the
  // worker's per-row fail/retry accounting behaves identically whichever
  // provider is configured.
  if (provider.info.provider === "deterministic") {
    try {
      const res = await provider.embed(
        input.texts,
        input.signal ? { signal: input.signal } : undefined,
      );
      return {
        status: "embedded",
        vectors: res.vectors,
        tokens: res.tokens,
        info: provider.info,
        governed: false,
      };
    } catch (e) {
      return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // THE ENVELOPE BACKSTOP. The reservation claims the binding's worst-case
  // token envelope ONCE per call, whatever `texts.length` is — so a batch
  // whose estimated tokens exceed the envelope would be admitted on a claim
  // smaller than its own worst case, and committed spend could pass the
  // ceiling by the shortfall (the adversarial review's P1: the bench runs
  // batches of 256 against a worker-calibrated envelope). Refuse instead;
  // callers chunk to fit (the worker does) or shrink their batch.
  const bound = resolveModel("embedding");
  if (bound) {
    const estimated = input.texts.reduce((a, t) => a + estimateTokens(t), 0);
    if (estimated > bound.reserveInputTokens) {
      return { status: "refused", reason: "batch_exceeds_envelope" };
    }
  }

  // PAID: one governed call per embed request (the worker batches upstream,
  // so a batch is one reservation, one ledger row — matching how vendors
  // actually bill). Dedupe content is the batch itself: ten identical
  // double-submitted queries inside the window pay once.
  let outcome: GovernorOutcome<EmbeddingResult>;
  try {
    outcome = await invokeWithGovernor<EmbeddingResult>(
      input.feature as AiFeature,
      "embedding",
      async () => {
        const res = await provider.embed(
          input.texts,
          input.signal ? { signal: input.signal } : undefined,
        );
        return {
          value: res,
          usage: {
            provider: provider.info.provider,
            model: res.model,
            inputTokens: res.tokens,
            // Embeddings have no output tokens; the ledger records what the
            // vendor bills, which is input only.
            outputTokens: 0,
          },
        };
      },
      {
        orgId: input.orgId,
        userId: input.userId ?? null,
        // NUL-joined (written as an ESCAPE, per the repo's grep-visibility
        // house rule) so ["a b"] and ["a","b"] cannot collide into one
        // dedupe identity. Runtime bytes are identical to a raw NUL.
        dedupeContent: input.texts.join("\u0000"),
      },
    );
  } catch (e) {
    // The provider call itself failed. The governor has already settled the
    // claim as a failure and rethrown; the caller's contract here is the same
    // degraded answer as any other no-vectors case, with the reason preserved
    // for the caller's own failure accounting.
    return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }

  if (outcome.status === "blocked") {
    return { status: "refused", reason: outcome.reason };
  }
  if (outcome.status === "duplicate") {
    return { status: "refused", reason: `duplicate_${outcome.reason}` };
  }
  return {
    status: "embedded",
    vectors: outcome.value.vectors,
    tokens: outcome.value.tokens,
    info: provider.info,
    governed: !outcome.dark,
  };
}
