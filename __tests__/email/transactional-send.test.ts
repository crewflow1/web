import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * lib/email/send-invoice.ts + lib/email/send-quote.ts — the REAL transactional
 * send path (streams 7 · comms verification).
 *
 * Every existing test mocks THESE helpers out (manual-reminder, reminders,
 * active-org-send-gate, …) to assert the routes call them — so the helpers'
 * own job was never verified: resolve the right recipient, build the right
 * subject/body from the real template, attach the PDF, DISPATCH exactly once,
 * and stamp status only on success. This file exercises the real helpers with
 * a mocked Supabase client, a mocked PDF renderer (no react-pdf cost) and a
 * mocked transport (`sendEmail`) so nothing leaves the process, and pins:
 *
 *   - recipient resolution (own customer, options.to override, quote fallback,
 *     missing/invalid recipient),
 *   - the real subject + PDF filename that reach the transport,
 *   - a VOID invoice is never emailed,
 *   - a transport failure is surfaced as send_failed (never a false success),
 *   - status is flipped to "sent" only after a successful dispatch.
 */

// ---- env: arm Resend + app URL (helpers early-return no_resend_key otherwise)
const envState = vi.hoisted(() => ({
  RESEND_API_KEY: "re_test_key" as string | undefined,
  RESEND_FROM_EMAIL: "CrewFlow <hello@crewflow.uk>",
  RESEND_REPLY_TO: "hello@crewflow.uk",
  NEXT_PUBLIC_APP_URL: "https://crewflow.uk",
}));
vi.mock("@/lib/env", () => ({ env: envState }));

// ---- transport double: capture the exact SendEmailInput, return success
const transport = vi.hoisted(() => ({
  sendEmail: vi.fn(
    async (_input: Record<string, unknown>): Promise<unknown> => ({ sent: true, id: "re_dispatched" }),
  ),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: transport.sendEmail }));

