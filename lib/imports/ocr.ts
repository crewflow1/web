import "server-only";
import { getVisionProvider } from "@/lib/ai/vision";
import { invokeWithGovernor, isTierActivated, type GovernedCall } from "@/lib/ai/governor";
import type { ParsedSheet, Cell } from "./parsers";

/**
 * Migration OS v2 — OCR import for PDFs and photos/screenshots.
 *
 * Takes a PDF or image file (JPEG/PNG/HEIC/WEBP) and asks a vision model to
 * extract its structured contents: customer, invoice/quote number, date,
 * line items, VAT, total. Returns the same `ParsedSheet[]` shape that
 * CSV/Excel produce so the rest of the import pipeline (detect → map →
 * preview → review → commit) is unchanged.
 *
 * Design choices:
 *
 *   1. Confidence is bounded — even a perfectly-extracted PDF caps at
 *      0.85 because OCR text always needs a human eyeball on totals.
 *      The pipeline's existing "review before commit" gate means the
 *      operator sees every row before it lands.
 *
 *   2. We ask for a strict JSON shape and parse it ourselves — no
 *      tool-use round-trips. If the model breaks the schema, we treat
 *      the file as unparseable and let the operator know.
 *
 *   3. If no vision provider is available (preview / dev / a hosted
 *      tier that doesn't pay for OCR), we throw a tagged error so the
 *      upload action can surface a friendly message instead of 500ing.
 *
 * TWO THINGS CHANGED HERE, AND BOTH WERE THE SAME DEFECT
 * -----------------------------------------------------
 * This module used to import `@anthropic-ai/sdk` AT MODULE SCOPE, construct the
 * client itself from `env.ANTHROPIC_API_KEY`, and hard-code a dated model — the
 * only vision path in the build that did not pass through the AI Cost Governor.
 * The practical consequence: setting `ANTHROPIC_API_KEY` on a deploy switched
 * paid OCR on for every operator upload with NO £100/org/month ceiling and NO
 * ledger row. Meanwhile server/services/expense-drafts.ts did receipt OCR
 * through the governor, with its own copy of the SDK construction and the
 * PDF-vs-image block shape.
 *
 * So the transport is now SHARED (lib/ai/vision — one factory, one SDK
 * construction, one model choice, activation-gated) and the call is GOVERNED.
 * The prompts and parsers stay here, because an import document and a receipt
 * are different documents extracted into different schemas — sharing those would
 * be a coincidence of shape, not a shared concern.
 */

export const OCR_SUPPORTED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

export function isOcrFile(file: { type?: string; name?: string }): boolean {
  if (file.type && OCR_SUPPORTED_MIME.has(file.type)) return true;
  const lower = (file.name ?? "").toLowerCase();
  return (
    lower.endsWith(".pdf") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".heic") ||
    lower.endsWith(".heif")
  );
}

export class OcrUnavailableError extends Error {
  constructor() {
    // The wording no longer names an environment variable. It used to say "ask
    // CrewFlow to enable ANTHROPIC_API_KEY", which stopped being true when the
    // vision door started requiring a BOUND cost tier as well as a credential —
    // and telling an operator that a key is all it takes is how a credential
    // ends up on a deploy without the model binding that governs it.
    super(
      "PDF / photo import isn't switched on for this server yet. Ask CrewFlow to enable AI document reading, or upload the same data as CSV / Excel.",
    );
    this.name = "OcrUnavailableError";
  }
}

type OcrExtraction = {
  kind: "invoice" | "quote" | "receipt" | "delivery_note" | "unknown";
  customer_name: string | null;
  // A delivery/goods-received note is issued BY a supplier, so the party is the
  // SUPPLIER, not a customer. Optional on the shared shape (null for invoices /
  // quotes / receipts, which carry customer_name instead).
  supplier_name: string | null;
  document_number: string | null;
  document_date: string | null;
  vat_number: string | null;
  subtotal: number | null;
  vat_total: number | null;
  total: number | null;
  status: string | null;
  notes: string | null;
  line_items: Array<{
    description: string;
    qty: number | null;
    unit_price: number | null;
    vat_rate: number | null;
    line_total: number | null;
  }>;
};

/**
 * The DELIVERY-NOTE (goods-received) extraction — the structured subset a
 * delivery note carries, feeding the RECEIVED leg of three-way matching
 * (lib/purchase-orders/matching.ts reads goods_received_notes + lines). A
 * delivery note has NO money on it — it evidences that goods ARRIVED, not what
 * they cost — so the schema is deliberately supplier + note number + date +
 * quantities/descriptions, with no VAT or price fields. Distilled from the
 * shared `OcrExtraction` so the ONE governed vision call classifies the document
 * and this shape is derived from it — no second model round-trip.
 */
export type DeliveryNoteExtraction = {
  supplier_name: string | null;
  delivery_note_number: string | null;
  delivery_date: string | null;
  line_items: Array<{ description: string; qty: number | null }>;
};

