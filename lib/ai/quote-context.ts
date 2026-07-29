/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — THE DISCLOSURE CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS FILE IS
 * -----------------
 * The CLOSED SET of facts that may leave CrewFlow when the quote writer is
 * activated. Not a convention, not a comment in the service — a data structure
 * the builder is validated against and the tests pin, so "what do you send to
 * the model?" has an answer that cannot drift from the code.
 *
 * A tenant's construction firm is trusting us with their customers' details.
 * The honest answer to "what leaves?" is only worth anything if it is
 * ENFORCED, and the only enforcement that survives a refactor is a machine-
 * checkable contract. `assertQuoteContextDisclosure` walks the object the
 * builder produced and throws on any key this file does not name.
 *
 * THE MINIMISATION RULE
 * ---------------------
 * A field earns its place by CHANGING THE DRAFT. "It might be useful" is not a
 * justification; "without it the model cannot scope or price the work" is. Each
 * entry below therefore carries its own `why`, and `docs/ai-quote-writer.md`
 * reproduces the same list for a reader who is not reading TypeScript.
 *
 * WHAT IS DELIBERATELY EXCLUDED — and these are the interesting ones:
 *
 *   - The CUSTOMER'S NAME. A scope of works is about the work. A name changes
 *     nothing about what materials are needed or how long the job takes, and
 *     it is the single most identifying field on the record. Excluded.
 *   - EMAIL, PHONE, and the FULL SITE ADDRESS. Same test, same answer. The
 *     outward postcode alone (`SW1A`, not `SW1A 1AA`) is kept because access
 *     and regional labour rates genuinely differ by area, and an outward code
 *     covers thousands of properties.
 *   - PRIOR QUOTES' CUSTOMERS, TOTALS AND MARGINS. Historic LINE DESCRIPTIONS
 *     and UNIT PRICES are included — they are the org's own price book and the
 *     only legitimate source of a price the model is allowed to state. Who
 *     that work was for, what it totalled, and what margin it carried are not
 *     needed to price a radiator, so they do not go.
 *   - ANY MONEY THE ORG HAS MADE, bank details, staff names, other customers.
 *
 * TRUSTED vs UNTRUSTED
 * --------------------
 * Every field is tagged. `untrusted: true` means the value is free text a
 * human (customer or operator) typed, or text extracted from a document — it
 * is DATA, and `lib/ai/quote-prompt.ts` fences it as such. `untrusted: false`
 * means CrewFlow itself computed the value from its own schema, so it cannot
 * carry an instruction.
 *
 * A HONEST LIMIT ON THE CONTRACT
 * ------------------------------
 * This contract governs what CREWFLOW ADDS. If a customer types their own name
 * into the notes, that name is in the notes, and the notes are the task. The
 * contract cannot redact free text without destroying the input; what it can
 * and does guarantee is that CrewFlow never JOINS a name, an address or a
 * contact detail onto the request from its own database.
 *
 * PURE. No `server-only`, no Supabase client, no SDK — the builder, the prompt
 * assembler and the tests share one vocabulary. Mirrors `lib/drafts/model.ts`.
 */

// ---------------------------------------------------------------------------
// 1. The field registry — the contract itself.
// ---------------------------------------------------------------------------

export type QuoteContextFieldDefinition = {
  /** The key as it appears on `QuoteContext`. Renaming is a contract change. */
  readonly key: string;
  /** Why this field earns its place. Prose, for reviewers and the doc. */
  readonly why: string;
  /**
   * True when the value is human free text or document-extracted text. Those
   * are fenced as DATA by the prompt assembler; trusted fields are not.
   */
  readonly untrusted: boolean;
};

/**
 * THE closed set. `buildQuoteContext` may populate these keys and no others.
 *
 * Adding a key here is the review point: it is the moment someone decides that
 * one more fact about a customer is worth sending to a third-party model.
 */
