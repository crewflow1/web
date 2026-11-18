import { describe, it, expect } from "vitest";
import { buildQuoteEmail } from "@/lib/email/templates/quote";
import { buildInvoiceEmail } from "@/lib/email/templates/invoice";

/**
 * lib/email/templates/{quote,invoice} — the transactional email BODY builders
 * (streams 7 · comms verification).
 *
 * These pure builders decide the exact subject + HTML + text that a customer
 * receives for a quote or invoice. They were never unit-tested, yet they:
 *   1. carry the customer-facing subject contract (org — DOC number (GBP total)),
 *   2. embed UNTRUSTED input — the customer name and the sender's free-text
 *      message both land inside an HTML document — so an un-escaped `<script>`
 *      or `"` would be an HTML-injection vector in the recipient's mail client.
 *
 * The escaping assertions are the security spine here: customer name and the
 * custom message MUST be HTML-escaped in the html body.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

describe("buildQuoteEmail", () => {
  const base = {
    org_name: "Acme Builders",
    customer_name: "Pat Jones",
    quote_number: "QUO-0007",
    total: 1234.5,
    valid_until: "2026-12-01",
    message: null as string | null,
    portal_url: "https://crewflow.uk/q/tok-abc",
  };

  it("subject = 'org — Quote NUMBER (GBP total)'", () => {
    const { subject } = buildQuoteEmail(base);
    expect(subject).toBe(`Acme Builders — Quote QUO-0007 (${GBP.format(1234.5)})`);
    expect(subject).toContain("£1,234.50");
  });

  it("html + text carry the portal approve/reject link and the number + total", () => {
    const { html, text } = buildQuoteEmail(base);
    expect(html).toContain("https://crewflow.uk/q/tok-abc");
    expect(html).toContain("QUO-0007");
    expect(html).toContain("£1,234.50");
    expect(text).toContain("View, approve or reject your quote: https://crewflow.uk/q/tok-abc");
    expect(text).toContain("QUO-0007");
  });

  it("includes the valid-until line when present and omits it when null", () => {
    expect(buildQuoteEmail(base).html).toContain("Valid until");
    const noValid = buildQuoteEmail({ ...base, valid_until: null });
    expect(noValid.html).not.toContain("Valid until");
    expect(noValid.text).not.toContain("Valid until");
  });

  it("falls back to a generic greeting when there is no customer name", () => {
    const { html } = buildQuoteEmail({ ...base, customer_name: null });
    expect(html).toContain("Hi,");
  });

  it("HTML-ESCAPES an untrusted customer name (no raw tag injected into the body)", () => {
    const { html } = buildQuoteEmail({
      ...base,
      customer_name: '<script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-ESCAPES the sender's free-text custom message", () => {
    const { html } = buildQuoteEmail({
      ...base,
      message: 'see <b>bold</b> & "quotes"',
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("buildInvoiceEmail", () => {
  const base = {
    org_name: "Acme Builders",
    customer_name: "Pat Jones",
    invoice_number: "INV-0042",
    total: 980,
    due_date: "2026-11-15",
    message: null as string | null,
    pdf_url: null as string | null,
  };

  it("subject = 'org — Invoice NUMBER (GBP total)'", () => {
    const { subject } = buildInvoiceEmail(base);
    expect(subject).toBe(`Acme Builders — Invoice INV-0042 (${GBP.format(980)})`);
    expect(subject).toContain("£980.00");
  });

  it("includes the due-by line when a due date is present, omits it otherwise", () => {
    expect(buildInvoiceEmail(base).html).toContain("Due by");
    expect(buildInvoiceEmail({ ...base, due_date: null }).html).not.toContain("Due by");
  });

  it("adds the inline 'view it online' link only when a pdf_url is supplied", () => {
    expect(buildInvoiceEmail(base).html).not.toContain("view it online");
    const withUrl = buildInvoiceEmail({ ...base, pdf_url: "https://crewflow.uk/p/x" });
    expect(withUrl.html).toContain("view it online");
    expect(withUrl.html).toContain("https://crewflow.uk/p/x");
  });

  it("HTML-ESCAPES an untrusted customer name", () => {
    const { html } = buildInvoiceEmail({ ...base, customer_name: '"><img src=x>' });
    expect(html).not.toContain('"><img src=x>');
    expect(html).toContain("&quot;&gt;&lt;img");
  });
});
