import { describe, it, expect, vi, afterEach } from "vitest";

import {
  getAccountingAdapter,
  getAccountingImportAdapter,
  type AccountingPushInput,
  type AccountingPullInput,
} from "@/lib/integrations/accounting/adapters";
import {
  refreshAccessToken,
  resolveSageBusinessId,
} from "@/lib/integrations/accounting/oauth";
import {
  buildSageInvoiceBody,
  buildSagePaymentBody,
  sageSalesTaxRatePercentage,
} from "@/lib/integrations/accounting/provider-payloads";
import {
  UnknownVatRateError,
  type CanonicalAccountingRow,
} from "@/lib/integrations/accounting/canonical";

/**
 * Sage Business Cloud Accounting PUSH / PULL — hermetic HTTP-mock proofs.
 *
 * Provider HTTP is fully mocked (global `fetch`), so these tests never touch a
 * real Sage server. Against the ACTIVATED gate (flag + client credentials set
 * in-test) they prove the request SHAPE (endpoint, Bearer + X-Business header,
 * stable Idempotency-Key, body), 401→refresh→retry-once, entity resolution,
 * tax-rate resolution, the payment-link posture, per-entity idempotency, pull
 * mapping, and dark-refuse.
 */

const INVOICE_ROW: CanonicalAccountingRow = {
  date: "2026-02-01",
  type: "invoice",
  customer: "Acme Ltd",
  net: "100.00",
  vat: "20.00",
  gross: "120.00",
  invoice_number: "INV-001",
  status: "sent",
};

const PAYMENT_ROW: CanonicalAccountingRow = {
  date: "2026-02-05",
  type: "payment",
  customer: "Acme Ltd",
  net: "",
  vat: "",
  gross: "120.00",
  invoice_number: "INV-001",
  status: "received",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ORIGINAL_ENV = { ...process.env };
const GATE_KEYS = [
  "FEATURE_ACCOUNTING_CONNECT",
  "SAGE_CLIENT_ID",
  "SAGE_CLIENT_SECRET",
  "SAGE_SALES_LEDGER_ACCOUNT_ID",
  "SAGE_BANK_ACCOUNT_ID",
  "SAGE_API_BASE_URL",
];

function clearGate() {
  for (const k of GATE_KEYS) delete process.env[k];
}
function enableSage() {
  process.env.FEATURE_ACCOUNTING_CONNECT = "1";
  process.env.SAGE_CLIENT_ID = "sage-id";
  process.env.SAGE_CLIENT_SECRET = "sage-secret";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

/** Route a Sage request to the right canned response by URL + method. */
function sageRouter(handlers: {
  ledger?: () => Response;
  bank?: () => Response;
  taxRates?: () => Response;
  contactQuery?: () => Response;
  invoiceQuery?: () => Response;
  contactCreate?: () => Response;
  invoiceCreate?: () => Response;
  paymentCreate?: () => Response;
}) {
  const items = (arr: unknown[]) => jsonResponse({ $items: arr });
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (url.includes("/ledger_accounts")) return (handlers.ledger ?? (() => items([{ id: "LA-1" }])))();
      if (url.includes("/bank_accounts")) return (handlers.bank ?? (() => items([{ id: "BA-1" }])))();
      if (url.includes("/tax_rates"))
        return (handlers.taxRates ??
          (() => items([{ id: "TR-20", percentage: 20 }, { id: "TR-5", percentage: 5 }, { id: "TR-0", percentage: 0 }])))();
      if (url.includes("/contacts")) return (handlers.contactQuery ?? (() => items([])))();
      if (url.includes("/sales_invoices")) return (handlers.invoiceQuery ?? (() => items([])))();
      return items([]);
    }
    if (url.includes("/contacts")) return (handlers.contactCreate ?? (() => jsonResponse({ id: "C-9" })))();
    if (url.includes("/sales_invoices")) return (handlers.invoiceCreate ?? (() => jsonResponse({ id: "SI-11" })))();
    if (url.includes("/contact_payments")) return (handlers.paymentCreate ?? (() => jsonResponse({ id: "CP-22" })))();
    return jsonResponse({}, 500);
  });
}

// ---------------------------------------------------------------------------
// PURE PAYLOAD BUILDERS
// ---------------------------------------------------------------------------

