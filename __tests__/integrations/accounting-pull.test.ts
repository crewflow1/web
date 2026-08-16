import { describe, it, expect, vi, afterEach } from "vitest";

import {
  getAccountingImportAdapter,
  type AccountingPullInput,
} from "@/lib/integrations/accounting/adapters";
import {
  normaliseContact,
  normaliseInvoice,
} from "@/lib/imports/connector-normalise";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { findCustomerDuplicate } from "@/lib/imports/duplicates";

/**
 * Accounting provider PULL (direct-API import connectors) — hermetic HTTP-mock
 * proofs. Provider HTTP is fully mocked (global `fetch`), so these tests never
 * touch a real Xero / Intuit server. They prove, against the ACTIVATED gate:
 *   - REFUSE BEFORE FETCH — with the gate off nothing is pulled, no fetch;
 *   - the request SHAPE — endpoint, Bearer + Xero-tenant-id / QBO realm path;
 *   - F-1 PAGINATION — a full page is followed, a short page ends the walk;
 *   - 401 → refresh → retry-once;
 *   - normalisation → the SAME `mapped` shape the file pipeline commits;
 *   - ORG SCOPING — the request carries ONLY the connection's own tenant/realm.
 */

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

const baseInput = (over: Partial<AccountingPullInput> = {}): AccountingPullInput => ({
  accessToken: "ACCESS-1",
  tenantId: "TENANT-1",
  realmId: "REALM-1",
  refresh: vi.fn(async () => null),
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// XERO
// ---------------------------------------------------------------------------

describe("Xero pull — contacts", () => {
  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs /Contacts with Bearer + Xero-tenant-id and maps fields", async () => {
    enableXero();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        Contacts: [
          {
            ContactID: "c1",
            Name: "Acme Ltd",
            EmailAddress: "ops@acme.test",
            Phones: [
              { PhoneType: "MOBILE", PhoneCountryCode: "44", PhoneAreaCode: "7700", PhoneNumber: "900222" },
            ],
            Addresses: [
              { AddressType: "STREET", AddressLine1: "1 High St", City: "Leeds", PostalCode: "LS1 1AA" },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    const c = res.items[0]!;
    expect(c).toMatchObject({
      sourceId: "c1",
      name: "Acme Ltd",
      email: "ops@acme.test",
      phone: "44 7700 900222",
      addressLine1: "1 High St",
      city: "Leeds",
      postcode: "LS1 1AA",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.xero.com/api.xro/2.0/Contacts");
    expect(url).toContain("page=1");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ACCESS-1");
    // ORG SCOPING — the request names ONLY this connection's tenant.
    expect(headers["Xero-tenant-id"]).toBe("TENANT-1");
  });

  it("F-1 pagination — follows a full page, stops on a short page", async () => {
    enableXero();
    const fullPage = {
      Contacts: Array.from({ length: 100 }, (_, i) => ({ ContactID: `c${i}`, Name: `Cust ${i}` })),
    };
    const shortPage = { Contacts: [{ ContactID: "last", Name: "Last One" }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse(shortPage));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain("page=2");
  });

  it("401 → refresh → retry ONCE with the new token", async () => {
    enableXero();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ Contacts: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => "ACCESS-2");

    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput({ refresh }));
    expect(res.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((second[1].headers as Record<string, string>).authorization).toBe("Bearer ACCESS-2");
  });

  it("a non-2xx response aborts the pull with an error (no silent partial)", async () => {
    enableXero();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "boom" }, 500)));
    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/500/);
  });

  it("no tenant id ⇒ error, no network", async () => {
    enableXero();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput({ tenantId: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Xero pull — invoices", () => {
  it("filters to ACCREC via where= and maps money + status + date", async () => {
    enableXero();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        Invoices: [
          {
            InvoiceID: "i1",
            InvoiceNumber: "INV-100",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { Name: "Acme Ltd" },
            SubTotal: 100,
            TotalTax: 20,
            Total: 120,
            DateString: "2026-02-01T00:00:00",
          },
          // A purchase bill that should be filtered out defensively.
          { InvoiceID: "i2", InvoiceNumber: "BILL-1", Type: "ACCPAY", Total: 50 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("xero").pullInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      sourceId: "i1",
      number: "INV-100",
      customerName: "Acme Ltd",
      net: "100.00",
      vat: "20.00",
      gross: "120.00",
      status: "sent",
      date: "2026-02-01",
    });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(decodeURIComponent(url)).toContain('Type=="ACCREC"');
  });
});

// ---------------------------------------------------------------------------
// QUICKBOOKS
// ---------------------------------------------------------------------------

describe("QuickBooks pull — customers", () => {
  it("dark-refuses (no fetch) when the gate is off", async () => {
    clearGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("quickbooks").pullContacts(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the realm's Customer table (Bearer, realm in path) and maps fields", async () => {
    enableQbo();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        QueryResponse: {
          Customer: [
            {
              Id: "9",
              DisplayName: "Beta Builders",
              PrimaryEmailAddr: { Address: "hi@beta.test" },
              PrimaryPhone: { FreeFormNumber: "0113 555 0100" },
              BillAddr: { Line1: "2 Mill Rd", City: "York", PostalCode: "YO1 2AB" },
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("quickbooks").pullContacts(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]).toMatchObject({
      sourceId: "9",
      name: "Beta Builders",
      email: "hi@beta.test",
      phone: "0113 555 0100",
      addressLine1: "2 Mill Rd",
      city: "York",
      postcode: "YO1 2AB",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // ORG SCOPING — the realm segment is this connection's realm, nobody else's.
    expect(url).toContain("/v3/company/REALM-1/query");
    expect(decodeURIComponent(url)).toContain("select * from Customer startposition 1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ACCESS-1");
  });

  it("F-1 pagination — walks startposition until a short page", async () => {
    enableQbo();
    const fullPage = {
      QueryResponse: {
        Customer: Array.from({ length: 100 }, (_, i) => ({ Id: `${i}`, DisplayName: `C${i}` })),
      },
    };
    const shortPage = { QueryResponse: { Customer: [{ Id: "x", DisplayName: "Tail" }] } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse(shortPage));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("quickbooks").pullContacts(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(101);
    expect(decodeURIComponent((fetchMock.mock.calls[1] as unknown as [string])[0])).toContain(
      "startposition 101",
    );
  });

  it("invoices: net = TotalAmt − TotalTax, status from balance", async () => {
    enableQbo();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        QueryResponse: {
          Invoice: [
            {
              Id: "5",
              DocNumber: "INV-9",
              CustomerRef: { name: "Beta Builders", value: "9" },
              TotalAmt: 120,
              Balance: 0,
              TxnTaxDetail: { TotalTax: 20 },
              TxnDate: "2026-03-04",
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAccountingImportAdapter("quickbooks").pullInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]).toMatchObject({
      sourceId: "5",
      number: "INV-9",
      customerName: "Beta Builders",
      net: "100.00",
      vat: "20.00",
      gross: "120.00",
      status: "paid",
      date: "2026-03-04",
    });
  });

  it("no realm id ⇒ error, no network", async () => {
    enableQbo();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAccountingImportAdapter("quickbooks").pullInvoices(baseInput({ realmId: null }));
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PULL → NORMALISE → INTO THE EXISTING IMPORT PIPELINE
// ---------------------------------------------------------------------------

describe("pull → normalise feeds the existing import pipeline", () => {
  it("a normalised Xero contact matches an existing customer via the SAME dedupe", async () => {
    enableXero();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          Contacts: [{ ContactID: "c1", Name: "Acme Ltd", EmailAddress: "ops@acme.test" }],
        }),
      ),
    );
    const res = await getAccountingImportAdapter("xero").pullContacts(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = normaliseContact("xero", res.items[0]!);
    expect(row.entity_type).toBe("customer");
    expect(row.confidence).toBe(100);
    expect(row.source_ref).toBe("xero:contact:c1");

    // The mapped shape is exactly what the import dedupe reads.
    const dup = findCustomerDuplicate(row.mapped, [
      { id: "existing-1", name: "Acme Limited", email: "ops@acme.test", phone: null },
    ]);
    expect(dup?.target_id).toBe("existing-1");
    expect(dup?.reason).toBe("matching email");
  });

  it("a normalised QBO invoice builds a valid commit-stage invoice payload", async () => {
    enableQbo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          QueryResponse: {
            Invoice: [
              {
                Id: "5",
                DocNumber: "INV-9",
                CustomerRef: { name: "Beta Builders" },
                TotalAmt: 120,
                Balance: 120,
                TxnTaxDetail: { TotalTax: 20 },
                TxnDate: "2026-03-04",
              },
            ],
          },
        }),
      ),
    );
    const res = await getAccountingImportAdapter("quickbooks").pullInvoices(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = normaliseInvoice("quickbooks", res.items[0]!);
    expect(row.entity_type).toBe("invoice");

    // The SAME buildInvoiceImportPlan the file-commit path uses accepts it —
    // total drives the generated column, and the 20% rate is a valid UK rate.
    const plan = buildInvoiceImportPlan(row.mapped, "org-1", "sent");
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.row.number).toBe("INV-9");
    expect(plan.row.amount).toBe(100);
    expect(plan.row.vat_total).toBe(20);
    // `total` must stay ABSENT — it is the generated column the DB owns.
    expect("total" in plan.row).toBe(false);
  });

  it("an incomplete row (nameless contact) parks below the review threshold", async () => {
    const row = normaliseContact("xero", {
      sourceId: "c9",
      name: "",
      email: null,
      phone: null,
      addressLine1: null,
      city: null,
      postcode: null,
    });
    expect(row.confidence).toBeLessThan(50);
    expect(row.warnings.join(" ")).toMatch(/no name/);
  });
});
