import "server-only";

/**
 * Shared vision door — the document/image extraction factory.
 *
 * WHY THIS EXISTS: there were TWO OCR paths
 * -----------------------------------------
 * `server/services/expense-drafts.ts` (receipt → expense draft) and
 * `lib/imports/ocr.ts` (PDF/photo → import sheet) each constructed
 * `@anthropic-ai/sdk` themselves, each hard-coded a model (`claude-haiku-4-5`
 * in one, the dated `claude-haiku-4-5-20251001` in the other — already drifted),
 * each read `ANTHROPIC_API_KEY` themselves, each carried its own copy of the
 * PDF-vs-image block shape and its own note about the SDK's missing types. One
 * of them passed through the AI Cost Governor and one did not, and nothing in
 * the code said which.
 *
 * They extract DIFFERENT documents into DIFFERENT schemas, so their prompts and
 * parsers rightly stay where they are. What they had no business duplicating is
 * the TRANSPORT: the SDK, the key, the model choice, the block shape, the token
 * accounting. That is what this door owns, and consolidating it is what lets the
 * security ratchet state a small, checkable truth — the only vendor-SDK
 * constructions in the build are inside lib/ai/text and lib/ai/vision.
 *
 * CONFIGURATION SELECTS THE VENDOR; THE GOVERNOR AUTHORISES THE CALL.
 * ------------------------------------------------------------------
 * Identical to lib/ai/text, and load-bearing for the same reason. Both former
 * paths gated on a bare `ANTHROPIC_API_KEY` presence check, so a key on a deploy
 * switched vision extraction on while every cost tier in
 * lib/ai/governor/registry.ts still mapped to NO model — real spend, outside the
 * £100/org/month ceiling, absent from the ledger. `isGovernorActivated()`
 * requires a MODEL BINDING in this build as well as the credential, so a key
 * alone yields `null` and every caller takes the degraded leg it already has (an
 * empty expense draft the operator types over; `OcrUnavailableError` and the
 * existing "upload CSV instead" message).
 *
 * `AI_VISION_PROVIDER` names the vendor, defaulting to "anthropic" — the only
 * vendor with a document-block implementation here today. It exists so adding a
 * second is a branch plus a sibling file, never a change to a caller. It
 * introduces NO new credential: the vendor's own key is the same
 * `ANTHROPIC_API_KEY` the build already knows.
 *
 * Never throws. An unknown vendor name degrades to `null` (extraction off)
 * rather than crashing an upload.
 */

import type { VisionProvider } from "./types";
import { isInferenceTierActivated } from "@/lib/ai/governor/readiness";
import { createAnthropicVisionProvider } from "./anthropic";

export type {
  VisionDocument,
  VisionExtractOptions,
  VisionModelInfo,
  VisionProvider,
  VisionResult,
} from "./types";

/**
 * Resolve the configured vision provider, or `null` when none is usable.
 *
 * The activation check is FIRST and unconditional: the cheapest question, the
 * one a stray credential cannot answer, and the one whose wrong answer costs
 * money. Construction below is network-free, so callers may ask per upload.
 */
export function getVisionProvider(): VisionProvider | null {
  // THE AUTHORISATION. A vendor key is not permission to spend.
  // PER-MODALITY: a generative (cheap/mid/high) tier must be bound — the
  // global any-tier answer would let an embedding-only activation open this
  // door on a bare key, recreating the exact defect the closure wave fixed.
  if (!isInferenceTierActivated()) return null;

  const name = (process.env.AI_VISION_PROVIDER ?? "anthropic").trim().toLowerCase();

  switch (name) {
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      return createAnthropicVisionProvider(key);
    }

    // Future vendors slot in here — configuration only:
    //   case "openai": ...   (gpt-4o vision)
    //   case "google": ...

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Degrade, don't crash: an upload must not 500 because a deploy variable
      // has a typo in it. Extraction stays off until it is corrected.
      console.warn(`[ai/vision] unknown AI_VISION_PROVIDER="${name}" — document extraction disabled`);
      return null;
  }
}

/** Cheap presence check, mirroring `isTextConfigured()`. */
export function isVisionConfigured(): boolean {
  return getVisionProvider() !== null;
}