// ---- PDF + logo: keep it pure Node, no react-pdf / storage I/O
vi.mock("@react-pdf/renderer", () => ({
  renderToBuffer: vi.fn(async () => Buffer.from("%PDF-1.7 fake")),
}));
vi.mock("@/lib/pdf/invoice-pdf", () => ({ InvoicePdf: (p: unknown) => p }));
vi.mock("@/lib/pdf/quote-pdf", () => ({ QuotePdf: (p: unknown) => p }));
vi.mock("@/server/services/company-logo", () => ({
  resolveOrgLogoSrc: vi.fn(async () => null),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// ---------------------------------------------------------------------------
// Minimal Supabase chain double. Per-table config drives maybeSingle (the row),
// range (line items via fetchAllRows) and await-of-chain (update writes).
// ---------------------------------------------------------------------------
type TableCfg = {
  single?: unknown;
  singleError?: unknown;
  lines?: unknown[];
  linesError?: unknown;
  updateError?: unknown;
};
type Store = Record<string, TableCfg>;

function makeSupabase(store: Store) {
  const updates: Record<string, unknown[]> = {};
  const client = {
    _updates: updates,
    from(table: string) {
      const cfg = store[table] ?? {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.insert = () => chain;
      chain.update = (vals: unknown) => {
        (updates[table] ??= []).push(vals);
        return chain;
      };
      chain.eq = () => chain;
      chain.order = () => chain;
      // fetchAllRows terminal: one short page ⇒ paging stops.
      chain.range = () =>
        Promise.resolve({ data: cfg.lines ?? [], error: cfg.linesError ?? null });
      chain.maybeSingle = () =>
        Promise.resolve({ data: cfg.single ?? null, error: cfg.singleError ?? null });
      // Awaiting the chain directly (an update write) resolves to {error}.
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ error: cfg.updateError ?? null }).then(resolve, reject);
      return chain;
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & {
    _updates: Record<string, unknown[]>;
  };
}

const ORG = {
  name: "Acme Builders",
  phone: "0123",
  vat_number: "GB123",
  logo_path: null,
  logo_url: null,
  address: null,
  bank_details: null,
};

const { sendInvoiceEmail } = await import("@/lib/email/send-invoice");
const { sendQuoteEmail } = await import("@/lib/email/send-quote");

beforeEach(() => {
  transport.sendEmail.mockReset();
  transport.sendEmail.mockResolvedValue({ sent: true, id: "re_dispatched" } as unknown);
  envState.RESEND_API_KEY = "re_test_key";
});

// ---------------------------------------------------------------------------
// INVOICE
// ---------------------------------------------------------------------------
describe("sendInvoiceEmail — recipient, body, dispatch", () => {
  const invoiceRow = {
    id: "inv-1",
    number: "INV-0042",
    status: "draft",
    amount: 800,
    vat_total: 180,
    total: 980,
    due_date: "2026-11-15",
    paid_at: null,
    notes: null,
    quote_id: null,
    customer: { name: "Pat Jones", email: "pat@customer.example" },
    quote: null,
    org: ORG,
  };
  const lines = [
    { description: "Labour", qty: 1, unit_price: 800, vat_rate: 20, line_total: 800, sort_order: 0 },
  ];

  it("builds the right recipient/subject + PDF attachment and dispatches once", async () => {
    const supabase = makeSupabase({
      invoices: { single: invoiceRow },
      invoice_line_items: { lines },
    });
    const res = await sendInvoiceEmail(supabase, "inv-1");

    expect(res.sent).toBe(true);
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    const input = transport.sendEmail.mock.calls[0]![0] as {
      to: string; subject: string; html: string; attachments: { filename: string }[];
    };
    expect(input.to).toBe("pat@customer.example"); // the invoice's OWN customer
    expect(input.subject).toBe("Acme Builders — Invoice INV-0042 (£980.00)");
    expect(input.html).toContain("INV-0042");
    expect(input.attachments[0]!.filename).toBe("INV-0042.pdf");
    // draft → sent only AFTER a successful dispatch
    expect(res.sent === true && res.new_status).toBe("sent");
    expect(supabase._updates.invoices?.[0]).toMatchObject({ status: "sent" });
  });

  it("prefers an explicit options.to over the stored customer email", async () => {
    const supabase = makeSupabase({ invoices: { single: invoiceRow }, invoice_line_items: { lines } });
    await sendInvoiceEmail(supabase, "inv-1", { to: "override@elsewhere.example" });
    const input = transport.sendEmail.mock.calls[0]![0] as { to: string };
    expect(input.to).toBe("override@elsewhere.example");
  });

  it("falls back to the quote's customer when the invoice has no direct customer", async () => {
    const orphan = {
      ...invoiceRow,
      customer: null,
      quote: { customer: { name: "Legacy", email: "legacy@customer.example" } },
    };
    const supabase = makeSupabase({ invoices: { single: orphan }, invoice_line_items: { lines } });
    await sendInvoiceEmail(supabase, "inv-1");
    expect((transport.sendEmail.mock.calls[0]![0] as { to: string }).to).toBe("legacy@customer.example");
  });

  it("never emails a VOID invoice", async () => {
    const supabase = makeSupabase({ invoices: { single: { ...invoiceRow, status: "void" } } });
    const res = await sendInvoiceEmail(supabase, "inv-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("voided");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing invoice (no dispatch)", async () => {
    const supabase = makeSupabase({ invoices: { single: null } });
    const res = await sendInvoiceEmail(supabase, "inv-x");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("not_found");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("returns no_recipient when there is no address anywhere", async () => {
    const supabase = makeSupabase({
      invoices: { single: { ...invoiceRow, customer: null, quote: null } },
      invoice_line_items: { lines },
    });
    const res = await sendInvoiceEmail(supabase, "inv-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("no_recipient");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("returns invalid_recipient for a malformed address (never dispatches)", async () => {
    const supabase = makeSupabase({ invoices: { single: invoiceRow }, invoice_line_items: { lines } });
    const res = await sendInvoiceEmail(supabase, "inv-1", { to: "not-an-email" });
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("invalid_recipient");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("surfaces a transport failure as send_failed and does NOT flip status", async () => {
    transport.sendEmail.mockResolvedValue({ sent: false, reason: "error", error: "domain not verified" } as unknown);
    const supabase = makeSupabase({ invoices: { single: invoiceRow }, invoice_line_items: { lines } });
    const res = await sendInvoiceEmail(supabase, "inv-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("send_failed");
    // No post-send status update was attempted.
    expect(supabase._updates.invoices).toBeUndefined();
  });

  it("bails with load_failed when the line-items read errors (never emails totals with no lines)", async () => {
    const supabase = makeSupabase({
      invoices: { single: invoiceRow },
      invoice_line_items: { linesError: { message: "boom", code: "42P01" } },
    });
    const res = await sendInvoiceEmail(supabase, "inv-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("load_failed");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("does NOT change status on a reminder send (status reflects the original send)", async () => {
    const supabase = makeSupabase({
      invoices: { single: { ...invoiceRow, status: "sent" } },
      invoice_line_items: { lines },
    });
    const res = await sendInvoiceEmail(supabase, "inv-1", { kind: "reminder", reminder_stage: "day_7" });
    expect(res.sent).toBe(true);
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    expect(supabase._updates.invoices).toBeUndefined(); // reminders never write status
  });
});

// ---------------------------------------------------------------------------
// QUOTE
// ---------------------------------------------------------------------------
describe("sendQuoteEmail — recipient, portal link, dispatch", () => {
  const quoteRow = {
    id: "quo-1",
    number: "QUO-0007",
    status: "draft",
    subtotal: 1000,
    vat_total: 200,
    total: 1200,
    valid_until: "2026-12-01",
    eot_requested_completion_date: null,
    eot_agreed_completion_date: null,
    notes: null,
    terms: null,
    public_token: "tok-existing",
    customer: { name: "Pat Jones", email: "pat@customer.example" },
    org: ORG,
  };
  const lines = [
    { description: "Groundworks", qty: 1, unit_price: 1000, vat_rate: 20, line_total: 1000, sort_order: 0 },
  ];

  it("dispatches with the right recipient/subject and a portal link using the existing token", async () => {
    const supabase = makeSupabase({ quotes: { single: quoteRow }, quote_line_items: { lines } });
    const res = await sendQuoteEmail(supabase, "quo-1");
    expect(res.sent).toBe(true);
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    const input = transport.sendEmail.mock.calls[0]![0] as {
      to: string; subject: string; html: string; attachments: { filename: string }[];
    };
    expect(input.to).toBe("pat@customer.example");
    expect(input.subject).toBe("Acme Builders — Quote QUO-0007 (£1,200.00)");
    expect(input.html).toContain("https://crewflow.uk/q/tok-existing");
    expect(input.attachments[0]!.filename).toBe("QUO-0007.pdf");
    if (res.sent) {
      expect(res.portal_url).toBe("https://crewflow.uk/q/tok-existing");
      expect(res.new_status).toBe("sent");
    }
  });

  it("mints a public token when the quote has none, then dispatches a portal link for it", async () => {
    const supabase = makeSupabase({
      quotes: { single: { ...quoteRow, public_token: null } },
      quote_line_items: { lines },
    });
    const res = await sendQuoteEmail(supabase, "quo-1");
    expect(res.sent).toBe(true);
    // A token was written back to quotes (the first update is the token mint).
    const firstWrite = supabase._updates.quotes?.[0] as { public_token?: string } | undefined;
    expect(typeof firstWrite?.public_token).toBe("string");
    const input = transport.sendEmail.mock.calls[0]![0] as { html: string };
    expect(input.html).toContain(`https://crewflow.uk/q/${firstWrite?.public_token}`);
  });

  it("does NOT flip an already-accepted quote back to sent on a resend", async () => {
    const supabase = makeSupabase({
      quotes: { single: { ...quoteRow, status: "accepted" } },
      quote_line_items: { lines },
    });
    const res = await sendQuoteEmail(supabase, "quo-1");
    expect(res.sent).toBe(true);
    if (res.sent) expect(res.new_status).toBe("accepted");
  });

  it("surfaces a transport failure as send_failed", async () => {
    transport.sendEmail.mockResolvedValue({ sent: false, reason: "error", error: "rate limited" } as unknown);
    const supabase = makeSupabase({ quotes: { single: quoteRow }, quote_line_items: { lines } });
    const res = await sendQuoteEmail(supabase, "quo-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("send_failed");
  });

  it("returns no_recipient when the quote has no customer email and no override", async () => {
    const supabase = makeSupabase({
      quotes: { single: { ...quoteRow, customer: null } },
      quote_line_items: { lines },
    });
    const res = await sendQuoteEmail(supabase, "quo-1");
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("no_recipient");
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });
});
