import { describe, it, expect } from "vitest";
import {
  toDeliveryNoteExtraction,
  deliveryNoteExtractionToSheet,
  type DeliveryNoteExtraction,
} from "@/lib/imports/ocr";

/**
 * Delivery-note OCR schema — the RECEIVED (goods-received) leg of three-way
 * matching. The governed vision path is DARK (no model call unless a cost tier
 * is bound); these are the PURE schema + sheet-mapping contracts that path feeds.
 */

/** A realistic delivery note as the vision model's JSON would decode. */
function parsedDeliveryNoteJson(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      kind: "delivery_note",
      customer_name: null,
      supplier_name: "Buildbase Ltd",
      document_number: "DN-88421",
      document_date: "2026-08-14",
      vat_number: null,
      subtotal: null,
      vat_total: null,
      total: null,
      status: null,
      notes: "Left at site gate",
      line_items: [
        { description: "OSB3 18mm 2440x1220", qty: 40, unit_price: null, vat_rate: null, line_total: null },
        { description: "C24 timber 47x100 4.8m", qty: 120, unit_price: null, vat_rate: null, line_total: null },
      ],
    }),
  );
}

describe("delivery-note extraction schema", () => {
  it("projects the shared OCR extraction onto the delivery-note shape", () => {
    // Cast mirrors ocrFileToSheet's own `JSON.parse(...) as OcrExtraction`.
    const extracted = parsedDeliveryNoteJson() as never;
    const dn = toDeliveryNoteExtraction(extracted);

    expect(dn.supplier_name).toBe("Buildbase Ltd");
    expect(dn.delivery_note_number).toBe("DN-88421");
    expect(dn.delivery_date).toBe("2026-08-14");
    expect(dn.line_items).toEqual([
      { description: "OSB3 18mm 2440x1220", qty: 40 },
      { description: "C24 timber 47x100 4.8m", qty: 120 },
    ]);
    // No money is carried across — a delivery note has none.
    expect(Object.keys(dn.line_items[0]!)).toEqual(["description", "qty"]);
  });

  it("degrades safely when fields are illegible (all null / no lines)", () => {
    const dn = toDeliveryNoteExtraction({
      kind: "delivery_note",
      customer_name: null,
      supplier_name: null,
      document_number: null,
      document_date: null,
      vat_number: null,
      subtotal: null,
      vat_total: null,
      total: null,
      status: null,
      notes: null,
      line_items: [],
    } as never);
    expect(dn).toEqual({
      supplier_name: null,
      delivery_note_number: null,
      delivery_date: null,
      line_items: [],
    });
  });
});

describe("delivery-note → ParsedSheet (feeds the goods-received / receipt leg)", () => {
  const dn: DeliveryNoteExtraction = {
    supplier_name: "Buildbase Ltd",
    delivery_note_number: "DN-88421",
    delivery_date: "2026-08-14",
    line_items: [
      { description: "OSB3 18mm 2440x1220", qty: 40 },
      { description: "C24 timber 47x100 4.8m", qty: 120 },
    ],
  };

  it("emits goods-received columns, no price/VAT", () => {
    const sheet = deliveryNoteExtractionToSheet("dn.pdf", dn);
    expect(sheet.header).toEqual([
      "entity_type",
      "supplier_name",
      "delivery_note_number",
      "delivery_date",
      "description",
      "qty",
      "source_filename",
    ]);
    // No money vocabulary leaks into the receipt leg.
    for (const col of ["unit_price", "vat_rate", "line_total", "total", "vat_total"]) {
      expect(sheet.header).not.toContain(col);
    }
  });

  it("produces one summary row + one row per delivered line, all rectangular", () => {
    const sheet = deliveryNoteExtractionToSheet("dn.pdf", dn);
    expect(sheet.rows).toHaveLength(3); // 1 summary + 2 lines
    for (const row of sheet.rows) expect(row).toHaveLength(sheet.header.length);

    const [summary, line1, line2] = sheet.rows;
    // Summary row: document-level fields, line columns blank.
    expect(summary![0]).toBe("goods_received");
    expect(summary![1]).toBe("Buildbase Ltd");
    expect(summary![2]).toBe("DN-88421");
    expect(summary![3]).toBe("2026-08-14");
    expect(summary![4]).toBeNull(); // description
    expect(summary![5]).toBeNull(); // qty

    // Line rows: qty + description, parent supplier/note carried for collapse.
    expect(line1![0]).toBe("goods_received_line");
    expect(line1![4]).toBe("OSB3 18mm 2440x1220");
    expect(line1![5]).toBe(40);
    expect(line2![5]).toBe(120);
    expect(line2![2]).toBe("DN-88421");
  });

  it("a delivery note with no legible lines still yields the summary row", () => {
    const sheet = deliveryNoteExtractionToSheet("dn.pdf", {
      supplier_name: null,
      delivery_note_number: null,
      delivery_date: null,
      line_items: [],
    });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]![0]).toBe("goods_received");
  });
});
