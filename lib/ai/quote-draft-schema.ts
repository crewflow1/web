/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — THE TYPED OUTPUT SCHEMA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The boundary between a language model's output and CrewFlow's money.
 *
 * A quote is a PRICED COMMERCIAL OFFER. When a customer accepts one, CrewFlow
 * creates a job, allocates an invoice number, posts a draft invoice and emails
 * it (see `acceptQuoteByToken`). So a number that a model invented does not
 * stay a suggestion for long — it becomes an invoice. Everything in this file
 * follows from that single fact.
 *
 * THE FOUR RULES THIS SCHEMA ENFORCES STRUCTURALLY
 * ------------------------------------------------
 *  1. A PRICE REQUIRES A SOURCE. `unit_price_pence` is NULL unless
 *     `price_source` names where the number came from, and the only non-null
 *     source is the org's OWN price book. A model that "knows" a radiator costs
 *     £180 is guessing at a UK contractor's cost base it has never seen, and a
 *     confident guess is worse than a blank: a blank gets typed in, a guess
 *     gets sent. Null + `needs_pricing` is the honest output.
 *  2. THE MODEL CANNOT STATE A TOTAL. There is no `subtotal`, `vat_total` or
 *     `total` field, and the object is STRICT — a smuggled total is a REJECTED
 *     draft, not a stripped key. Totals come from `computeTotals`
 *     (lib/quotes/totals.ts), the one money authority, every time.
 *  3. MONEY IS INTEGER PENCE across this boundary. JSON has one number type and
 *     it is a float; `19.99` does not survive a round trip through arbitrary
 *     arithmetic intact. Pence are exact, and the conversion to the major units
 *     the quotes domain stores happens in exactly one function below.
 *  4. MALFORMED IS REJECTED, LOUDLY. `parseQuoteDraft` has no partial-salvage
 *     path. Salvage exists, but only behind a differently-named function whose
 *     result is permanently stamped `degraded` — so nothing can accidentally
 *     treat a repaired draft as a clean one.
 *
 * PURE. No `server-only`, no SDK, no I/O.
 */

import { z } from "zod";
import { computeTotals, type QuoteTotals } from "@/lib/quotes/totals";
import { QUOTE_VAT_RATES, type LineItem } from "@/lib/quotes/schema";
import { QUOTE_CONTEXT_FIELD_KEYS } from "./quote-context";

/**
 * Bumped when the shape changes in a way a stored draft would not survive.
 * Recorded on every persisted draft so an old row is never re-read as a new one.
 */
export const QUOTE_DRAFT_SCHEMA_VERSION = 1;

/**
 * Where a price came from. The closed set, and note how short it is.
 *
 * `price_book` is the ONLY value that permits a number. It means "this unit
 * price was copied from a line the org itself priced on a previous quote" —
 * the org's own commercial judgement, echoed back. There is deliberately no
 * `estimate`, no `market_rate` and no `model_knowledge`: each of those would be
 * a licence to invent, and the whole point is that inventing is not available.
 */
export const QUOTE_PRICE_SOURCES = ["none", "price_book"] as const;
export type QuotePriceSource = (typeof QUOTE_PRICE_SOURCES)[number];

/** Confidence banding. Mirrors `AiConfidence` in lib/ai/safety.ts. */
export const QUOTE_DRAFT_CONFIDENCE = ["high", "medium", "low"] as const;
export type QuoteDraftConfidence = (typeof QUOTE_DRAFT_CONFIDENCE)[number];

/** £99,999.00 per unit, in pence. Above this, something has gone wrong. */
const MAX_UNIT_PRICE_PENCE = 9_999_900;
/** A quote with more lines than this is not a draft, it is a runaway. */
const MAX_LINE_ITEMS = 40;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/**
 * One line of the draft.
 *
 * `.strict()` at every level: an unrecognised key means the model is answering
 * a schema we did not ask for, and the safe reading of that is "reject", not
 * "ignore the bits I don't know".
 */
