import "server-only";

/**
 * FEATURE 2 — the governed document extractor.
 *
 * Takes an uploaded document's bytes and a form type, and returns proposed form
 * values. It is the autofill sibling of server/services/expense-drafts.ts's
 * `maybeExtractReceipt`, and it follows that module's contract exactly, for the
 * same reasons:
 *
 *   ONE VISION DOOR. The provider comes from lib/ai/vision (getVisionProvider),
 *   the only place in the build that constructs the vendor SDK for document
 *   extraction. This module never touches an SDK or an API key.
 *
 *   GOVERNED. The provider call is wrapped in invokeWithGovernor with the
 *   registered feature `document.form_autofill` (classification → cheap tier),
 *   so it refuses when the org is at its £100/month ceiling, refuses a re-upload
 *   of a document it just read, and records tokens / latency / cost.
 *
 *   OWN-TIER GATE FIRST. `getVisionProvider()` opens on any generative tier, so
 *   this `classification`/`cheap` path gates on `isTierActivated("cheap")`
 *   BEFORE it opens the door — the per-tier backstop the governance ratchet
 *   requires of every door caller.
 *
 *   DARK = EMPTY, NEVER INVENTED. With no bound cheap tier (today's production
 *   state) `getVisionProvider()` is null and this returns an empty extraction:
 *   the review step shows no suggestions and the operator fills the form by
 *   hand. A blocked/duplicate/failed call degrades to the same empty result.
 *   Extraction NEVER blocks manual entry.
 *
 *   INJECTION-SAFE BY CONSTRUCTION. The document reaches the model only as a
 *   vision document/image BLOCK (data), never concatenated into the system or
 *   instruction channel; the instruction is a fixed string. The output schema
 *   (lib/imports/autofill/schemas.ts) strips unknown keys and nulls malformed
 *   values, so the worst case of a document that tries to steer the model is a
 *   bad suggestion the operator reviews — the same guarantee lib/ai/quote-prompt
 *   and expense-drafts rely on.
 */

import { getVisionProvider } from "@/lib/ai/vision";
import { invokeWithGovernor, isTierActivated, type GovernedCall } from "@/lib/ai/governor";
import type { AutofillExtraction, AutofillFormType } from "./types";
import { emptyExtraction } from "./types";
import { AUTOFILL_FORMS } from "./registry";

/** PDF + the raster image formats the vision door can read as a document. */
const SUPPORTED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function isSupportedExtractionMime(mime: string): boolean {
  return SUPPORTED_MIME.has(mime);
}

/** Output cap — bounds cost. Ample for the identity/address fields; a very long
 *  method statement may be summarised, which the operator then edits. */
const MAX_OUTPUT_TOKENS = 2000;
/** OCR always needs a human eye — cap reported confidence like imports/ocr.ts. */
const CONFIDENCE_CAP = 85;

/**
 * Extract proposed values for one form from one document. Never throws; always
 * returns an `AutofillExtraction`, empty on any degraded path.
 */
export async function extractForForm(input: {
  formType: AutofillFormType;
  bytes: Uint8Array | null;
  mimeType: string;
  actor: { orgId: string; userId: string | null };
}): Promise<AutofillExtraction> {
  const config = AUTOFILL_FORMS[input.formType];

  // OWN-TIER GATE, before the door. The degraded value (an empty proposal the
  // operator types over) is identical whether we short-circuit here or below.
  if (!isTierActivated("cheap")) return emptyExtraction("none");

  const vision = getVisionProvider();
  if (!vision || !input.bytes || input.bytes.length === 0) return emptyExtraction("none");
  if (!isSupportedExtractionMime(input.mimeType)) return emptyExtraction("none");

  const isPdf = input.mimeType === "application/pdf";
  const base64 = Buffer.from(input.bytes).toString("base64");

  try {
    const outcome = await invokeWithGovernor(
      "document.form_autofill",
      "classification",
      () =>
        runExtraction(
          vision,
          config.systemPrompt,
          config.fields.map((f) => f.key),
          config.schema,
          config.lineItem?.schema,
          base64,
          input.mimeType,
          isPdf,
        ),
      {
        orgId: input.actor.orgId,
        userId: input.actor.userId,
        // The document's own bytes are the dedupe identity: a double-submit must
        // not be read (and billed) twice. Only its SHA-256 reaches the ledger.
        dedupeContent: base64,
      },
    );
    if (outcome.status === "ran") return outcome.value;
  } catch (e) {
    // The governor records the failure and rethrows; this catch owns the
    // degraded path, exactly as every other governed extractor does.
    console.error("[autofill] extraction failed", e);
  }
  return emptyExtraction("none");
}