export const QUOTE_CONTEXT_FIELDS = [
  {
    key: "work_description",
    why: "The customer's own description of what they want done. This IS the task — without it there is nothing to draft.",
    untrusted: true,
  },
  {
    key: "site_notes",
    why: "Operator notes about access, constraints and site conditions. Changes the scope (scaffold, parking, out-of-hours) and therefore the price.",
    untrusted: true,
  },
  {
    key: "measurements",
    why: "Free-text dimensions the operator recorded on site. Drives quantities; without them every line item is flagged needs_pricing.",
    untrusted: true,
  },
  {
    key: "document_text",
    why: "Text extracted from an uploaded spec, drawing schedule or emailed enquiry. The richest scope source, and the least trustworthy — it is attacker-reachable via any document a customer sends.",
    untrusted: true,
  },
  {
    key: "property_kind",
    why: "A CATEGORY the operator picked (e.g. 'residential flat', 'commercial unit'). Changes VAT treatment, access assumptions and unit rates. A category, never an address.",
    untrusted: false,
  },
  {
    key: "postcode_outward",
    why: "The OUTWARD half of the postcode only ('SW1A'). Regional labour rates and travel differ materially; an outward code covers thousands of properties and identifies no household.",
    untrusted: false,
  },
  {
    key: "org_trade",
    why: "The contractor's own trade (e.g. 'electrical'). Makes the draft use the right vocabulary and the right standard exclusions. Org data, not customer data.",
    untrusted: false,
  },
  {
    key: "default_vat_rate",
    why: "The org's default VAT rate, one of 0/5/20. VAT is a legal determination, so the model is told the org's default rather than left to guess one.",
    untrusted: false,
  },
  {
    key: "currency",
    why: "Always 'GBP' today. Stated explicitly so a price can never be interpreted in another currency.",
    untrusted: false,
  },
  {
    key: "price_book",
    why: "The org's OWN historic line descriptions and unit prices. The one and only legitimate source of a price the model may state — every other price must come back null with needs_pricing set.",
    untrusted: false,
  },
] as const satisfies ReadonlyArray<QuoteContextFieldDefinition>;

export type QuoteContextFieldKey = (typeof QUOTE_CONTEXT_FIELDS)[number]["key"];

/** Every disclosable key, for iteration in the builder, the doc test and the UI. */
export const QUOTE_CONTEXT_FIELD_KEYS: ReadonlyArray<QuoteContextFieldKey> =
  QUOTE_CONTEXT_FIELDS.map((f) => f.key);

/** The subset that is human/document free text, and therefore fenced as data. */
export const QUOTE_CONTEXT_UNTRUSTED_KEYS: ReadonlyArray<QuoteContextFieldKey> =
  QUOTE_CONTEXT_FIELDS.filter((f) => f.untrusted).map((f) => f.key);

/** The definition for a key, or null when the key is outside the contract. */
export function quoteContextField(key: string): QuoteContextFieldDefinition | null {
  return QUOTE_CONTEXT_FIELDS.find((f) => f.key === key) ?? null;
}

/**
 * Fields CrewFlow holds and DELIBERATELY DOES NOT SEND, named so the exclusion
 * is a positive statement rather than an absence someone has to notice.
 *
 * The security suite asserts none of these strings appears as a key on a built
 * context, and the disclosure test proves the VALUES never reach the prompt.
 */
export const QUOTE_CONTEXT_EXCLUDED_FIELDS: ReadonlyArray<{ field: string; why: string }> = [
  { field: "customer_name", why: "Identifying, and changes nothing about the work." },
  { field: "customer_email", why: "Contact detail. A draft is never sent, so a recipient is never needed." },
  { field: "customer_phone", why: "Contact detail. Same reasoning." },
  { field: "site_address", why: "Identifies a household. The outward postcode carries the pricing signal without the identification." },
  { field: "prior_quote_totals", why: "Commercial history. Line-level unit prices price the work; totals reveal what the firm charges overall." },
  { field: "prior_quote_customers", why: "Another customer's identity has no bearing on this quote." },
  { field: "margins", why: "The firm's margin is its own business and is not an input to a scope of works." },
  { field: "staff_names", why: "Personal data of employees. Not an input." },
  { field: "bank_details", why: "Never leaves CrewFlow for any reason." },
];

// ---------------------------------------------------------------------------
// 2. The context shape.
// ---------------------------------------------------------------------------

/** One entry from the org's own price book — the only sanctioned price source. */
export type QuotePriceBookEntry = {
  /** The historic line description, verbatim from the org's own quote. */
  description: string;
  /** The unit it was priced in ("ea", "m2", "day"). */
  unit: string;
  /** Integer pence. Money crosses this boundary as integers, never floats. */
  unit_price_pence: number;
};

/**
 * Exactly what leaves CrewFlow. Every key here appears in QUOTE_CONTEXT_FIELDS
 * and vice versa — `assertQuoteContextDisclosure` proves the first direction at
 * runtime and a test proves the second.
 *
 * Every field is INDEPENDENTLY OPTIONAL. A missing source degrades the draft
 * (more `needs_pricing` flags, more warnings), never fails it.
 */
export type QuoteContext = {
  work_description: string | null;
  site_notes: string | null;
  measurements: string | null;
  document_text: string | null;
  property_kind: string | null;
  postcode_outward: string | null;
  org_trade: string | null;
  default_vat_rate: 0 | 5 | 20;
  currency: "GBP";
  price_book: ReadonlyArray<QuotePriceBookEntry>;
};

