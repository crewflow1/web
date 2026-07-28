import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ACTIVE-ORG GATE on the outward-facing money routes.
 *
 * These are the routes that make something LEAVE the product — an emailed
 * invoice, an emailed quote with a live approve/reject portal link — so they
 * are the worst place for the active-org defect (see
 * __tests__/integration/rls/active-org-finance-scoping.test.ts for the full
 * statement and the DB-level proof).
 *
 * TESTED AT THE SEAM, DELIBERATELY. Email is the one live provider in this
 * codebase, so nothing here may reach a transport. This file uses the mocking
 * idiom already established by __tests__/invoices/manual-reminder.test.ts —
 * `vi.mock("@/lib/email/send-invoice")` — and the central assertion is that
 * the send helper is NEVER CALLED for a foreign invoice. That is a stronger
 * property than checking a status code: it proves the refusal happens before
 * any rendering or sending, not after.
 *
 * Every assertion in the "wrong org" blocks fails against the pre-fix routes,
 * which called the helper unconditionally.
 */

type SendResult =
  | { sent: true; emailId: string; to: string; sent_at: string; new_status: string }
  | { sent: false; reason: string; detail?: string };

const sendInvoiceEmailMock = vi.fn(
  async (): Promise<SendResult> => ({
    sent: true,
    emailId: "msg-gate-1",
    to: "customer@example.com",
    sent_at: "2026-07-28T11:00:00Z",
    new_status: "sent",
  }),
);
const sendQuoteEmailMock = vi.fn(
  async (): Promise<SendResult & { portal_url?: string }> => ({
    sent: true,
    emailId: "msg-gate-2",
    to: "customer@example.com",
    sent_at: "2026-07-28T11:00:00Z",
    new_status: "sent",
    portal_url: "https://crewflow.uk/q/tok",
  }),
);

vi.mock("@/lib/email/send-invoice", () => ({ sendInvoiceEmail: sendInvoiceEmailMock }));
vi.mock("@/lib/email/send-quote", () => ({ sendQuoteEmail: sendQuoteEmailMock }));

/**
 * Fake tenant client. `currentRow` stands in for what RLS would hand back —
 * and RLS DOES hand back another org's row for a multi-org user, which is the
 * whole point. The row's org_id is what the route must check.
 */
type RowState = { id: string; org_id: string; status?: string } | null;
let currentRow: RowState = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (_table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: currentRow, error: null });
      chain.insert = () => ({
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  })),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-active" }, user: { id: "user-1" } },
    user: { id: "user-1", email: "u@example.test" },
  })),
}));

const { POST: invoiceSend } = await import("@/app/api/invoices/[id]/send/route");
const { POST: invoiceRemind } = await import("@/app/api/invoices/[id]/remind/route");
const { POST: quoteSend } = await import("@/app/api/quotes/[id]/send/route");

import type { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new Request("https://crewflow.uk/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "row-1" });

beforeEach(() => {
  sendInvoiceEmailMock.mockClear();
  sendQuoteEmailMock.mockClear();
  currentRow = { id: "row-1", org_id: "org-active", status: "sent" };
});

describe("POST /api/invoices/[id]/send — active-org gate", () => {
  it("REFUSES an invoice belonging to another of the caller's orgs", async () => {
    currentRow = { id: "row-1", org_id: "org-OTHER", status: "sent" };
    const res = await invoiceSend(makeRequest({}), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("does NOT reach the email helper at all for a foreign invoice", async () => {
    // The load-bearing assertion: nothing is rendered, nothing is sent, and
    // the invoice's sent_at/status are never touched.
    currentRow = { id: "row-1", org_id: "org-OTHER", status: "sent" };
    await invoiceSend(makeRequest({ to: "attacker@example.test" }), { params });
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("answers 404 (not 403) so a foreign id is indistinguishable from a missing one", async () => {
    currentRow = null;
    const missing = await invoiceSend(makeRequest({}), { params });
    currentRow = { id: "row-1", org_id: "org-OTHER" };
    const foreign = await invoiceSend(makeRequest({}), { params });
    expect(missing.status).toBe(foreign.status);
    expect(await missing.json()).toEqual(await foreign.json());
  });

  it("still sends normally for the active org's own invoice (no over-scoping)", async () => {
    const res = await invoiceSend(makeRequest({ message: "thanks" }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
  });

  it("passes the active org through to the helper as defence in depth", async () => {
    await invoiceSend(makeRequest({}), { params });
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "row-1",
      expect.objectContaining({ orgId: "org-active" }),
    );
  });
});

describe("POST /api/quotes/[id]/send — active-org gate", () => {
  it("REFUSES a quote belonging to another of the caller's orgs", async () => {
    currentRow = { id: "row-1", org_id: "org-OTHER" };
    const res = await quoteSend(makeRequest({}), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("does NOT reach the email helper — so no portal token is minted either", async () => {
    // sendQuoteEmail allocates quotes.public_token when absent. Reaching it
    // for a foreign quote would mint a live approve/reject credential on
    // another org's commercial document.
    currentRow = { id: "row-1", org_id: "org-OTHER" };
    await quoteSend(makeRequest({}), { params });
    expect(sendQuoteEmailMock).not.toHaveBeenCalled();
  });

  it("still sends normally for the active org's own quote (no over-scoping)", async () => {
    const res = await quoteSend(makeRequest({}), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
    expect(sendQuoteEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "row-1",
      expect.objectContaining({ orgId: "org-active" }),
    );
  });
});

describe("POST /api/invoices/[id]/remind — pre-existing gate must not regress", () => {
  it("still refuses a foreign invoice without calling the helper", async () => {
    currentRow = { id: "row-1", org_id: "org-OTHER", status: "sent" };
    const res = await invoiceRemind(makeRequest({}), { params });
    expect(res.status).toBe(404);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("still stops on paid for the org's own invoice (409, no send)", async () => {
    currentRow = { id: "row-1", org_id: "org-active", status: "paid" };
    const res = await invoiceRemind(makeRequest({}), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_paid");
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("still reminds normally for the org's own unpaid invoice", async () => {
    const res = await invoiceRemind(makeRequest({}), { params });
    expect(res.status).toBe(200);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "row-1",
      expect.objectContaining({ kind: "reminder", orgId: "org-active" }),
    );
  });
});
