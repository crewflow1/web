import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getMerchantAdapter,
  merchantProviderReady,
} from "@/lib/integrations/merchants/adapters";
import { CxmlMerchantAdapter } from "@/lib/integrations/merchants/adapters/cxml-merchant";
import { PendingMerchantAdapter } from "@/lib/integrations/merchants/adapters/pending";
import { MERCHANT_PROVIDERS } from "@/lib/integrations/merchants/types";
import {
  parsePriceFileCsv,
  parsePricePence,
} from "@/lib/integrations/merchants/price-file";
import {
  buildOrderRequestCxml,
  parseOrderResponseCxml,
  xmlEscape,
  type CxmlOrderContext,
} from "@/lib/integrations/merchants/cxml";
import type { PurchaseOrderPayload } from "@/lib/integrations/merchants/types";

/**
 * Merchant adapters + format helpers — behaviour + the real, knowable transport.
 *
 * These are the parts that are genuinely REAL/knowable today: adapter selection,
 * the CSV price-file parser, and the cXML OrderRequest builder/ack parser. The
 * network transport stays dark (proved in the security suite); here we prove the
 * pure logic that transport wraps is correct and deterministic.
 */

// ---------------------------------------------------------------------------
// Adapter selection — real (cXML) vs pending, and all dark by default
// ---------------------------------------------------------------------------

describe("adapter selection", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("MERCHANT_") || k === "NEXT_PUBLIC_FEATURE_MERCHANTS") {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("national merchants resolve to the concrete cXML adapter", () => {
    expect(getMerchantAdapter("travis_perkins")).toBeInstanceOf(CxmlMerchantAdapter);
    expect(getMerchantAdapter("jewson")).toBeInstanceOf(CxmlMerchantAdapter);
  });

  it("regional merchants resolve to the honest pending adapter", () => {
    expect(getMerchantAdapter("jp_corry")).toBeInstanceOf(PendingMerchantAdapter);
    expect(getMerchantAdapter("haldane_fisher")).toBeInstanceOf(PendingMerchantAdapter);
  });

  it("every merchant maps to an adapter whose provider matches the key", () => {
    for (const p of MERCHANT_PROVIDERS) {
      expect(getMerchantAdapter(p).provider).toBe(p);
      expect(merchantProviderReady(p)).toBe(false); // dark
    }
  });
});

// ---------------------------------------------------------------------------
// Price-file parser — the real, knowable CSV format
// ---------------------------------------------------------------------------

describe("parsePricePence", () => {
  it("parses decimals, integers, symbols and thousands separators to integer pence", () => {
    expect(parsePricePence("12.34")).toBe(1234);
    expect(parsePricePence("12")).toBe(1200);
    expect(parsePricePence("£12.34")).toBe(1234);
    expect(parsePricePence("1,234.50")).toBe(123450);
    expect(parsePricePence("0.01")).toBe(1);
  });

  it("returns null for non-numeric cells (row is skipped, not imported as 0)", () => {
    expect(parsePricePence("")).toBeNull();
    expect(parsePricePence("POA")).toBeNull();
    expect(parsePricePence("abc")).toBeNull();
  });

  it("avoids float artefacts (rounds pence half-up)", () => {
    expect(parsePricePence("0.1")).toBe(10);
    expect(parsePricePence("19.99")).toBe(1999);
  });
});