describe("Sage provider-payloads (pure)", () => {
  it("sales_invoice body: contact_id + ledger + reference + per-line tax_rate_id", () => {
    const body = buildSageInvoiceBody(INVOICE_ROW, {
      contactId: "C-1",
      ledgerAccountId: "LA-1",
      taxRateId: "TR-20",
    }).sales_invoice as Record<string, unknown>;
    expect(body.contact_id).toBe("C-1");
    expect(body.reference).toBe("INV-001");
    expect(body.date).toBe("2026-02-01");
    const line = (body.invoice_lines as Array<Record<string, unknown>>)[0]!;
    expect(line.ledger_account_id).toBe("LA-1");
    expect(line.unit_price).toBe(100);
    expect(line.tax_rate_id).toBe("TR-20");
  });

  it("sales_invoice body: a zero-rate line still NAMES its tax rate id (not out-of-scope)", () => {
    const row: CanonicalAccountingRow = {
      ...INVOICE_ROW,
      net: "80.00",
      vat: "0.00",
      gross: "80.00",
      taxLines: [{ rate: 0, net: "80.00", vat: "0.00" }],
    };
    const body = buildSageInvoiceBody(row, {
      contactId: "C-1",
      ledgerAccountId: "LA-1",
      taxRateByRate: new Map([[0, "TR-0"]]),
    }).sales_invoice as Record<string, unknown>;
    const line = (body.invoice_lines as Array<Record<string, unknown>>)[0]!;
    expect(line.tax_rate_id).toBe("TR-0");
  });

  it("contact_payment body: CUSTOMER_RECEIPT allocated to the invoice, bank account, gross", () => {
    const body = buildSagePaymentBody(PAYMENT_ROW, {
      contactId: "C-1",
      bankAccountId: "BA-1",
      transactionTypeId: "CUSTOMER_RECEIPT",
      invoiceId: "SI-11",
    }).contact_payment as Record<string, unknown>;
    expect(body.transaction_type_id).toBe("CUSTOMER_RECEIPT");
    expect(body.bank_account_id).toBe("BA-1");
    expect(body.total_amount).toBe(120);
    const alloc = (body.allocated_artefacts as Array<Record<string, unknown>>)[0]!;
    expect(alloc.artefact_id).toBe("SI-11");
    expect(alloc.amount).toBe(120);
  });

  it("sageSalesTaxRatePercentage returns the whole percent and throws on an unknown rate", () => {
    expect(sageSalesTaxRatePercentage(20)).toBe(20);
    expect(sageSalesTaxRatePercentage(5)).toBe(5);
    expect(sageSalesTaxRatePercentage(0)).toBe(0);
    expect(() => sageSalesTaxRatePercentage(17.5)).toThrow(UnknownVatRateError);
  });
});

// ---------------------------------------------------------------------------
// SAGE ADAPTER — PUSH
// ---------------------------------------------------------------------------