/** An empty, valid context. Every source absent; the draft will be all flags. */
export function emptyQuoteContext(): QuoteContext {
  return {
    work_description: null,
    site_notes: null,
    measurements: null,
    document_text: null,
    property_kind: null,
    postcode_outward: null,
    org_trade: null,
    default_vat_rate: 20,
    currency: "GBP",
    price_book: [],
  };
}

// ---------------------------------------------------------------------------
// 3. Enforcement.
// ---------------------------------------------------------------------------

/** Thrown when a context carries a field the disclosure contract does not name. */
export class QuoteDisclosureViolation extends Error {
  constructor(public readonly offendingKeys: ReadonlyArray<string>) {
    super(
      `[ai/quote-writer] DISCLOSURE VIOLATION: ${offendingKeys.join(", ")} ` +
        `is not in the disclosure contract (lib/ai/quote-context.ts). Data cannot ` +
        `leave CrewFlow until the field is added there, justified, and documented ` +
        `in docs/ai-quote-writer.md.`,
    );
    this.name = "QuoteDisclosureViolation";
  }
}

/**
 * Refuse a context carrying anything outside the contract.
 *
 * LOUD, not lenient. The tempting implementation is to strip the extra keys and
 * carry on — but silently dropping a field means the next author's new field
 * silently never reaches the model, and they debug a prompt for an hour. A
 * throw is a five-second fix and it happens in CI, before a byte has left.
 *
 * Only the TOP LEVEL is walked, and deliberately so: the nested shapes here are
 * `price_book` entries, whose own keys are pinned by
 * `assertPriceBookEntryShape` below. A generic deep walk would have to invent a
 * policy for arrays of primitives and would be harder to reason about than two
 * explicit checks.
 */
export function assertQuoteContextDisclosure(ctx: unknown): asserts ctx is QuoteContext {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
    throw new QuoteDisclosureViolation(["<not an object>"]);
  }
  const allowed = new Set<string>(QUOTE_CONTEXT_FIELD_KEYS);
  const offending = Object.keys(ctx as Record<string, unknown>).filter((k) => !allowed.has(k));
  if (offending.length > 0) throw new QuoteDisclosureViolation(offending);

  const priceBook = (ctx as { price_book?: unknown }).price_book;
  if (priceBook !== undefined) {
    if (!Array.isArray(priceBook)) throw new QuoteDisclosureViolation(["price_book<not an array>"]);
    for (const entry of priceBook) assertPriceBookEntryShape(entry);
  }
}

const PRICE_BOOK_KEYS = new Set(["description", "unit", "unit_price_pence"]);

/**
 * A price-book entry carries three fields and no more.
 *
 * This is where a leak would realistically happen: the natural way to build a
 * price book is `select("description, unit, unit_price, quotes(customer_id)")`
 * and pass the rows straight through, which would ship a customer id per line.
 * The check makes that a failed test rather than a quiet disclosure.
 */
export function assertPriceBookEntryShape(entry: unknown): asserts entry is QuotePriceBookEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new QuoteDisclosureViolation(["price_book[]<not an object>"]);
  }
  const offending = Object.keys(entry as Record<string, unknown>).filter(
    (k) => !PRICE_BOOK_KEYS.has(k),
  );
  if (offending.length > 0) {
    throw new QuoteDisclosureViolation(offending.map((k) => `price_book[].${k}`));
  }
}

/**
 * Which contract fields this context actually populated.
 *
 * Stored on the draft row as its provenance: "this draft was built from the
 * work description and the price book, and nothing else". Null/empty fields are
 * omitted, because a field that was absent did not inform anything.
 */
export function populatedQuoteContextFields(
  ctx: QuoteContext,
): ReadonlyArray<QuoteContextFieldKey> {
  const out: QuoteContextFieldKey[] = [];
  for (const key of QUOTE_CONTEXT_FIELD_KEYS) {
    const value = (ctx as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out.push(key);
  }
  return out;
}

/**
 * Reduce a UK postcode to its OUTWARD code, or null when it is not one.
 *
 * The minimisation step itself, kept here rather than in the builder so the
 * rule is beside the justification that motivates it. `SW1A 1AA` → `SW1A`. A
 * value that does not look like a postcode returns null rather than being
 * passed through — a "postcode" field containing a house name must not become
 * a way to smuggle an address past the contract.
 */
export function outwardPostcode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.toUpperCase().replace(/\s+/g, "");
  // UK outward: 1-2 letters, 1-2 digits, optional trailing letter. Inward is
  // always digit + 2 letters, and is discarded whether present or not.
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})?$/.exec(cleaned);
  return m ? m[1]! : null;
}
