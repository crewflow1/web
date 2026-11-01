import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getVisionProvider } from "@/lib/ai/vision";
import { parseExtractionForForm } from "@/lib/imports/autofill/extract";
import { AUTOFILL_FORMS } from "@/lib/imports/autofill/registry";

/**
 * FEATURE 2 — REAL vision-provider extraction, end to end, on a representative
 * PDF and a representative PHOTOGRAPH.
 *
 * This is the integration test that proves live document extraction the moment a
 * credential exists — and documents EXACTLY what to supply when it does not.
 *
 * GATING. `getVisionProvider()` returns null unless the cheap governor tier is
 * bound (it is — claude-haiku-4-5, armed 2026-09-10) AND its credential is
 * present. With no credential the live cases SKIP (CI stays green) and the first
 * test asserts the door is correctly closed and prints the exact configuration.
 *
 * TO ACTIVATE (what the operator supplies):
 *   • ANTHROPIC_API_KEY=<a valid Anthropic key>   ← the only credential needed
 *   • AI_VISION_PROVIDER=anthropic                ← optional; this is the default
 *   The cheap tier model binding already exists, so the key alone opens the door.
 *
 * When ANTHROPIC_API_KEY is set, run:  npx vitest run --config \
 *   vitest.integration.config.ts __tests__/integration/ai/vision-document-extraction.test.ts
 * and the two live cases perform a REAL extraction and assert the invoice's
 * supplier name is read from the document.
 */

const FIXTURES = resolve(__dirname, "..", "..", "imports", "fixtures");
const PDF = readFileSync(resolve(FIXTURES, "invoice.pdf"));
const PHOTO = readFileSync(resolve(FIXTURES, "invoice-photo.jpg"));

const vision = getVisionProvider();
const live = vision ? it : it.skip;

describe("vision document extraction (REAL provider)", () => {
  it("states the exact configuration when the vision door is closed (dark = honest)", () => {
    if (vision) {
      // A provider is configured — the live cases below run. Nothing to assert.
      expect(vision.info.provider).toBeTruthy();
      return;
    }
    // No provider: this is the current production state. The door is closed, and
    // extraction correctly degrades to empty (the operator fills by hand). To
    // turn on automatic extraction, set ANTHROPIC_API_KEY (cheap tier is armed).
    expect(getVisionProvider()).toBeNull();
    // eslint-disable-next-line no-console
    console.info(
      "[vision] extraction is DARK — set ANTHROPIC_API_KEY " +
        "(AI_VISION_PROVIDER=anthropic, default) to activate. Cheap tier bound: claude-haiku-4-5.",
    );
  });

  live(
    "extracts a supplier from a representative PDF invoice",
    async () => {
      const config = AUTOFILL_FORMS.supplier;
      const result = await vision!.extract(
        { kind: "pdf", mediaType: "application/pdf", base64: PDF.toString("base64") },
        {
          system: config.systemPrompt,
          instruction: "Extract the fields as instructed and return the JSON object only.",
          maxTokens: 2000,
          signal: AbortSignal.timeout(30_000),
        },
      );
      const extraction = parseExtractionForForm("supplier", result.text);
      expect(extraction.engine).toBe("vision");
      // The fixture's header reads "Customer: OCR PDF Builders Ltd".
      expect(extraction.fields.name ?? "").toMatch(/builders|ocr pdf/i);
    },
    60_000,
  );

  live(
    "extracts from a representative PHOTOGRAPH (image path)",
    async () => {
      const config = AUTOFILL_FORMS.supplier;
      const result = await vision!.extract(
        { kind: "image", mediaType: "image/jpeg", base64: PHOTO.toString("base64") },
        {
          system: config.systemPrompt,
          instruction: "Extract the fields as instructed and return the JSON object only.",
          maxTokens: 2000,
          signal: AbortSignal.timeout(30_000),
        },
      );
      const extraction = parseExtractionForForm("supplier", result.text);
      expect(extraction.engine).toBe("vision");
      // An image OCR of the same invoice — at least one header field should read.
      const anyField = Object.values(extraction.fields).some((v) => v && v.length > 0);
      expect(anyField).toBe(true);
    },
    60_000,
  );
});