describe("Sage adapter push", () => {
  const baseInput = (over: Partial<AccountingPushInput> = {}): AccountingPushInput => ({
    rows: [INVOICE_ROW],
    accessToken: "ACCESS-1",
    tenantId: "BUSINESS-1", // Sage business id → X-Business header
    realmId: null,
    refresh: vi.fn(async () => null),
    ...over,
  });

  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors when no business id is present", async () => {
    enableSage();
    vi.stubGlobal("fetch", vi.fn());
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput({ tenantId: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/business id/i);
  });

  it("POSTs a sales_invoice with Bearer + X-Business + Idempotency-Key + reference body", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceCreate: () => jsonResponse({ id: "SI-11" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(1);

    const invoiceCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/sales_invoices") && (c[1] as RequestInit).method === "POST",
    )!;
    const url = String(invoiceCall[0]);
    expect(url).toBe("https://api.accounting.sage.com/v3.1/sales_invoices");
    const init = invoiceCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ACCESS-1");
    expect(headers["X-Business"]).toBe("BUSINESS-1");
    expect(headers["Idempotency-Key"]).toMatch(/^crewflow-sage-inv-/);
    const body = JSON.parse(init.body as string);
    expect(body.sales_invoice.reference).toBe("INV-001");
    expect(body.sales_invoice.contact_id).toBe("C-1");
  });

  it("creates the contact when the lookup returns none", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [] }),
      contactCreate: () => jsonResponse({ id: "C-9" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    const created = fetchMock.mock.calls.some(
      (c) => String(c[0]).includes("/contacts") && (c[1] as RequestInit).method === "POST",
    );
    expect(created).toBe(true);
  });

  it("errors clearly when the business has no sales ledger account", async () => {
    enableSage();
    const fetchMock = sageRouter({ ledger: () => jsonResponse({ $items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ledger account/i);
  });

  it("honours a pinned SAGE_SALES_LEDGER_ACCOUNT_ID (no ledger lookup)", async () => {
    enableSage();
    process.env.SAGE_SALES_LEDGER_ACCOUNT_ID = "LA-PINNED";
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    // No GET to /ledger_accounts was made.
    const ledgerLookup = fetchMock.mock.calls.some((c) => String(c[0]).includes("/ledger_accounts"));
    expect(ledgerLookup).toBe(false);
    const invoiceCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/sales_invoices") && (c[1] as RequestInit).method === "POST",
    )!;
    const body = JSON.parse((invoiceCall[1] as RequestInit).body as string);
    expect(body.sales_invoice.invoice_lines[0].ledger_account_id).toBe("LA-PINNED");
  });

  it("401 on the first call → single refresh → retries with the new token", async () => {
    enableSage();
    let firstLedger = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/ledger_accounts")) {
        if (firstLedger) {
          firstLedger = false;
          return jsonResponse({ error: "expired" }, 401);
        }
        return jsonResponse({ $items: [{ id: "LA-1" }] });
      }
      if (method === "GET" && url.includes("/contacts")) {
        return jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] });
      }
      if (method === "GET" && url.includes("/tax_rates")) {
        return jsonResponse({ $items: [{ id: "TR-20", percentage: 20 }] });
      }
      if (method === "POST" && url.includes("/sales_invoices")) {
        return jsonResponse({ id: "SI-11" });
      }
      return jsonResponse({}, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => "ACCESS-2");

    const res = await getAccountingAdapter("sage").pushInvoices(baseInput({ refresh }));
    expect(res.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const invoiceCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/sales_invoices"))!;
    expect(((invoiceCall[1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      "Bearer ACCESS-2",
    );
  });

  it("401 with refresh returning null → error, NO retry beyond the refresh attempt", async () => {
    enableSage();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => null);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput({ refresh }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("maps a TRANSIENT (5xx) invoice create failure to an error result", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceCreate: () => jsonResponse({}, 500),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/500/);
  });

  it("empty rows ⇒ no network call, ok pushed 0", async () => {
    enableSage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput({ rows: [] }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves per-rate tax_rate_id and posts each line gross-correct across 20/5/0", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // The production push path always carries per-rate taxLines (bucketed by
    // buildAccountingExport), so a zero-rated line NAMES its 0% rate id (TR-0)
    // rather than posting out-of-scope.
    const rows: CanonicalAccountingRow[] = [
      { ...INVOICE_ROW, invoice_number: "INV-20", net: "100.00", vat: "20.00", gross: "120.00", taxLines: [{ rate: 20, net: "100.00", vat: "20.00" }] },
      { ...INVOICE_ROW, invoice_number: "INV-05", net: "100.00", vat: "5.00", gross: "105.00", taxLines: [{ rate: 5, net: "100.00", vat: "5.00" }] },
      { ...INVOICE_ROW, invoice_number: "INV-00", net: "100.00", vat: "0.00", gross: "100.00", taxLines: [{ rate: 0, net: "100.00", vat: "0.00" }] },
    ];
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput({ rows }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(3);

    const bodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes("/sales_invoices") && (c[1] as RequestInit).method === "POST")
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies).toHaveLength(3);
    const expectedRate: Record<string, string> = { "INV-20": "TR-20", "INV-05": "TR-5", "INV-00": "TR-0" };
    for (const b of bodies) {
      const line = b.sales_invoice.invoice_lines[0];
      // A VAT-bearing line names its resolved rate id; a zero-rated line names TR-0.
      expect(line.tax_rate_id).toBe(expectedRate[b.sales_invoice.reference]);
    }
  });

  it("errors clearly when a VAT-bearing invoice has no matching Sage tax rate", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      taxRates: () => jsonResponse({ $items: [{ id: "TR-5", percentage: 5 }] }), // no 20%
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/tax rate/i);
  });

  it("payment: allocates to the invoice found by reference", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceQuery: () => jsonResponse({ $items: [{ id: "SI-11", reference: "INV-001" }] }),
      paymentCreate: () => jsonResponse({ id: "CP-22" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("sage").pushPayments(baseInput({ rows: [PAYMENT_ROW] }));
    expect(res.ok).toBe(true);
    const payCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/contact_payments"))!;
    const body = JSON.parse((payCall[1] as RequestInit).body as string);
    expect(body.contact_payment.allocated_artefacts[0].artefact_id).toBe("SI-11");
  });

  it("payment whose invoice lookup 5xxs is NOT posted (pushed 0, no /contact_payments POST)", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceQuery: () => jsonResponse({}, 503),
      paymentCreate: () => jsonResponse({ id: "CP-22" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushPayments(baseInput({ rows: [PAYMENT_ROW] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.pushed).toBe(0);
    const posted = fetchMock.mock.calls.some(
      (c) => String(c[0]).includes("/contact_payments") && (c[1] as RequestInit).method === "POST",
    );
    expect(posted).toBe(false);
  });

  it("payment whose invoice lookup returns EMPTY is NOT posted unallocated", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceQuery: () => jsonResponse({ $items: [] }),
      paymentCreate: () => jsonResponse({ id: "CP-22" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("sage").pushPayments(baseInput({ rows: [PAYMENT_ROW] }));
    expect(res.ok).toBe(false);
    const posted = fetchMock.mock.calls.some(
      (c) => String(c[0]).includes("/contact_payments") && (c[1] as RequestInit).method === "POST",
    );
    expect(posted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SAGE PER-ENTITY IDEMPOTENCY (stable, row-id-seeded)
// ---------------------------------------------------------------------------

describe("Sage per-entity idempotency (Idempotency-Key seeded by row id)", () => {
  const withId = (row: CanonicalAccountingRow, sourceId: string): CanonicalAccountingRow => ({
    ...row,
    sourceId,
  });
  const base = (rows: CanonicalAccountingRow[]): AccountingPushInput => ({
    rows,
    accessToken: "ACCESS-1",
    tenantId: "BUSINESS-1",
    realmId: null,
    refresh: vi.fn(async () => null),
  });
  const keysFor = (fetchMock: ReturnType<typeof vi.fn>, endpoint: string): string[] =>
    fetchMock.mock.calls
      .filter((c) => String(c[0]).includes(endpoint) && (c[1] as RequestInit)?.method === "POST")
      .map((c) => ((c[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"] ?? "");

  it("each invoice is its OWN POST with a DISTINCT per-entity key", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const A = withId({ ...INVOICE_ROW, invoice_number: "INV-A" }, "inv-A");
    const B = withId({ ...INVOICE_ROW, invoice_number: "INV-B" }, "inv-B");
    const res = await getAccountingAdapter("sage").pushInvoices(base([A, B]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(2);
    const keys = keysFor(fetchMock, "/sales_invoices");
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("two IDENTICAL-body payments with DIFFERENT sourceIds get DISTINCT keys and BOTH create", async () => {
    enableSage();
    const fetchMock = sageRouter({
      contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }),
      invoiceQuery: () => jsonResponse({ $items: [{ id: "SI-11", reference: "INV-001" }] }),
      paymentCreate: () => jsonResponse({ id: "CP-22" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const P1 = withId(PAYMENT_ROW, "pay-1");
    const P2 = withId(PAYMENT_ROW, "pay-2");
    const res = await getAccountingAdapter("sage").pushPayments(base([P1, P2]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(2);

    const payPosts = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("/contact_payments") && (c[1] as RequestInit).method === "POST",
    );
    expect(payPosts).toHaveLength(2);
    // Byte-identical bodies (same customer/day/amount/invoice)…
    expect((payPosts[0]![1] as RequestInit).body).toBe((payPosts[1]![1] as RequestInit).body);
    // …but DISTINCT idempotency keys, so neither is dropped as a replay of the other.
    const keys = keysFor(fetchMock, "/contact_payments");
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("the SAME invoice re-pushed yields the IDENTICAL key, even when a later batch adds a second row", async () => {
    enableSage();
    const A = withId({ ...INVOICE_ROW, invoice_number: "INV-A" }, "inv-A");
    const B = withId({ ...INVOICE_ROW, invoice_number: "INV-B" }, "inv-B");
    const router = () => sageRouter({ contactQuery: () => jsonResponse({ $items: [{ id: "C-1", name: "Acme Ltd" }] }) });

    const fetch1 = router();
    vi.stubGlobal("fetch", fetch1);
    await getAccountingAdapter("sage").pushInvoices(base([A]));
    const keyFirst = keysFor(fetch1, "/sales_invoices")[0];

    const fetch2 = router();
    vi.stubGlobal("fetch", fetch2);
    await getAccountingAdapter("sage").pushInvoices(base([A, B]));
    const keyForAOnSecondSync = keysFor(fetch2, "/sales_invoices")[0];
    expect(keyForAOnSecondSync).toBe(keyFirst);
  });
});

// ---------------------------------------------------------------------------
// SAGE ADAPTER — PULL (import) mapping
// ---------------------------------------------------------------------------

describe("Sage adapter pull (import)", () => {
  const pullInput = (): AccountingPullInput => ({
    accessToken: "ACCESS-1",
    tenantId: "BUSINESS-1",
    realmId: null,
    refresh: vi.fn(async () => null),
  });

  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("sage").pullContacts(pullInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps contacts from $items and pages until a short page", async () => {
    enableSage();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        $items: [
          {
            id: "C-1",
            name: "Acme Ltd",
            email: "ap@acme.test",
            telephone: "0123",
            main_address: { address_line_1: "1 High St", city: "Leeds", postal_code: "LS1 1AA" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("sage").pullContacts(pullInput());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toEqual({
        sourceId: "C-1",
        name: "Acme Ltd",
        email: "ap@acme.test",
        phone: "0123",
        addressLine1: "1 High St",
        city: "Leeds",
        postcode: "LS1 1AA",
      });
    }
    // One short page ⇒ exactly one GET (the X-Business header is sent).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Business"]).toBe("BUSINESS-1");
  });

  it("maps sales invoices with net/vat/gross + a derived status", async () => {
    enableSage();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        $items: [
          {
            id: "SI-1",
            invoice_number: "INV-001",
            contact: { displayed_as: "Acme Ltd" },
            net_amount: 100,
            tax_amount: 20,
            total_amount: 120,
            outstanding_amount: 0,
            date: "2026-02-01",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("sage").pullInvoices(pullInput());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0]).toEqual({
        sourceId: "SI-1",
        number: "INV-001",
        customerName: "Acme Ltd",
        net: "100.00",
        vat: "20.00",
        gross: "120.00",
        status: "paid", // outstanding 0 ⇒ paid
        date: "2026-02-01",
      });
    }
  });

  it("a transport error on a pull page aborts LOUDLY (never a silent partial)", async () => {
    enableSage();
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("sage").pullInvoices(pullInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// SAGE OAUTH — refresh + business-id resolution (activated gate)
// ---------------------------------------------------------------------------

describe("Sage OAuth follow-ups", () => {
  it("resolveSageBusinessId returns the first business id from GET /businesses", async () => {
    enableSage();
    const fetchMock = vi.fn(async () => jsonResponse({ $items: [{ id: "BUSINESS-9" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await resolveSageBusinessId("ACCESS-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tenantId).toBe("BUSINESS-9");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.accounting.sage.com/v3.1/businesses");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ACCESS-1");
  });

  it("resolveSageBusinessId errors when no business is returned", async () => {
    enableSage();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ $items: [] })));
    const res = await resolveSageBusinessId("ACCESS-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });

  it("refreshAccessToken POSTs to the Sage token endpoint and returns fresh tokens", async () => {
    enableSage();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "NEW", refresh_token: "ROT", expires_in: 1800 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await refreshAccessToken({ provider: "sage", refreshToken: "OLD" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.accessToken).toBe("NEW");
      expect(res.tokens.refreshToken).toBe("ROT");
    }
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe("https://oauth.accounting.sage.com/token");
  });
});
