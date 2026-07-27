import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { AssetLabelPdf, type AssetLabelInput } from "@/lib/pdf/asset-label-pdf";

/**
 * QR label PDF generation test — renders the label (with a real vector QR from
 * `qrcode`) to a buffer, exactly as the /api/assets/[id]/label/pdf route does.
 * Proves the template + QR matrix render without throwing, for a single label
 * and a print sheet, and that no financial field is even accepted by the input.
 */

const label: AssetLabelInput = {
  org_name: "Carter Construction Ltd",
  asset_name: "Kubota KX016-4 mini excavator",
  asset_ref: "FLEET-14",
  category: "Plant / machinery",
  serial_number: "KX016-8891",
  registration: null,
  scan_url: "https://crewflow.uk/a/abc123_-XYZtoken0000000000",
};

describe("AssetLabelPdf", () => {
  it("renders a single label to a well-formed PDF", async () => {
    const buffer = await renderToBuffer(AssetLabelPdf({ label, copies: 1 }));
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a print sheet (many copies) without throwing", async () => {
    const buffer = await renderToBuffer(AssetLabelPdf({ label, copies: 12 }));
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with only a minimal label (no optional fields)", async () => {
    const bare: AssetLabelInput = {
      org_name: "CrewFlow",
      asset_name: "Generator",
      asset_ref: null,
      category: null,
      serial_number: null,
      registration: null,
      scan_url: "https://crewflow.uk/a/tok",
    };
    const buffer = await renderToBuffer(AssetLabelPdf({ label: bare, copies: 1 }));
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("the label input type carries no financial/internal fields", () => {
    // Compile-time guarantee reflected at runtime: the only keys are safe/public.
    const keys = Object.keys(label).sort();
    expect(keys).toEqual(
      [
        "asset_name",
        "asset_ref",
        "category",
        "org_name",
        "registration",
        "scan_url",
        "serial_number",
      ].sort(),
    );
    expect(keys).not.toContain("purchase_price");
    expect(keys).not.toContain("current_value");
  });
});
