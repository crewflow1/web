import { describe, it, expect, vi, afterEach } from "vitest";

import {
  getAccountingAdapter,
  type AccountingPushInput,
} from "@/lib/integrations/accounting/adapters";
import {
  refreshAccessToken,
  resolveXeroTenantId,
} from "@/lib/integrations/accounting/oauth";
import {
  buildXeroInvoicesBody,
  buildXeroPaymentsBody,
  buildQboInvoiceBody,
  buildQboPaymentBody,
} from "@/lib/integrations/accounting/provider-payloads";
import type { CanonicalAccountingRow } from "@/lib/integrations/accounting/canonical";

/**
 * Accounting provider PUSH — hermetic HTTP-mock proofs.
 *
 * Provider HTTP is fully mocked (global `fetch`), so these tests never touch a
 * real Xero / Intuit server. They prove, against the ACTIVATED gate (flag +
 * client credentials set in-test):
 *   - the request SHAPE — endpoint, auth header (Bearer + Xero-tenant-id / QBO
 *     realm path), idempotency key, and body projected from the canonical rows;
 *   - 401 → refresh → retry-once (and refresh-null ⇒ no retry, error);
 *   - Xero tenant-id resolution via GET /connections;
 *   - QBO customer/item resolution + error mapping + idempotency;
 *   - dark-refuse: with the gate off nothing is sent.
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
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET",
  "QBO_CLIENT_ID",
  "QBO_CLIENT_SECRET",
];

function clearGate() {
  for (const k of GATE_KEYS) delete process.env[k];
}

function enableXero() {
  process.env.FEATURE_ACCOUNTING_CONNECT = "1";
  process.env.XERO_CLIENT_ID = "xero-id";
  process.env.XERO_CLIENT_SECRET = "xero-secret";
}

function enableQbo() {
  process.env.FEATURE_ACCOUNTING_CONNECT = "1";
  process.env.QBO_CLIENT_ID = "qbo-id";
  process.env.QBO_CLIENT_SECRET = "qbo-secret";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// PURE PAYLOAD BUILDERS
// ---------------------------------------------------------------------------

describe("provider-payloads (pure)", () => {
  it("Xero invoice body: ACCREC, Contact by name, exclusive net+vat line", () => {
    const body = buildXeroInvoicesBody([INVOICE_ROW]);
    expect(body.Invoices).toHaveLength(1);
    const inv = body.Invoices[0] as Record<string, unknown>;
    expect(inv.Type).toBe("ACCREC");
    expect((inv.Contact as { Name: string }).Name).toBe("Acme Ltd");
    expect(inv.InvoiceNumber).toBe("INV-001");
    expect(inv.LineAmountTypes).toBe("Exclusive");
    const line = (inv.LineItems as Array<Record<string, unknown>>)[0]!;
    expect(line.UnitAmount).toBe(100);
    expect(line.TaxAmount).toBe(20);
  });

  it("Xero payment body: applied to invoice by number, gross amount, bank code", () => {
    const body = buildXeroPaymentsBody([PAYMENT_ROW], "090");
    const pay = body.Payments[0] as Record<string, unknown>;
    expect((pay.Invoice as { InvoiceNumber: string }).InvoiceNumber).toBe("INV-001");
    expect((pay.Account as { Code: string }).Code).toBe("090");
    expect(pay.Amount).toBe(120);
  });

  it("QBO invoice body: CustomerRef + ItemRef + DocNumber + tax", () => {
    const body = buildQboInvoiceBody(INVOICE_ROW, { customerId: "3", itemId: "7" });
    expect(body.DocNumber).toBe("INV-001");
    expect((body.CustomerRef as { value: string }).value).toBe("3");
    const line = (body.Line as Array<Record<string, unknown>>)[0]!;
    expect(line.Amount).toBe(100);
    expect(
      (line.SalesItemLineDetail as { ItemRef: { value: string } }).ItemRef.value,
    ).toBe("7");
    expect((body.TxnTaxDetail as { TotalTax: number }).TotalTax).toBe(20);
  });

  it("QBO payment body: linked when invoiceId present, unlinked otherwise", () => {
    const linked = buildQboPaymentBody(PAYMENT_ROW, { customerId: "3", invoiceId: "11" });
    expect(linked.TotalAmt).toBe(120);
    const line = (linked.Line as Array<Record<string, unknown>>)[0]!;
    expect(
      (line.LinkedTxn as Array<{ TxnId: string; TxnType: string }>)[0],
    ).toEqual({ TxnId: "11", TxnType: "Invoice" });

    const unlinked = buildQboPaymentBody(PAYMENT_ROW, { customerId: "3", invoiceId: null });
    expect(unlinked.Line).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// XERO ADAPTER
// ---------------------------------------------------------------------------

describe("Xero adapter push", () => {
  const baseInput = (over: Partial<AccountingPushInput> = {}): AccountingPushInput => ({
    rows: [INVOICE_ROW],
    accessToken: "ACCESS-1",
    tenantId: "TENANT-1",
    realmId: null,
    refresh: vi.fn(async () => null),
    ...over,
  });

  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("xero").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs Invoices with Bearer + Xero-tenant-id + Idempotency-Key + canonical body", async () => {
    enableXero();
    const fetchMock = vi.fn(async () => jsonResponse({ Invoices: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("xero").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.xero.com/api.xro/2.0/Invoices");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ACCESS-1");
    expect(headers["Xero-tenant-id"]).toBe("TENANT-1");
    expect(headers["Idempotency-Key"]).toMatch(/^crewflow-xero-invoices-/);
    const body = JSON.parse(init.body as string);
    expect(body.Invoices[0].InvoiceNumber).toBe("INV-001");
  });

  it("POSTs Payments to the Payments endpoint with the gross amount", async () => {
    enableXero();
    const fetchMock = vi.fn(async () => jsonResponse({ Payments: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("xero").pushPayments(baseInput({ rows: [PAYMENT_ROW] }));
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.xero.com/api.xro/2.0/Payments");
    const body = JSON.parse(init.body as string);
    expect(body.Payments[0].Amount).toBe(120);
  });

  it("401 → refresh → retry ONCE with the new token", async () => {
    enableXero();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ Invoices: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => "ACCESS-2");

    const res = await getAccountingAdapter("xero").pushInvoices(baseInput({ refresh }));
    expect(res.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const secondHeaders = secondCall[1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer ACCESS-2");
  });

  it("401 with refresh returning null → error, NO retry", async () => {
    enableXero();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => null);

    const res = await getAccountingAdapter("xero").pushInvoices(baseInput({ refresh }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a non-2xx (non-401) provider response to an error result", async () => {
    enableXero();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("xero").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/400/);
  });

  it("empty rows ⇒ no network call, ok pushed 0", async () => {
    enableXero();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("xero").pushInvoices(baseInput({ rows: [] }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// XERO PUSH-ONCE — per-entity, stable idempotency key (the duplicate fix)
// ---------------------------------------------------------------------------

describe("Xero per-entity idempotency (push-once defence-in-depth)", () => {
  const withId = (row: CanonicalAccountingRow, sourceId: string): CanonicalAccountingRow => ({
    ...row,
    sourceId,
  });
  const A = withId({ ...INVOICE_ROW, invoice_number: "INV-A" }, "inv-A");
  const B = withId({ ...INVOICE_ROW, invoice_number: "INV-B" }, "inv-B");

  const base = (rows: CanonicalAccountingRow[]): AccountingPushInput => ({
    rows,
    accessToken: "ACCESS-1",
    tenantId: "TENANT-1",
    realmId: null,
    refresh: vi.fn(async () => null),
  });

  function keysFrom(fetchMock: ReturnType<typeof vi.fn>): Array<string | undefined> {
    return fetchMock.mock.calls.map((c) => {
      const init = (c as unknown as [string, RequestInit])[1];
      return (init.headers as Record<string, string>)["Idempotency-Key"];
    });
  }

  it("pushes EACH invoice as its own POST, each with a distinct per-entity key", async () => {
    enableXero();
    const fetchMock = vi.fn(async () => jsonResponse({ Invoices: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("xero").pushInvoices(base([A, B]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(2);
    // One POST per invoice — NOT a single batch POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = keysFrom(fetchMock);
    expect(keys[0]).not.toBe(keys[1]); // different invoices → different keys
    // Each body carries exactly ONE invoice.
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body.Invoices).toHaveLength(1);
    }
  });

  it("the SAME invoice re-pushed yields the IDENTICAL key (a Xero no-op, no duplicate)", async () => {
    enableXero();
    const fetch1 = vi.fn(async () => jsonResponse({ Invoices: [] }, 200));
    vi.stubGlobal("fetch", fetch1);
    await getAccountingAdapter("xero").pushInvoices(base([A]));
    const keyFirst = keysFrom(fetch1)[0];

    // A LATER sync whose batch also contains B must NOT change A's key — this is
    // exactly the batch-hash bug: the key is seeded by the row id, not the body.
    const fetch2 = vi.fn(async () => jsonResponse({ Invoices: [] }, 200));
    vi.stubGlobal("fetch", fetch2);
    await getAccountingAdapter("xero").pushInvoices(base([A, B]));
    const keyForAOnSecondSync = keysFrom(fetch2)[0];

    expect(keyForAOnSecondSync).toBe(keyFirst);
  });

  it("reports the ACCEPTED PREFIX count when a mid-batch row fails", async () => {
    enableXero();
    // First invoice 200, second 400 → accepted prefix is 1.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Invoices: [] }, 200))
      .mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("xero").pushInvoices(base([A, B]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.pushed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// XERO TENANT RESOLUTION + REFRESH ENDPOINT
// ---------------------------------------------------------------------------

describe("Xero tenant-id resolution", () => {
  it("resolves the ORGANISATION tenant from GET /connections", async () => {
    enableXero();
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { tenantId: "t-1", tenantType: "PRACTICEMANAGER" },
        { tenantId: "t-2", tenantType: "ORGANISATION" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await resolveXeroTenantId("ACCESS-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tenantId).toBe("t-2");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.xero.com/connections");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ACCESS-1");
  });

  it("errors when no tenant is returned", async () => {
    enableXero();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const res = await resolveXeroTenantId("ACCESS-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });
});

describe("refreshAccessToken (token endpoint)", () => {
  it("POSTs grant_type=refresh_token with Basic auth and returns fresh tokens", async () => {
    enableXero();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "NEW", refresh_token: "ROT", expires_in: 1800 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await refreshAccessToken({ provider: "xero", refreshToken: "OLD" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.accessToken).toBe("NEW");
      expect(res.tokens.refreshToken).toBe("ROT");
      expect(res.tokens.expiresAt).not.toBeNull();
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://identity.xero.com/connect/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(init.body as string).toContain("grant_type=refresh_token");
  });

  it("maps a failed refresh to an error result", async () => {
    enableQbo();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));
    const res = await refreshAccessToken({ provider: "quickbooks", refreshToken: "OLD" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// QUICKBOOKS ADAPTER
// ---------------------------------------------------------------------------

/** Route a QBO request to the right canned response by URL + query. */
function qboRouter(
  handlers: {
    itemQuery?: () => Response;
    customerQuery?: () => Response;
    customerCreate?: () => Response;
    invoiceQuery?: () => Response;
    invoiceCreate?: () => Response;
    paymentCreate?: () => Response;
  },
) {
  const empty = () => jsonResponse({ QueryResponse: {} });
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/query")) {
      if (url.includes("Item")) return (handlers.itemQuery ?? empty)();
      if (url.includes("Customer")) return (handlers.customerQuery ?? empty)();
      if (url.includes("Invoice")) return (handlers.invoiceQuery ?? empty)();
      return empty();
    }
    if (method === "POST" && url.includes("/customer")) {
      return (handlers.customerCreate ?? (() => jsonResponse({ Customer: { Id: "99" } })))();
    }
    if (method === "POST" && url.includes("/invoice")) {
      return (handlers.invoiceCreate ?? (() => jsonResponse({ Invoice: { Id: "11" } })))();
    }
    if (method === "POST" && url.includes("/payment")) {
      return (handlers.paymentCreate ?? (() => jsonResponse({ Payment: { Id: "22" } })))();
    }
    return jsonResponse({}, 500);
  });
}