/**
 * The provider leg, isolated so the governor times and accounts for it. Returns
 * the vendor's own billed token counts as `usage`. Throws on provider failure —
 * the caller owns the degraded path.
 */
async function runExtraction(
  vision: NonNullable<ReturnType<typeof getVisionProvider>>,
  systemPrompt: string,
  knownKeys: readonly string[],
  schema: import("zod").ZodTypeAny,
  lineItemSchema: import("zod").ZodTypeAny | undefined,
  base64: string,
  mimeType: string,
  isPdf: boolean,
): Promise<GovernedCall<AutofillExtraction>> {
  const result = await vision.extract(
    {
      kind: isPdf ? "pdf" : "image",
      mediaType: isPdf ? "application/pdf" : mimeType,
      base64,
    },
    {
      system: systemPrompt,
      // FIXED instruction — the document never supplies it.
      instruction: "Extract the fields as instructed and return the JSON object only.",
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(20_000),
    },
  );
  const usage = {
    provider: vision.info.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
  const value = parseExtraction(result.text, knownKeys, schema, lineItemSchema);
  // Whether or not we could parse it, the call COST what it cost — report usage
  // so the ledger reflects the spend. An unparseable response yields empty.
  return { value, usage };
}

/**
 * Turn the model's raw text into the schema's validated field map. Pure and
 * exported so the unit tests exercise it directly (no network, no governor).
 *
 * `knownKeys` is the form's field list; `missingFields` is every known key the
 * validated output did not fill, and `uncertainFields` is the model's own
 * "uncertain" list intersected with the known keys (a key the model invented
 * cannot be uncertain about — it is dropped).
 */
export function parseExtractionForForm(
  formType: AutofillFormType,
  rawText: string,
): AutofillExtraction {
  const config = AUTOFILL_FORMS[formType];
  return parseExtraction(
    rawText,
    config.fields.map((f) => f.key),
    config.schema,
    config.lineItem?.schema,
  );
}

function parseExtraction(
  rawText: string,
  knownKeys: readonly string[],
  schema: import("zod").ZodTypeAny,
  lineItemSchema?: import("zod").ZodTypeAny,
): AutofillExtraction {
  const parsed = extractJson(rawText);
  if (!parsed || typeof parsed !== "object") return emptyExtraction("vision");

  const obj = parsed as Record<string, unknown>;
  const rawFields = obj.fields && typeof obj.fields === "object" ? (obj.fields as Record<string, unknown>) : {};
  const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  const rawUncertain = Array.isArray(obj.uncertain) ? obj.uncertain : [];

  // The schema strips unknown keys and nulls malformed values. `.safeParse`
  // never throws; a total failure yields an empty, honest result.
  const safe = schema.safeParse(rawFields);
  const validated: Record<string, string | null> = safe.success
    ? (safe.data as Record<string, string | null>)
    : {};

  const fields: Record<string, string> = {};
  const missingFields: string[] = [];
  for (const key of knownKeys) {
    const v = validated[key];
    if (typeof v === "string" && v.length > 0) fields[key] = v;
    else missingFields.push(key);
  }

  const knownSet = new Set(knownKeys);
  const uncertainFields = Array.from(
    new Set(
      rawUncertain
        .filter((k): k is string => typeof k === "string")
        .filter((k) => knownSet.has(k) && k in fields),
    ),
  );

  const overallConfidence = Math.min(
    CONFIDENCE_CAP,
    Math.max(0, Math.round(Number.isFinite(rawConfidence) ? rawConfidence : 0)),
  );

  // LINE-ITEM forms: validate the model's rows through the array schema (which
  // drops invented/empty rows and nulls malformed cells). Absent for header-only
  // forms; `[]` when the document had no readable lines — never invented.
  let lineItems: ReadonlyArray<Record<string, string>> | undefined;
  if (lineItemSchema) {
    const rawItems = obj.lineItems ?? obj.items ?? obj.lines;
    const safeItems = lineItemSchema.safeParse(rawItems);
    lineItems = safeItems.success ? (safeItems.data as Record<string, string>[]) : [];
  }

  return { fields, overallConfidence, uncertainFields, missingFields, engine: "vision", lineItems };
}

/** Tolerant JSON extraction — handles ```json fences and surrounding prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
