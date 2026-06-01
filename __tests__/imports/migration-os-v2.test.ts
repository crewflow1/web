import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isOcrFile, OCR_SUPPORTED_MIME, OcrUnavailableError } from "@/lib/imports/ocr";
import { CONNECTORS, type Connector } from "@/lib/imports/connectors";

/**
 * Migration OS v2 — contract tests.
 *
 * Pins:
 *   - OCR detector accepts PDF + the four image formats the CEO listed
 *   - OcrUnavailableError surfaces a friendly message when the
 *     ANTHROPIC_API_KEY isn't configured (no opaque 500)
 *   - All four connector cards are present in the catalogue (Sage, Xero,
 *     QuickBooks, Buildertrend) with the right shape
 *   - Imports detail page accepts PDF / JPG / PNG / HEIC / WEBP MIME
 *     types so the file picker actually surfaces them
 */

const ROOT = resolve(__dirname, "..", "..");
const IMPORTS_PAGE = readFileSync(
  resolve(ROOT, "app/(app)/imports/page.tsx"),
  "utf8",
);
const IMPORT_DETAIL = readFileSync(
  resolve(ROOT, "app/(app)/imports/[id]/page.tsx"),
  "utf8",
);
const IMPORT_ACTIONS = readFileSync(
  resolve(ROOT, "app/(app)/imports/actions.ts"),
  "utf8",
);

describe("OCR file detection", () => {
  it("accepts every supported MIME type", () => {
    for (const mime of [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]) {
      expect(OCR_SUPPORTED_MIME.has(mime), `missing ${mime}`).toBe(true);
    }
  });

  it("falls back to filename detection when MIME is unset", () => {
    expect(isOcrFile({ name: "invoice.pdf" })).toBe(true);
    expect(isOcrFile({ name: "scan.jpg" })).toBe(true);
    expect(isOcrFile({ name: "scan.JPEG" })).toBe(true);
    expect(isOcrFile({ name: "shot.png" })).toBe(true);
    expect(isOcrFile({ name: "thumb.heic" })).toBe(true);
  });

  it("rejects CSV / Excel (those go through the existing parsers)", () => {
    expect(isOcrFile({ name: "customers.csv", type: "text/csv" })).toBe(false);
    expect(
      isOcrFile({
        name: "data.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(false);
  });

  it("OcrUnavailableError carries a customer-friendly message", () => {
    const e = new OcrUnavailableError();
    expect(e.name).toBe("OcrUnavailableError");
    expect(e.message).toMatch(/CSV/);
    expect(e.message).toMatch(/Excel/);
  });
});

describe("Migration OS connector catalogue", () => {
  it("lists Sage, Xero, QuickBooks, Buildertrend at minimum", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(ids).toContain("sage");
    expect(ids).toContain("xero");
    expect(ids).toContain("quickbooks");
    expect(ids).toContain("buildertrend");
  });

  it("every connector has a coherent shape", () => {
    for (const c of CONNECTORS as readonly Connector[]) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.blurb.length).toBeGreaterThan(0);
      // Connector model moved from "coming_soon" placeholders to a working
      // "guided" export→upload flow for every brand (see connectors.ts header).
      expect(["available", "guided"]).toContain(c.status);
      expect(c.exportHints.length).toBeGreaterThan(0);
    }
  });
});

describe("Upload action wires OCR + clear errors", () => {
  it("calls ocrFileToSheet for PDF/image branches", () => {
    expect(IMPORT_ACTIONS).toMatch(/ocrFileToSheet/);
    expect(IMPORT_ACTIONS).toMatch(/isOcrFile/);
  });

  it("surfaces ocr_unavailable as a distinct error code, not a 500", () => {
    expect(IMPORT_ACTIONS).toMatch(/OcrUnavailableError/);
    expect(IMPORT_ACTIONS).toMatch(/ocr_unavailable/);
  });
});

describe("Upload UI accepts the new file types", () => {
  it("accept= attribute includes PDF + image MIME types", () => {
    expect(IMPORT_DETAIL).toMatch(/application\/pdf/);
    expect(IMPORT_DETAIL).toMatch(/image\/jpeg/);
    expect(IMPORT_DETAIL).toMatch(/image\/png/);
    expect(IMPORT_DETAIL).toMatch(/image\/heic/);
  });

  it("accept= attribute includes the file extensions too", () => {
    expect(IMPORT_DETAIL).toMatch(/\.pdf/);
    expect(IMPORT_DETAIL).toMatch(/\.jpg/);
    expect(IMPORT_DETAIL).toMatch(/\.png/);
    expect(IMPORT_DETAIL).toMatch(/\.heic/);
  });

  it("the list page advertises Sage/Xero/QuickBooks/Buildertrend", () => {
    expect(IMPORTS_PAGE).toMatch(/CONNECTORS/);
    // Cards now show a "Guided" badge (working export→upload flow), replacing
    // the old "Coming soon" placeholder label.
    expect(IMPORTS_PAGE).toMatch(/Guided/);
  });
});
