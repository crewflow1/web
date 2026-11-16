/* eslint-disable @typescript-eslint/no-explicit-any -- chainable fake Supabase client */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Email quote PDF" (POST /api/quotes/[id]/send → sendQuoteEmail) must obey the same approval
 * gate as "Mark as sent": emailing flips the quote to "sent" and mints the portal link, and a
 * "sent" quote can be accepted online (job + invoice). The page only shows the button for
 * approved / sent / viewed quotes, but the server used to email — and flip — ANY status, so a
 * draft, an unapproved or a rejected price could reach the customer and be accepted.
 */
const sendEmail = vi.fn(async () => ({ sent: true as const, id: "email-1" }));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/env", () => ({ env: { RESEND_API_KEY: "test-key-not-real", NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));
vi.mock("@react-pdf/renderer", () => ({ renderToBuffer: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("@/lib/pdf/quote-pdf", () => ({ QuotePdf: vi.fn(() => null) }));
vi.mock("@/server/services/company-logo", () => ({ resolveOrgLogoSrc: vi.fn(async () => null) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { sendQuoteEmail } = await import("@/lib/email/send-quote");

type Write = { table: string; values: Record<string, unknown> };

function fakeSupabase(status: string) {
  const writes: Write[] = [];
  const quote = {
    id: "q1", number: "Q-0001", status, subtotal: 100, vat_total: 20, total: 120, valid_until: null,
    eot_requested_completion_date: null, eot_agreed_completion_date: null, notes: null, terms: null,
    public_token: null, customer: { name: "Cust", email: "cust@example.test" },
    org: { name: "Org", phone: null, vat_number: null, logo_path: null, logo_url: null, address: null, bank_details: null },
  };
  const chain = (result: unknown, onWrite?: () => void): any => {
    const c: any = {
      select: () => c, eq: () => c, in: () => c, order: () => c, range: () => c,
      maybeSingle: async () => result,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        onWrite?.();
        return Promise.resolve(result).then(res, rej);
      },
    };
    return c;
  };
  const client: any = {
    from(table: string) {
      return {
        select: () => (table === "quotes" ? chain({ data: quote, error: null }) : chain({ data: [], error: null })),
        update: (values: Record<string, unknown>) => chain({ error: null }, () => writes.push({ table, values })),
      };
    },
  };
  return { client, writes };
}

describe("emailing a quote obeys the approval gate", () => {
  beforeEach(() => sendEmail.mockClear());

  for (const status of ["draft", "pending_approval", "rejected", "accepted", "declined", "expired"]) {
    it(`a ${status} quote is refused: nothing emailed, no portal link minted, status untouched`, async () => {
      const { client, writes } = fakeSupabase(status);
      const result = await sendQuoteEmail(client, "q1", { orgId: "org-1" });
      expect(result).toEqual({ sent: false, reason: "not_sendable", detail: status });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
  }

  for (const status of ["approved", "sent", "viewed"]) {
    it(`an ${status} quote is emailed and marked sent`, async () => {
      const { client, writes } = fakeSupabase(status);
      const result = await sendQuoteEmail(client, "q1", { orgId: "org-1" });
      expect(result).toMatchObject({ sent: true, to: "cust@example.test", new_status: "sent" });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(writes.some((w) => w.values.status === "sent")).toBe(true);
    });
  }
});