export const quoteDraftLineItemSchema = z
  .object({
    description: trimmed(500),
    qty: z.number().finite().positive().max(999_999),
    unit: trimmed(20),
    /**
     * NULL whenever the price book did not answer. Integer pence — a float here
     * is a rejection, not a rounding opportunity.
     */
    unit_price_pence: z.number().int().nonnegative().max(MAX_UNIT_PRICE_PENCE).nullable(),
    price_source: z.enum(QUOTE_PRICE_SOURCES),
    /** True exactly when a human must supply the price before this line is real. */
    needs_pricing: z.boolean(),
    vat_rate: z
      .number()
      .refine(
        (v) => (QUOTE_VAT_RATES as readonly number[]).includes(v),
        "VAT rate must be 0, 5, or 20",
      ),
  })
  .strict()
  .superRefine((line, ctx) => {
    // THE PRICE-PROVENANCE INVARIANT, stated three ways so no two of the three
    // fields can drift apart and leave a priced line looking unpriced (or, far
    // worse, an invented price looking sourced).
    const priced = line.unit_price_pence !== null;
    if (priced && line.price_source === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price_source"],
        message:
          "a price with no source is an invented price — unit_price_pence must be null unless price_source names where the number came from",
      });
    }
    if (!priced && line.price_source !== "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price_source"],
        message: "price_source claims a source but no price was given",
      });
    }
    if (priced === line.needs_pricing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needs_pricing"],
        message: priced
          ? "a priced line must not be flagged needs_pricing"
          : "an unpriced line MUST be flagged needs_pricing so the operator sees the gap",
      });
    }
  });

export type QuoteDraftLineItem = z.infer<typeof quoteDraftLineItemSchema>;

/**
 * The whole draft.
 *
 * Note what is NOT here: any total, any customer identity, any recipient, any
 * send instruction, any status. A draft is a proposal about WORK. Everything
 * commercial and everything transmissive is the existing quote flow's job, and
 * a field the model cannot fill is a field the model cannot influence.
 */
export const quoteDraftSchema = z
  .object({
    title: trimmed(200),
    scope_summary: z.string().trim().min(1).max(4_000),
    line_items: z.array(quoteDraftLineItemSchema).min(1).max(MAX_LINE_ITEMS),
    /** What the draft assumes to be true. Each one is a question for the operator. */
    assumptions: z.array(trimmed(500)).max(30),
    /** What the price explicitly does NOT cover. The other half of a defensible quote. */
    exclusions: z.array(trimmed(500)).max(30),
    notes: z.string().trim().max(4_000).nullable(),
    /**
     * Machine-actionable problems the draft found: contradictory scope, missing
     * dimensions, a request it refused. The UI surfaces these ABOVE the lines,
     * because a warning under a plausible-looking quote is a warning nobody reads.
     */
    warnings: z.array(trimmed(500)).max(30),
    confidence: z.enum(QUOTE_DRAFT_CONFIDENCE),
    /**
     * Which disclosure-contract fields the draft actually used. Validated
     * against `QUOTE_CONTEXT_FIELD_KEYS`, so a model cannot claim to have read
     * an input that does not exist — a claim that would otherwise make a draft
     * look better sourced than it is.
     */
    provenance: z
      .array(z.enum(QUOTE_CONTEXT_FIELD_KEYS as unknown as [string, ...string[]]))
      .max(QUOTE_CONTEXT_FIELD_KEYS.length),
  })
  .strict();

export type QuoteDraft = z.infer<typeof quoteDraftSchema>;

// ---------------------------------------------------------------------------
// Validation — the loud gate.
// ---------------------------------------------------------------------------

export type QuoteDraftRejectionCode =
  /** Not an object at all, or unparseable text where JSON was required. */
  | "not_an_object"
  /** Schema violation — the issues list says which. */
  | "schema_invalid";

export type QuoteDraftParse =
  | { ok: true; draft: QuoteDraft; degraded: false }
  | { ok: false; code: QuoteDraftRejectionCode; issues: string[] };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

/**
 * THE gate. Validate a model's output, or refuse it.
 *
 * There is no third outcome. A draft that half-parsed is a draft whose author
 * did not follow the schema, and the useful question is not "which lines can I
 * keep" but "why did the model answer a different shape". Keeping the good half
 * hides that question behind a quote that looks fine and is missing two rooms.
 */
export function parseQuoteDraft(raw: unknown): QuoteDraftParse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "not_an_object", issues: [`expected an object, got ${typeOf(raw)}`] };
  }
  const parsed = quoteDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "schema_invalid", issues: issuesOf(parsed.error) };
  }
  return { ok: true, draft: parsed.data, degraded: false };
}