describe("QuickBooks adapter push", () => {
  const baseInput = (over: Partial<AccountingPushInput> = {}): AccountingPushInput => ({
    rows: [INVOICE_ROW],
    accessToken: "ACCESS-1",
    tenantId: null,
    realmId: "REALM-1",
    refresh: vi.fn(async () => null),
    ...over,
  });

  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors when no realm id is present", async () => {
    enableQbo();
    vi.stubGlobal("fetch", vi.fn());
    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput({ realmId: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/realm id/i);
  });

  it("resolves item + existing customer, POSTs invoice to the realm with requestid", async () => {
    enableQbo();
    const fetchMock = qboRouter({
      itemQuery: () => jsonResponse({ QueryResponse: { Item: [{ Id: "7" }] } }),
      customerQuery: () => jsonResponse({ QueryResponse: { Customer: [{ Id: "3" }] } }),
      invoiceCreate: () => jsonResponse({ Invoice: { Id: "11" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pushed).toBe(1);

    const invoiceCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/invoice") && (c[1] as RequestInit).method === "POST",
    )!;
    const url = String(invoiceCall[0]);
    expect(url).toContain("/v3/company/REALM-1/invoice");
    expect(url).toContain("requestid=");
    const init = invoiceCall[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ACCESS-1");
    const body = JSON.parse(init.body as string);
    expect(body.CustomerRef.value).toBe("3");
    expect(body.Line[0].SalesItemLineDetail.ItemRef.value).toBe("7");
  });

  it("creates the customer when the lookup returns none", async () => {
    enableQbo();
    const fetchMock = qboRouter({
      itemQuery: () => jsonResponse({ QueryResponse: { Item: [{ Id: "7" }] } }),
      customerQuery: () => jsonResponse({ QueryResponse: {} }),
      customerCreate: () => jsonResponse({ Customer: { Id: "9" } }),
      invoiceCreate: () => jsonResponse({ Invoice: { Id: "11" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput());
    expect(res.ok).toBe(true);
    const created = fetchMock.mock.calls.some(
      (c) => String(c[0]).includes("/customer") && (c[1] as RequestInit).method === "POST",
    );
    expect(created).toBe(true);
  });

  it("errors clearly when the company has no Service item", async () => {
    enableQbo();
    const fetchMock = qboRouter({
      itemQuery: () => jsonResponse({ QueryResponse: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/Service item/i);
  });

  it("401 on the first call → single refresh → retries with the new token", async () => {
    enableQbo();
    let firstItemCall = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("Item")) {
        if (firstItemCall) {
          firstItemCall = false;
          return jsonResponse({ error: "expired" }, 401);
        }
        return jsonResponse({ QueryResponse: { Item: [{ Id: "7" }] } });
      }
      if (method === "GET" && url.includes("Customer")) {
        return jsonResponse({ QueryResponse: { Customer: [{ Id: "3" }] } });
      }
      if (method === "POST" && url.includes("/invoice")) {
        return jsonResponse({ Invoice: { Id: "11" } });
      }
      return jsonResponse({}, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => "ACCESS-2");

    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput({ refresh }));
    expect(res.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Every call after the refresh uses the new token.
    const invoiceCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/invoice"))!;
    expect(((invoiceCall[1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      "Bearer ACCESS-2",
    );
  });

  it("maps a failed invoice create to an error result", async () => {
    enableQbo();
    const fetchMock = qboRouter({
      itemQuery: () => jsonResponse({ QueryResponse: { Item: [{ Id: "7" }] } }),
      customerQuery: () => jsonResponse({ QueryResponse: { Customer: [{ Id: "3" }] } }),
      invoiceCreate: () => jsonResponse({ Fault: {} }, 400),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingAdapter("quickbooks").pushInvoices(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/400/);
  });

  it("reports the ACCEPTED PREFIX count when the 2nd invoice fails (push-once)", async () => {
    enableQbo();
    let invPost = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("Item")) {
        return jsonResponse({ QueryResponse: { Item: [{ Id: "7" }] } });
      }
      if (method === "GET" && url.includes("Customer")) {
        return jsonResponse({ QueryResponse: { Customer: [{ Id: "3" }] } });
      }
      if (method === "POST" && url.includes("/invoice")) {
        invPost += 1;
        return invPost === 1
          ? jsonResponse({ Invoice: { Id: "11" } })
          : jsonResponse({ Fault: {} }, 400);
      }
      return jsonResponse({}, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("quickbooks").pushInvoices(
      baseInput({ rows: [INVOICE_ROW, { ...INVOICE_ROW, invoice_number: "INV-002" }] }),
    );
    expect(res.ok).toBe(false);
    // The first invoice was accepted before the second failed.
    if (!res.ok) expect(res.pushed).toBe(1);
  });

  it("payment: links to the invoice found by DocNumber", async () => {
    enableQbo();
    const fetchMock = qboRouter({
      customerQuery: () => jsonResponse({ QueryResponse: { Customer: [{ Id: "3" }] } }),
      invoiceQuery: () => jsonResponse({ QueryResponse: { Invoice: [{ Id: "11" }] } }),
      paymentCreate: () => jsonResponse({ Payment: { Id: "22" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingAdapter("quickbooks").pushPayments(baseInput({ rows: [PAYMENT_ROW] }));
    expect(res.ok).toBe(true);
    const payCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/payment"))!;
    const body = JSON.parse((payCall[1] as RequestInit).body as string);
    expect(body.Line[0].LinkedTxn[0].TxnId).toBe("11");
  });
});