/** Project the shared extraction onto the delivery-note shape (pure). */
export function toDeliveryNoteExtraction(e: OcrExtraction): DeliveryNoteExtraction {
  return {
    supplier_name: e.supplier_name,
    delivery_note_number: e.document_number,
    delivery_date: e.document_date,
    line_items: (e.line_items ?? []).map((li) => ({
      description: li.description ?? "",
      qty: li.qty,
    })),
  };
}

const SYSTEM_PROMPT = `You extract invoice, quote, receipt, and delivery-note
data from PDFs and photos for CrewFlow — UK construction-company software. Output
strict JSON only, no commentary. If a field isn't legible, set it to
null. Never invent values. Normalise amounts to GBP numerics (no
currency symbols). Dates as YYYY-MM-DD when possible. A DELIVERY NOTE (or
goods-received note) evidences goods that ARRIVED: it names the SUPPLIER, a
delivery-note number, a date and line items with quantities — usually NO prices
or VAT; set kind to "delivery_note" and fill supplier_name (not customer_name).
Confidence is deliberately moderate because OCR mistakes happen — the operator
reviews everything before commit.`;

const RESPONSE_INSTRUCTION = `Return JSON of this exact shape and
nothing else:

{
  "kind": "invoice" | "quote" | "receipt" | "delivery_note" | "unknown",
  "customer_name": string | null,
  "supplier_name": string | null,
  "document_number": string | null,
  "document_date": string | null,
  "vat_number": string | null,
  "subtotal": number | null,
  "vat_total": number | null,
  "total": number | null,
  "status": string | null,
  "notes": string | null,
  "line_items": [
    {
      "description": string,
      "qty": number | null,
      "unit_price": number | null,
      "vat_rate": number | null,
      "line_total": number | null
    }
  ]
}`;

/** Output cap. An invoice with many line items needs room; this bounds cost. */
const OCR_MAX_TOKENS = 2048;

/**
 * Run a single PDF/image through a vision model and return ParsedSheet
 * rows ready for the existing detect/map/commit pipeline.
 *
 * One ParsedSheet per document — header columns are the canonical
 * field names so the existing entity detector recognises them.
 *
 * `actor` is REQUIRED: a governed call must name the organisation whose ceiling
 * it spends from. The upload action already has it (`ctx.org.id`), and an
 * optional org id would be a way to spend money nobody is accountable for.
 *
 * THROWS `OcrUnavailableError` when no vision provider is available — byte-identical
 * to the previous no-key behaviour, including the message and the
 * `error=ocr_unavailable` redirect the upload action performs on it.
 *
 * EVENT-DRIVEN: this runs when a FILE ARRIVES, once per file. Never on a render.
 */
export async function ocrFileToSheet(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  actor: { orgId: string; userId?: string | null };
}): Promise<ParsedSheet> {
  // PER-TIER OWN-CLASS GATE. `getVisionProvider()` opens on ANY generative tier
  // (isInferenceTierActivated), so with only `mid`/`high` bound + a vendor key it
  // would hand this `classification`/`cheap` path a LIVE provider that the
  // governor's per-tier dark short-circuit then runs ungoverned. Gate on this
  // call's own tier first — same thrown error as the no-provider leg, so the
  // action's friendly message is unchanged.
  if (!isTierActivated("cheap")) {
    throw new OcrUnavailableError();
  }

  // The ONE vision door. It yields null unless a cost tier is BOUND as well as
  // the vendor credential being set, so a stray key can no longer switch paid
  // OCR on for every upload. Same thrown error as before, so the action's
  // friendly message is unchanged.
  const vision = getVisionProvider();
  if (!vision) {
    throw new OcrUnavailableError();
  }

  const base64 = Buffer.from(input.bytes).toString("base64");
  const isPdf = input.mimeType === "application/pdf";

  // NOT WRAPPED IN A try/catch, on purpose. A provider failure was always thrown
  // to the upload action, which redirects with `error=parse_failed`. The governor
  // RECORDS the failure and RETHROWS, so letting it propagate preserves that
  // behaviour exactly; catching and rethrowing would only look like handling.
  const outcome = await invokeWithGovernor(
    "imports.ocr",
    "classification",
    () =>
      readDocumentWithProvider(vision, {
        kind: isPdf ? "pdf" : "image",
        mediaType: input.mimeType,
        base64,
        filename: input.filename,
      }),
    {
      orgId: input.actor.orgId,
      userId: input.actor.userId ?? null,
      // The document's own bytes are the dedupe identity: the same file
      // re-uploaded (a double-submit, a retried form, a ZIP containing a
      // duplicate) must not be read twice. Only the SHA-256 reaches the ledger.
      dedupeContent: base64,
    },
  );
  // OVER THE CEILING, or an identical document already in flight. Degrade the
  // way this function ALREADY degrades on an unparseable response: an empty
  // sheet, which the pipeline shows the operator as an import with no rows to
  // review. Deliberately NOT `OcrUnavailableError` — that error's message tells
  // the operator to get a credential enabled, which would be a lie about a
  // budget refusal.
  if (outcome.status !== "ran") {
    console.warn(`[ocr] refused by the governor (${outcome.status}) — empty sheet`);
    return emptySheet(input.filename);
  }
  const text = outcome.value;

  let extracted: OcrExtraction;
  try {
    extracted = JSON.parse(stripCodeFence(text)) as OcrExtraction;
  } catch (e) {
    console.error("[ocr] JSON parse failed", e, { sample: text.slice(0, 300) });
    return emptySheet(input.filename);
  }

  // A delivery note maps to the RECEIVED (goods-received) leg, not the money
  // documents — different columns, no price/VAT — so it gets its own sheet shape.
  if (extracted.kind === "delivery_note") {
    return deliveryNoteExtractionToSheet(
      input.filename,
      toDeliveryNoteExtraction(extracted),
    );
  }

  return extractionToSheet(input.filename, extracted);
}

