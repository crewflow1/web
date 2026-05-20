import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the manual "Send reminder now" path.
 *
 * Two surfaces:
 *  - lib/email/templates/reminders.tsx → buildInvoiceReminder
 *    Verifies the optional note renders at the top of the HTML body
 *    without replacing the default stage tone.
 *  - POST /api/invoices/[id]/remind
 *    Verifies recipient routing (override > customer.email > 400),
 *    that messages reach the helper, and duplicate-protection is
 *    preserved (stop-on-paid via 409).
 */

// -- Template-level tests (no mocking needed) ----------------------------
import {
  buildInvoiceReminder,
  type InvoiceReminderInput,
} from "@/lib/email/templates/reminders";

const baseInput: InvoiceReminderInput = {
  org_name: "Acme Builders",
  customer_name: "Jane Doe",
  invoice_number: "INV-0007",
  total: 1200,
  due_date: "2026-06-01",
  stage: "manual",
};

describe("buildInvoiceReminder — optional note", () => {
  it("renders the custom note at the top WITHOUT removing the default polite tone", () => {
    const { html, text } = buildInvoiceReminder({
      ...baseInput,
      custom_message: "Hope you're well — just a quick nudge.",
    });
    // Note appears
    expect(html).toContain("Hope you&#39;re well — just a quick nudge.");
    expect(text).toContain("Hope you're well — just a quick nudge.");
    // Default stage tone still present (proves the note prepends, not replaces)
    expect(html).toContain("attached invoice");
    // Note block has the highlighted left border styling — sits ABOVE the tone
    const noteIdx = html.indexOf("Hope you&#39;re well");
    const toneIdx = html.indexOf("attached invoice");
    expect(noteIdx).toBeGreaterThan(0);
    expect(toneIdx).toBeGreaterThan(noteIdx);
  });

  it("omits the note block entirely when no custom_message is given", () => {
    const { html } = buildInvoiceReminder(baseInput);
    expect(html).not.toContain("border-left:3px solid"); // the note block style
  });
});

// -- Endpoint-level tests (mock the helper) ------------------------------

type SendResult =
  | { sent: true; emailId: string; to: string; sent_at: string; new_status: string }
  | { sent: false; reason: string; detail?: string };

const sendInvoiceEmailMock = vi.fn(async (
  _client: unknown,
  _id: string,
  opts: { to?: string; message?: string; kind?: string; reminder_stage?: string },
): Promise<SendResult> => ({
  sent: true,
  emailId: "msg-manual-1",
  to: opts.to ?? "customer@example.com",
  sent_at: "2026-05-20T11:00:00Z",
  new_status: "sent",
}));

vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: sendInvoiceEmailMock,
}));

// Fake supabase client whose .from("invoices") returns a configurable
// invoice row, and whose .from("invoice_reminders").insert resolves.
type InvoiceState = { id: string; status: string; org_id: string } | null;
let currentInvoice: InvoiceState = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (_table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: currentInvoice, error: null });
      chain.insert = () => ({
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  })),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, user: { id: "user-1" } },
  })),
}));

// Imports under test (after mocks)
const { POST } = await import("@/app/api/invoices/[id]/remind/route");

import type { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  // Tests don't exercise the NextRequest-specific bits (cookies, nextUrl,
  // etc.); a plain Request cast is sufficient for the manual-remind route.
  return new Request("https://crewflow.uk/api/invoices/inv-1/remind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "inv-1" });

beforeEach(() => {
  sendInvoiceEmailMock.mockClear();
  currentInvoice = { id: "inv-1", status: "sent", org_id: "org-1" };
});

describe("POST /api/invoices/[id]/remind", () => {
  it("sends to customer email when no override is given", async () => {
    const res = await POST(makeRequest({}), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "inv-1",
      expect.objectContaining({
        to: undefined,
        kind: "reminder",
        reminder_stage: "manual",
      }),
    );
  });

  it("sends to the override email when one is provided", async () => {
    const res = await POST(makeRequest({ to: "qa@crewflow.uk" }), { params });
    expect(res.status).toBe(200);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "inv-1",
      expect.objectContaining({
        to: "qa@crewflow.uk",
        kind: "reminder",
        reminder_stage: "manual",
      }),
    );
  });

  it("forwards the optional note to the helper as `message`", async () => {
    await POST(makeRequest({ message: "Hope you're well — gentle nudge." }), { params });
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      "inv-1",
      expect.objectContaining({
        message: "Hope you're well — gentle nudge.",
        kind: "reminder",
      }),
    );
  });

  it("returns 400 no_recipient when neither override nor customer email is available", async () => {
    sendInvoiceEmailMock.mockImplementationOnce(async () => ({
      sent: false as const,
      reason: "no_recipient" as const,
    }));
    const res = await POST(makeRequest({}), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_recipient");
  });

  it("returns 409 already_paid when invoice.status === 'paid' (stop-on-paid)", async () => {
    currentInvoice = { id: "inv-1", status: "paid", org_id: "org-1" };
    const res = await POST(makeRequest({ to: "qa@crewflow.uk" }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_paid");
    // Helper must NOT be called for paid invoices.
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });
});