export type SalvagedQuoteDraft =
  | {
      ok: true;
      draft: QuoteDraft;
      /** Permanently true. A salvaged draft can never be mistaken for a clean one. */
      degraded: true;
      /** Every line that was thrown away, and why. Shown to the operator verbatim. */
      dropped: string[];
    }
  | { ok: false; code: QuoteDraftRejectionCode; issues: string[] };

/**
 * The EXPLICIT degraded path — a different function, not a boolean option.
 *
 * A `parseQuoteDraft(raw, { lenient: true })` would sit one keystroke away from
 * the strict call and would eventually be typed by someone chasing a flaky
 * provider. A separate name has to be reached for deliberately, appears in the
 * diff, and its result carries `degraded: true` into the database.
 *
 * It salvages exactly ONE thing: individual line items that failed while the
 * envelope was valid. It never repairs a line, never invents a price, and never
 * rescues a draft whose top-level shape was wrong — those are still refusals.
 */
export function salvageQuoteDraft(raw: unknown): SalvagedQuoteDraft {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "not_an_object", issues: [`expected an object, got ${typeOf(raw)}`] };
  }
  const source = raw as Record<string, unknown>;
  const lines = Array.isArray(source.line_items) ? source.line_items : [];

  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (const [idx, line] of lines.entries()) {
    const one = quoteDraftLineItemSchema.safeParse(line);
    if (one.success) kept.push(line);
    else dropped.push(`line ${idx}: ${issuesOf(one.error).join("; ")}`);
  }

  const parsed = quoteDraftSchema.safeParse({ ...source, line_items: kept });
  if (!parsed.success) {
    return { ok: false, code: "schema_invalid", issues: issuesOf(parsed.error) };
  }
  return { ok: true, draft: parsed.data, degraded: true, dropped };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// Money — the one conversion, and the one authority.
// ---------------------------------------------------------------------------

/**
 * Integer pence → the major-unit number the quotes domain stores.
 *
 * `lib/quotes/schema.ts` types `unit_price` as a plain number in GBP and
 * `computeTotals` rounds to 2dp per line, so this is the exact seam where the
 * pence discipline hands over. Division by 100 of an integer is exact for every
 * value this schema admits (well inside 2^53), so nothing is lost here — the
 * rounding decisions all belong to `computeTotals`, which already documents why
 * it rounds per line rather than at the end.
 */
export function penceToMajor(pence: number): number {
  return Math.round(pence) / 100;
}

/**
 * The draft's lines as quote-form line items.
 *
 * An UNPRICED line becomes `unit_price: 0`. That is deliberate and it is the
 * conservative direction: zero cannot be mistaken for a real price, it makes
 * the quote total visibly too low rather than invisibly too high, and the line
 * still carries its description so the operator knows exactly what to price.
 * The alternative — dropping unpriced lines — would silently narrow the scope,
 * which is how a contractor ends up doing work they never quoted for.
 */
export function toQuoteLineItems(draft: QuoteDraft): LineItem[] {
  return draft.line_items.map((line) => ({
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    unit_price: line.unit_price_pence === null ? 0 : penceToMajor(line.unit_price_pence),
    vat_rate: line.vat_rate,
  }));
}

/**
 * The draft's totals — computed by `computeTotals`, never by the model.
 *
 * This function exists so there is no other way to obtain a number for a draft.
 * `computeTotals` is the money authority for the whole quotes domain; routing
 * the AI path through the identical function means an AI-originated quote and a
 * hand-typed one cannot disagree by a penny.
 */
export function quoteDraftTotals(draft: QuoteDraft): QuoteTotals {
  return computeTotals(toQuoteLineItems(draft));
}

/** Lines the operator must price before the quote means anything. */
export function unpricedLines(draft: QuoteDraft): QuoteDraftLineItem[] {
  return draft.line_items.filter((l) => l.needs_pricing);
}

/**
 * Is this draft ready to become a quote without further human pricing?
 *
 * Never used to gate anything automatically — a human always presses the
 * button. It drives the review UI's summary line so the operator sees "4 of 11
 * lines still need a price" before they read a single description.
 */
export function draftIsFullyPriced(draft: QuoteDraft): boolean {
  return unpricedLines(draft).length === 0;
}