/**
 * Flatten a delivery-note extraction into a ParsedSheet feeding the three-way-
 * matching RECEIVED leg (a goods-received note: supplier + note number + date +
 * received quantities). PURE. One summary row carries the document-level fields;
 * one row per line item carries description + qty. No price / VAT columns — a
 * delivery note has none. Column names mirror the goods-received vocabulary so
 * the receipt leg recognises them.
 */
export function deliveryNoteExtractionToSheet(
  filename: string,
  e: DeliveryNoteExtraction,
): ParsedSheet {
  const header = [
    "entity_type",
    "supplier_name",
    "delivery_note_number",
    "delivery_date",
    "description",
    "qty",
    "source_filename",
  ];

  const rows: Cell[][] = [];

  // Summary row — document-level fields; line columns blank so downstream
  // mapping doesn't double-count.
  rows.push([
    "goods_received",
    e.supplier_name,
    e.delivery_note_number,
    e.delivery_date,
    null, // description
    null, // qty
    filename,
  ]);

  // One row per delivered line — same supplier / note number so the lines
  // collapse under their parent note.
  for (const li of e.line_items ?? []) {
    rows.push([
      "goods_received_line",
      e.supplier_name,
      e.delivery_note_number,
      e.delivery_date,
      li.description ?? "",
      li.qty,
      filename,
    ]);
  }

  return { name: filename, header, rows };
}

/**
 * The provider leg, isolated so the governor can time it and account for it.
 * Returns the raw text plus the `usage` the vendor says it billed — the ledger
 * records provider truth, never an estimate. Throws on any provider failure; the
 * caller owns the degraded path.
 */
async function readDocumentWithProvider(
  vision: NonNullable<ReturnType<typeof getVisionProvider>>,
  doc: { kind: "pdf" | "image"; mediaType: string; base64: string; filename: string },
): Promise<GovernedCall<string>> {
  const result = await vision.extract(
    { kind: doc.kind, mediaType: doc.mediaType, base64: doc.base64 },
    {
      system: SYSTEM_PROMPT,
      instruction: `${RESPONSE_INSTRUCTION}\n\nDocument filename: ${doc.filename}`,
      maxTokens: OCR_MAX_TOKENS,
    },
  );
  return {
    value: result.text,
    usage: {
      provider: vision.info.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
  };
}

function stripCodeFence(text: string): string {
  // Strip ```json … ``` if the model wraps the output. Defensive parse.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1] ?? text;
  return text.trim();
}

function emptySheet(name: string): ParsedSheet {
  return {
    name,
    header: ["entity_type", "customer_name", "number", "date", "total"],
    rows: [],
  };
}

/**
 * Flatten the extraction into a ParsedSheet. We produce one header
 * line + one row per line_item plus a summary row that captures the
 * document-level fields (number/date/total/etc).
 *
 * Naming the columns the same way the existing CSV detector expects
 * (`customer_name`, `number`, `total`, etc.) means the rest of the
 * pipeline picks the right entity type without any new branch.
 */
function extractionToSheet(
  filename: string,
  e: OcrExtraction,
): ParsedSheet {
  const header = [
    "entity_type",
    "customer_name",
    "number",
    "date",
    "vat_number",
    "description",
    "qty",
    "unit_price",
    "vat_rate",
    "line_total",
    "subtotal",
    "vat_total",
    "total",
    "status",
    "notes",
    "source_filename",
  ];

  const rows: Cell[][] = [];

  // Summary row — captures document-level fields. line_item columns
  // stay blank so downstream mapping doesn't double-count.
  rows.push([
    e.kind,
    e.customer_name,
    e.document_number,
    e.document_date,
    e.vat_number,
    null, // description
    null, // qty
    null, // unit_price
    null, // vat_rate
    null, // line_total
    e.subtotal,
    e.vat_total,
    e.total,
    e.status,
    e.notes,
    filename,
  ]);

  // One row per line item — same document number / customer so the
  // existing dedup logic can collapse them under the parent invoice.
  for (const li of e.line_items ?? []) {
    rows.push([
      `${e.kind}_line`,
      e.customer_name,
      e.document_number,
      e.document_date,
      e.vat_number,
      li.description ?? "",
      li.qty,
      li.unit_price,
      li.vat_rate,
      li.line_total,
      null, // subtotal
      null, // vat_total
      null, // total
      e.status,
      null, // notes
      filename,
    ]);
  }

  return { name: filename, header, rows };
}
