/**
 * FEATURE 2 — document-to-form autofill: shared vocabulary.
 *
 * Pure types + the closed form-type set. No `server-only`, no SDK, no I/O — safe
 * to import from the client review UI, the server extractor, and the tests.
 */

/**
 * The create forms autofill supports in Phase 1 — one representative per domain.
 * The DB CHECK on `form_import_drafts.form_type` (migration 20261265000000) and
 * this list are pinned against each other by the registry test, so neither can
 * drift from the other without failing CI.
 */
export const AUTOFILL_FORM_TYPES = [
  // Sales
  "customer",
  "lead",
  "customer_contact",
  // Money / procurement
  "supplier",
  // Projects / sites
  "job",
  "site",
  // Site & Safety
  "risk_assessment",
  "permit",
  "toolbox_talk",
  "snag",
  "diary",
  "compliance_document",
  "itp",
  "delay",
  "site_report",
  // People
  "staff_invite",
  "qualification",
  // Projects (contextual, job-nested)
  "warranty",
  "variation",
  // Materials / Stock / Fleet / Assets
  "stock_item",
  "vehicle",
  "asset",
  "material_request",
  "purchase_order",
] as const;
export type AutofillFormType = (typeof AUTOFILL_FORM_TYPES)[number];

/** A field in the review UI: its form `name` and a human label. */
export type AutofillField = {
  /** MUST equal the create form input's `name` — this is the prefill contract. */
  readonly key: string;
  /** Shown in the review list. */
  readonly label: string;
};

/**
 * One document's extraction, normalised for the review UI and for prefilling the
 * create form. Every value is a STRING (dates as YYYY-MM-DD, numbers as their
 * decimal text) so prefill drops straight onto the form inputs with no type
 * drift. A field the model did not find is simply absent from `fields` and named
 * in `missingFields`.
 */
export type AutofillExtraction = {
  /** Validated proposed values, keyed by the form's field names. */
  readonly fields: Readonly<Record<string, string>>;
  /** Model-reported confidence for the whole extraction, 0-100 (capped). */
  readonly overallConfidence: number;
  /** Field keys the model flagged as low-confidence — the review UI asks the
   *  operator to double-check these. Always a subset of the form's keys. */
  readonly uncertainFields: readonly string[];
  /** Expected field keys the model could not find. Subset of the form's keys. */
  readonly missingFields: readonly string[];
  /** 'vision' when a model actually read the document; 'none' when the governed
   *  path degraded (dark provider / over ceiling / duplicate / unsupported file)
   *  and nothing was extracted. The review UI states which. */
  readonly engine: "vision" | "none";
  /**
   * For a LINE-ITEM form (quote / purchase order / material request) the
   * extracted rows, each a string map keyed by the line-item field names. Absent
   * for a header-only form, and empty (never invented) when the document had no
   * readable lines or extraction was dark. The create form's own builder
   * re-validates every row on save — this is the first, conservative pass, the
   * array analogue of `fields`.
   */
  readonly lineItems?: ReadonlyArray<Readonly<Record<string, string>>>;
};

/** An empty extraction — the honest degraded result. `engine` records whether a
 *  model ran but yielded nothing ("vision") or never ran ("none"). */
export function emptyExtraction(engine: "none" | "vision" = "none"): AutofillExtraction {
  return {
    fields: {},
    overallConfidence: 0,
    uncertainFields: [],
    missingFields: [],
    engine,
  };
}
