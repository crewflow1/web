import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * (1) The cancellation confirmation EMAIL goes through the transactional email
 *     abstraction (lib/email/send.ts → sendEmail). Asserted ON THE ABSTRACTION:
 *     sendEmail is a spy here, so nothing is sent.
 * (2) BILLING HISTORY source selection: Stripe when it can be read, CrewFlow's
 *     own records otherwise — and never an error page because Stripe is down.
 */

const h = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
    RESEND_NOTIFICATIONS_FROM: "CrewFlow Notifications <notify@example.test>",
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => null }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: vi.fn() }));
vi.mock("@/server/services/notifications-service", () => ({ emitNotifications: vi.fn() }));
vi.mock("@/server/services/self-serve-billing", () => ({
  wireSelfServeBillingDeps: vi.fn(),
  syncOrgSubscriptionFromStripe: vi.fn(),
}));

const { sendCancellationConfirmationEmail } = await import(
  "@/server/services/subscription-cancellation"
);
const { loadBillingHistory } = await import("@/server/services/billing-history");
type HistoryDeps = import("@/server/services/billing-history").BillingHistoryDeps;
type Item = import("@/server/services/billing-history").BillingHistoryItem;

beforeEach(() => {
  h.sendEmail.mockReset();
});

describe("cancellation confirmation email — via the email abstraction", () => {
  it("calls sendEmail once, to the owner, from the notifications mailbox, with html + text", async () => {
    h.sendEmail.mockResolvedValue({ sent: true, id: "msg_1" });
    const r = await sendCancellationConfirmationEmail({
      to: "owner@example.test",
      orgName: "Acme Builders",
      hadSubscription: true,
    });
    expect(r).toEqual({ sent: true });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const arg = h.sendEmail.mock.calls[0]![0];
    expect(arg.to).toBe("owner@example.test");
    expect(arg.from).toBe("CrewFlow Notifications <notify@example.test>");
    expect(arg.subject).toBe("Your CrewFlow subscription for Acme Builders is cancelled");
    expect(arg.text).toContain("https://app.example.test/account/billing");
    expect(arg.html).toContain("Your subscription is cancelled");
  });

  it("an unsent email (no provider key) is reported, not thrown — cancelling never fails on email", async () => {
    h.sendEmail.mockResolvedValue({ sent: false, reason: "no_key" });
    const r = await sendCancellationConfirmationEmail({
      to: "owner@example.test",
      orgName: "Acme",
      hadSubscription: false,
    });
    expect(r).toEqual({ sent: false, reason: "no_key" });
  });
});

describe("billing history — source selection", () => {
  const stripeItem: Item = {
    id: "in_1",
    number: "CF-0001",
    date: "2026-01-01T00:00:00.000Z",
    status: "paid",
    amount: 500,
    currency: "GBP",
    hostedUrl: "https://invoice.stripe.test/i/in_1",
    pdfUrl: "https://invoice.stripe.test/i/in_1/pdf",
  };
  const recordItem: Item = { ...stripeItem, id: "rec_1", number: null, hostedUrl: null, pdfUrl: null };

  function deps(over: Partial<HistoryDeps> = {}): HistoryDeps & { stripeCalls: number } {
    const d = {
      stripeCalls: 0,
      stripeAvailable: () => true,
      loadStripeCustomerId: async () => "cus_1" as string | null,
      listStripeInvoices: async () => {
        d.stripeCalls++;
        return [stripeItem];
      },
      listRecordedInvoices: async () => [recordItem],
      ...over,
    };
    return d;
  }

  it("Stripe key + customer → Stripe invoices with hosted links", async () => {
    const r = await loadBillingHistory(deps(), "org");
    expect(r).toEqual({ source: "stripe", degraded: false, invoices: [stripeItem] });
  });

  it("no Stripe key (local / dark) → CrewFlow records, Stripe never called", async () => {
    const d = deps({ stripeAvailable: () => false });
    const r = await loadBillingHistory(d, "org");
    expect(r).toEqual({ source: "records", degraded: false, invoices: [recordItem] });
    expect(d.stripeCalls).toBe(0);
  });

  it("org has no Stripe customer → records", async () => {
    const d = deps({ loadStripeCustomerId: async () => null });
    const r = await loadBillingHistory(d, "org");
    expect(r.source).toBe("records");
    expect(d.stripeCalls).toBe(0);
  });

  it("Stripe errors (down, or the key lacks Invoices read) → records, flagged degraded — never a thrown page", async () => {
    const r = await loadBillingHistory(
      deps({
        listStripeInvoices: async () => {
          throw new Error("permission_error");
        },
      }),
      "org",
    );
    expect(r).toEqual({ source: "records", degraded: true, invoices: [recordItem] });
  });

  it("is independent of the self-serve-billing flag (it takes no such dependency)", async () => {
    const before = process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING;
    process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = "false";
    try {
      expect((await loadBillingHistory(deps(), "org")).source).toBe("stripe");
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING;
      else process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = before;
    }
  });
});