describe("parsePriceFileCsv", () => {
  it("maps aliased headers in any order to canonical items", () => {
    const csv = [
      "Stock Code,Description,Unit Price,UOM,VAT",
      "CEM-25,Cement 25kg,4.85,bag,S",
      "SND-BULK,Sharp Sand Bulk Bag,38.50,each,S",
    ].join("\n");
    const { items, skipped } = parsePriceFileCsv(csv);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sku: "CEM-25",
      description: "Cement 25kg",
      unit: "bag",
      unitPricePence: 485,
      currency: "GBP",
      vatCode: "S",
    });
    expect(items[1]!.unitPricePence).toBe(3850);
  });

  it("honours quoted fields containing commas", () => {
    const csv = ['SKU,Description,Price', 'X1,"Board, 8x4, WBP",25.00'].join("\n");
    const { items } = parsePriceFileCsv(csv);
    expect(items[0]!.description).toBe("Board, 8x4, WBP");
    expect(items[0]!.unitPricePence).toBe(2500);
  });

  it("skips rows with no SKU or no parseable price", () => {
    const csv = [
      "SKU,Price",
      "GOOD,10.00",
      ",5.00", // no sku
      "NOPRICE,POA", // unparseable price
    ].join("\n");
    const { items, skipped } = parsePriceFileCsv(csv);
    expect(items).toHaveLength(1);
    expect(items[0]!.sku).toBe("GOOD");
    expect(skipped).toBe(2);
  });

  it("throws loudly when the header lacks a SKU or price column", () => {
    expect(() => parsePriceFileCsv("Foo,Bar\n1,2")).toThrow(/header not recognised/i);
  });

  it("throws on an empty file rather than silently importing nothing", () => {
    expect(() => parsePriceFileCsv("")).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// cXML builder + ack parser — the real, knowable order wire format
// ---------------------------------------------------------------------------

const CTX: CxmlOrderContext = {
  fromDomain: "NetworkID",
  fromIdentity: "ACCT-42",
  toDomain: "NetworkID",
  toIdentity: "jewson",
  senderIdentity: "crewflow",
  sharedSecret: "s3cr3t",
  payloadId: "po-1@crewflow",
  timestamp: "2026-08-14T10:00:00.000Z",
};

const PO: PurchaseOrderPayload = {
  purchaseOrderId: "po-1",
  reference: "PO-1001",
  accountHandle: "ACCT-42",
  deliveryLines: ["Site 3", "Belfast"],
  requestedDeliveryDate: "2026-08-20",
  currency: "GBP",
  lines: [
    { sku: "CEM-25", description: "Cement 25kg", quantity: 10, unit: "bag", unitPricePence: 485 },
    { sku: "SND-BULK", description: "Sharp Sand", quantity: 2, unit: "each", unitPricePence: 3850 },
  ],
};

describe("buildOrderRequestCxml", () => {
  it("is deterministic given fixed ids + timestamp", () => {
    expect(buildOrderRequestCxml(PO, CTX)).toBe(buildOrderRequestCxml(PO, CTX));
  });

  it("emits one ItemOut per line with SupplierPartID + money in major units", () => {
    const xml = buildOrderRequestCxml(PO, CTX);
    expect((xml.match(/<ItemOut\b/g) ?? []).length).toBe(2);
    expect(xml).toContain("<SupplierPartID>CEM-25</SupplierPartID>");
    expect(xml).toContain('<Money currency="GBP">4.85</Money>');
    // Total = 10*485 + 2*3850 = 12550p = 125.50
    expect(xml).toContain('<Money currency="GBP">125.50</Money>');
    expect(xml).toContain('<Extrinsic name="AccountNumber">ACCT-42</Extrinsic>');
  });

  it("throws on an order with no lines", () => {
    expect(() => buildOrderRequestCxml({ ...PO, lines: [] }, CTX)).toThrow(/no lines/i);
  });
});

describe("xmlEscape prevents injection into the order document", () => {
  it("escapes markup metacharacters", () => {
    expect(xmlEscape('a & b <c> "d" \'e\'')).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
  });

  it("a malicious description cannot break out of its element", () => {
    const xml = buildOrderRequestCxml(
      {
        ...PO,
        lines: [
          { sku: "X</SupplierPartID><evil/>", description: "<script>x</script>", quantity: 1, unit: null, unitPricePence: 1 },
        ],
      },
      CTX,
    );
    expect(xml).not.toContain("<evil/>");
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;script&gt;");
  });
});

describe("parseOrderResponseCxml", () => {
  it("reads a 200 Status as an accepted order", () => {
    const ack = parseOrderResponseCxml(
      '<cXML><Response><Status code="200" text="OK">order 987</Status></Response></cXML>',
    );
    expect(ack.ok).toBe(true);
    expect(ack.statusCode).toBe(200);
    expect(ack.text).toBe("OK");
  });

  it("reads a non-2xx Status as a rejection", () => {
    const ack = parseOrderResponseCxml('<cXML><Response><Status code="450" text="Bad account"/></Response></cXML>');
    expect(ack.ok).toBe(false);
    expect(ack.statusCode).toBe(450);
  });

  it("treats a response with no Status as a failure", () => {
    const ack = parseOrderResponseCxml("<cXML><Response/></cXML>");
    expect(ack.ok).toBe(false);
    expect(ack.statusCode).toBe(0);
  });
});
