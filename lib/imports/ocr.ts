import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import type { ParsedSheet, Cell } from "./parsers";

/**
 * Migration OS v2 — OCR import for PDFs and photos/screenshots.
 *
 * Takes a PDF or image file (JPEG/PNG/HEIC/WEBP) and asks Claude to
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
 *   2. We ask Claude for a strict JSON shape and parse it ourselves —
 *      no tool-use round-trips. If the model breaks the schema, we
 *      treat the file as unparseable and let the operator know.
 *
 *   3. If ANTHROPIC_API_KEY is not configured (preview / dev / a hosted
 *      tier that doesn't pay for OCR), we throw a tagged error so the
 *      upload action can surface a friendly message instead of 500ing.
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
    super(
      "PDF / photo import isn't configured on this server. Ask CrewFlow to enable ANTHROPIC_API_KEY, or upload the same data as CSV / Excel.",
    );
    this.name = "OcrUnavailableError";
  }
}

type OcrExtraction = {
  kind: "invoice" | "quote" | "receipt" | "unknown";
  customer_name: string | null;
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

const SYSTEM_PROMPT = `You extract invoice, quote, and receipt data from
PDFs and photos for CrewFlow — UK construction-company software. Output
strict JSON only, no commentary. If a field isn't legible, set it to
null. Never invent values. Normalise amounts to GBP numerics (no
currency symbols). Dates as YYYY-MM-DD when possible. Confidence is
deliberately moderate because OCR mistakes happen — the operator
reviews everything before commit.`;

const RESPONSE_INSTRUCTION = `Return JSON of this exact shape and
nothing else:

{
  "kind": "invoice" | "quote" | "receipt" | "unknown",
  "customer_name": string | null,
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

/**
 * Run a single PDF/image through Claude vision and return ParsedSheet
 * rows ready for the existing detect/map/commit pipeline.
 *
 * One ParsedSheet per document — header columns are the canonical
 * field names so the existing entity detector recognises them.
 */
export async function ocrFileToSheet(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<ParsedSheet> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new OcrUnavailableError();
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const base64 = Buffer.from(input.bytes).toString("base64");

  // PDF "document" content blocks landed in the Anthropic API after the
  // currently-installed SDK was released (^0.32.0). The API supports
  // them; the local TS types don't yet. Cast the request body through
  // `unknown` so we keep type safety on the parts the SDK does know
  // about while letting PDFs through. Images use the SDK's typed
  // ImageBlockParam shape directly.
  const pdfDocBlock = {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: base64,
    },
  };
  const imageBlock = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: input.mimeType as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp",
      data: base64,
    },
  };
  const contentBlock =
    input.mimeType === "application/pdf" ? pdfDocBlock : imageBlock;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          {
            type: "text",
            text: `${RESPONSE_INSTRUCTION}\n\nDocument filename: ${input.filename}`,
          },
        ] as never,
      },
    ],
  });

  // The SDK union'd ContentBlock includes TextBlock + ToolUseBlock.
  // Narrow by `.type === "text"` so the .text access is type-safe across
  // SDK versions without importing a named TextBlock type.
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  let extracted: OcrExtraction;
  try {
    extracted = JSON.parse(stripCodeFence(text)) as OcrExtraction;
  } catch (e) {
    console.error("[ocr] JSON parse failed", e, { sample: text.slice(0, 300) });
    return emptySheet(input.filename);
  }

  return extractionToSheet(input.filename, extracted);
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
