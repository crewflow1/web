import { describe, expect, it } from "vitest";
import {
  buildDocumentLibrary,
  PORTAL_DOC_TYPE_LABELS,
} from "@/lib/customers/portal-documents";

const TOKEN = "22222222-2222-4222-8222-222222222222";

describe("buildDocumentLibrary", () => {
  it("aggregates quotes/invoices/reports newest-first with real PDF hrefs", () => {
    const docs = buildDocumentLibrary({
      token: TOKEN,
      quotes: [
        { id: "q1", number: "Q-0001", status: "accepted", total: 2400, sent_at: "2026-07-01", accepted_at: "2026-07-10", public_token: "pt1" },
      ],
      invoices: [
        { id: "i1", number: "INV-0001", status: "sent", total: 2400, sent_at: "2026-07-12" },
      ],
      reports: [
        { id: "r1", report_number: "SR-0003", title: "Progress report #3", issued_at: "2026-07-05", portal_published_at: "2026-07-05" },
      ],
    });

    expect(docs.map((d) => d.type)).toEqual(["invoice", "quote", "report"]); // by date desc
    const inv = docs[0]!;
    expect(inv.pdfHref).toBe(`/customer-portal/${TOKEN}/invoices/i1/pdf`);
    expect(inv.sub).toBe("£2,400.00 · sent");
    const quote = docs[1]!;
    expect(quote.pdfHref).toBe("/q/pt1/pdf");
    expect(quote.viewHref).toBe("/q/pt1");
    const rep = docs[2]!;
    expect(rep.pdfHref).toBe(`/customer-portal/${TOKEN}/reports/r1/pdf`);
    expect(rep.title).toBe("Progress report #3");
  });

  it("excludes quotes with no public token (they never cleared the portal gate)", () => {
    const docs = buildDocumentLibrary({
      token: TOKEN,
      quotes: [{ id: "q1", number: "Q-0009", status: "draft", total: 100, sent_at: null, accepted_at: null, public_token: null }],
      invoices: [],
      reports: [],
    });
    expect(docs).toHaveLength(0);
  });

  it("labels the three document types", () => {
    expect(PORTAL_DOC_TYPE_LABELS.quote).toBe("Quote");
    expect(PORTAL_DOC_TYPE_LABELS.invoice).toBe("Invoice");
    expect(PORTAL_DOC_TYPE_LABELS.report).toBe("Report");
  });
});
