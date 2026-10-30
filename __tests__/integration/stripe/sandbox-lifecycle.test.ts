import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import Stripe from "stripe";
import { hasLiveDb, serviceClient } from "../_harness";
import {
  evaluateSandboxGate,
  type SandboxGateDecision,
} from "../../stripe/_sandbox-gate";

/**
 * REAL-SANDBOX Stripe billing lifecycle — runnable the moment a TEST key exists.
 *
 * This is the end-to-end proof that CrewFlow's sales-led billing works against a
 * genuine Stripe: it drives Stripe TEST mode with a TEST CLOCK + TEST CARDS to
 * create a customer, bill the £1,000 setup fee, start the £500/mo subscription,
 * roll the clock forward to bill the next period, fail a payment, and cancel —
 * then feeds each REAL Stripe object through CrewFlow's own `processStripeEvent`
 * webhook handler against a REAL local Postgres, asserting CrewFlow's state
 * transitions (organizations.status / setup_fee_status, billing_invoices,
 * org_subscriptions) at every step.
 *
 * ── HOW IT IS GATED (see __tests__/stripe/_sandbox-gate.ts) ──────────────────
 *   • No STRIPE_SANDBOX_E2E   → SKIPS cleanly (the default; normal CI stays green).
 *   • Enabled, no test key    → FAILS LOUD (misconfiguration, never silent-green).
 *   • Enabled, a LIVE key     → REFUSES (it must never touch real money).
 *   • Enabled + sk_test_/rk_test_ key + a local Postgres → RUNS.
 * The Stripe client is built DIRECTLY from the gated test key — never getStripe()
 * / env.STRIPE_SECRET_KEY — so it is impossible for this suite to transact on the
 * production LIVE restricted key.
 *
 * ── WHAT IT DOES NOT CLAIM ───────────────────────────────────────────────────
 * Stripe has no API to "complete" a hosted Checkout Session headlessly (that is a
 * browser action). So the operator-checkout step CREATES a real Checkout Session
 * (proving price wiring + session creation against Stripe) and then exercises the
 * `checkout.session.completed` HANDLER with that real session object — i.e. it
 * simulates only the user's in-browser payment, nothing else. Every other event
 * (subscription.created/updated/deleted, invoice.paid/payment_failed) is a REAL
 * Stripe object produced by the test clock.
 *
 * apiVersion is pinned to lib/stripe/client.ts's pin so wire shapes match prod.
 */

const API_VERSION = "2025-02-24.acacia" as const;
const GBP = "gbp";
const SETUP_PENCE = 100_000; // £1,000
const SUB_PENCE = 50_000; // £500
const DAY = 86_400;

const gate: SandboxGateDecision = evaluateSandboxGate(process.env);

// ---------------------------------------------------------------------------
// Gate dispatch — skip / fail-loud / refuse / run. Only "run" needs a DB.
// ---------------------------------------------------------------------------

if (gate.action === "skip") {
  describe.skip(`stripe sandbox lifecycle — ${gate.reason}`, () => {
    it("skipped (opt-in)", () => {
      /* inert */
    });
  });
} else if (gate.action === "fail" || gate.action === "refuse") {
  // Explicitly enabled but misconfigured (or a live key) — fail LOUD, no DB needed.
  describe("stripe sandbox lifecycle — misconfigured", () => {
    test(`refuses to run: ${gate.action}`, () => {
      throw new Error(gate.reason);
    });
  });
} else if (!hasLiveDb()) {
  describe("stripe sandbox lifecycle — enabled but no database", () => {
    test("needs a local Postgres too", () => {
      throw new Error(
        "STRIPE_SANDBOX_E2E is set with a valid test key, but no local " +
          "Postgres is configured. Run `supabase start` (the sandbox suite " +
          "asserts CrewFlow's DB state transitions, so it needs both).",
      );
    });
  });
} else {
  runSandboxLifecycle(gate.secretKey);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

function runSandboxLifecycle(secretKey: string): void {
  const stripe = new Stripe(secretKey, { apiVersion: API_VERSION });

  type Db = {
    from: (t: string) => {
      insert: (v: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: Record<string, unknown> | null;
            error: { message: string } | null;
          }>;
        };
      } & Promise<{ error: { message: string } | null }>;
      select: (c: string) => {
        eq: (k: string, v: unknown) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }> & {
          eq: (k: string, v: unknown) => Promise<{
            data: unknown[] | null;
            error: { message: string } | null;
          }>;
          maybeSingle: () => Promise<{
            data: Record<string, unknown> | null;
            error: { message: string } | null;
          }>;
        };
      };
      update: (v: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
      delete: () => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
  const db = (c: unknown): Db => c as unknown as Db;

  const TOKEN = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let evtN = 0;
  const freshEventId = () => `evt_${TOKEN}_${evtN++}`;

  /** Wrap a REAL Stripe object into the Event envelope the handler consumes. */
  const asEvent = (type: string, object: unknown): Stripe.Event =>
    ({
      id: freshEventId(),
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
    }) as unknown as Stripe.Event;

  // Shared lifecycle state (tests run sequentially within the file).
  let processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;
  let orgId = "";
  let clockId = "";
  let customerId = "";
  let subPriceId = "";
  let setupPriceId = "";
  let subscriptionId = "";
  let frozen = Math.floor(Date.now() / 1000);

  const svc = () => db(serviceClient());

  const billingInvoices = async (kind?: string) => {
    const res = await svc()
      .from("billing_invoices")
      .select("id, kind, status, amount_gbp")
      .eq("org_id", orgId);
    const rows = ((res.data ?? []) as Array<{
      kind: string;
      status: string;
      amount_gbp: string;
    }>);
    return kind ? rows.filter((r) => r.kind === kind) : rows;
  };

  const orgRow = async () => {
    const res = await svc()
      .from("organizations")
      .select("id, status, setup_fee_status, stripe_subscription_id, stripe_customer_id")
      .eq("id", orgId)
      .maybeSingle();
    return res.data as Record<string, unknown> | null;
  };

  const orgSubscription = async () => {
    const res = await svc()
      .from("org_subscriptions")
      .select("org_id, status, stripe_subscription_id")
      .eq("org_id", orgId)
      .maybeSingle();
    return res.data as Record<string, unknown> | null;
  };

  /** Poll a test clock until it finishes advancing (status 'ready'). */
  const waitForClock = async (id: string, timeoutMs = 90_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await stripe.testHelpers.testClocks.retrieve(id);
      if (c.status === "ready") return;
      if (c.status === "internal_failure") {
        throw new Error("test clock advance failed (internal_failure)");
      }
      if (Date.now() > deadline) throw new Error("test clock advance timed out");
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };

  describe("stripe sandbox lifecycle (TEST mode + test clock)", () => {
    beforeAll(async () => {
      processStripeEvent = (
        await import("@/server/services/stripe-webhook-handler")
      ).processStripeEvent;

      // Local org fixture.
      const org = await svc()
        .from("organizations")
        .insert({ name: "Sandbox Lifecycle Org", slug: `${TOKEN}-org` })
        .select("id")
        .single();
      expect(org.error, org.error?.message).toBeNull();
      orgId = org.data?.id as string;

      // Stripe products + prices (ephemeral; carry CrewFlow's canonical
      // lookup_keys so the price resolver could also find them in test mode).
      const setupProduct = await stripe.products.create({
        name: `[sbx] CrewFlow Setup Fee ${TOKEN}`,
      });
      const setupPrice = await stripe.prices.create({
        product: setupProduct.id,
        currency: GBP,
        unit_amount: SETUP_PENCE,
      });
      setupPriceId = setupPrice.id;

      const subProduct = await stripe.products.create({
        name: `[sbx] CrewFlow Subscription ${TOKEN}`,
      });
      const subPrice = await stripe.prices.create({
        product: subProduct.id,
        currency: GBP,
        unit_amount: SUB_PENCE,
        recurring: { interval: "month" },
        lookup_key: `crewflow_plan_pro_monthly_${TOKEN}`,
      });
      subPriceId = subPrice.id;

      // Test clock + customer on it, with a working test card as default PM.
      const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen });
      clockId = clock.id;
      const customer = await stripe.customers.create({
        name: "Sandbox Lifecycle Ltd",
        email: `${TOKEN}@example.com`,
        test_clock: clockId,
        metadata: { org_id: orgId },
      });
      customerId = customer.id;
      const pm = await stripe.paymentMethods.create({
        type: "card",
        card: { token: "tok_visa" },
      });
      await stripe.paymentMethods.attach(pm.id, { customer: customerId });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pm.id },
      });

      // Link the Stripe customer to the org (the webhook also does this, but the
      // customer-keyed events need the mapping to resolve the org).
      await svc()
        .from("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", orgId);
    }, 120_000);

    afterAll(async () => {
      // Deleting the test clock removes its customers + subscriptions in test mode.
      if (clockId) {
        try {
          await stripe.testHelpers.testClocks.del(clockId);
        } catch {
          /* best-effort */
        }
      }
      if (orgId) {
        await svc().from("billing_invoices").delete().eq("org_id", orgId);
        await svc().from("billing_events").delete().eq("org_id", orgId);
        await svc().from("org_subscriptions").delete().eq("org_id", orgId);
        await svc().from("organizations").delete().eq("id", orgId);
      }
    }, 60_000);

    // -------------------------------------------------------------------
    // 1. Operator checkout wiring (real session) + setup-fee activation
    // -------------------------------------------------------------------

    it("creates a REAL £1,000 setup-fee Checkout Session (price wiring works)", async () => {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: setupPriceId, quantity: 1 }],
        metadata: { org_id: orgId, kind: "setup_fee" },
        success_url: "https://crewflow.uk/admin/customers/x?stripe=success",
        cancel_url: "https://crewflow.uk/admin/customers/x?stripe=cancelled",
      });
      expect(session.url).toBeTruthy();
      expect(session.amount_total).toBe(SETUP_PENCE);
      expect(session.mode).toBe("payment");
    });

    it("the setup-fee invoice is really charged, and the handler marks it paid", async () => {
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: SETUP_PENCE,
        currency: GBP,
        description: "CrewFlow setup fee (sandbox)",
      });
      let inv = await stripe.invoices.create({ customer: customerId, auto_advance: false });
      inv = await stripe.invoices.finalizeInvoice(inv.id);
      inv = await stripe.invoices.pay(inv.id);
      expect(inv.status).toBe("paid");

      const res = await processStripeEvent(asEvent("invoice.paid", inv));
      expect(res.status).toBe("processed");

      const setupInvoices = await billingInvoices("setup_fee");
      expect(setupInvoices.length).toBeGreaterThanOrEqual(1);
      expect(
        setupInvoices.some((r) => r.status === "paid" && r.amount_gbp === "1000.00"),
      ).toBe(true);
    }, 60_000);

    it("the operator checkout.session.completed handler flips setup_fee_status=paid", async () => {
      // Real session object; only the "customer paid in the browser" transition
      // is simulated (Stripe has no headless complete-session API).
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: setupPriceId, quantity: 1 }],
        metadata: { org_id: orgId, kind: "setup_fee" },
        success_url: "https://crewflow.uk/x",
        cancel_url: "https://crewflow.uk/y",
      });
      const res = await processStripeEvent(asEvent("checkout.session.completed", session));
      expect(res.status).toBe("processed");
      expect((await orgRow())?.setup_fee_status).toBe("paid");
    }, 60_000);

    // -------------------------------------------------------------------
    // 2. Subscription start → org active + projection
    // -------------------------------------------------------------------

    it("starts the £500/mo subscription and the handler activates the org", async () => {
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: subPriceId }],
        metadata: { org_id: orgId },
      });
      subscriptionId = sub.id;
      expect(["active", "trialing"]).toContain(sub.status);

      const res = await processStripeEvent(asEvent("customer.subscription.created", sub));
      expect(res.status).toBe("processed");

      const org = await orgRow();
      expect(org?.status).toBe("active");
      expect(org?.stripe_subscription_id).toBe(subscriptionId);

      // org_subscriptions projection (written even while self-serve is dark).
      const proj = await orgSubscription();
      expect(proj?.stripe_subscription_id).toBe(subscriptionId);
      expect(["active", "trialing"]).toContain(proj?.status as string);
    }, 90_000);

    it("records the first subscription invoice as paid (£500)", async () => {
      const list = await stripe.invoices.list({ customer: customerId, limit: 5 });
      const subInvoice = list.data.find(
        (i) => i.amount_paid === SUB_PENCE && i.status === "paid",
      );
      expect(subInvoice, "expected a paid £500 subscription invoice").toBeTruthy();

      const res = await processStripeEvent(asEvent("invoice.paid", subInvoice!));
      expect(res.status).toBe("processed");

      const subInvoices = await billingInvoices("subscription");
      expect(subInvoices.some((r) => r.status === "paid" && r.amount_gbp === "500.00")).toBe(
        true,
      );
    }, 60_000);

    // -------------------------------------------------------------------
    // 3. Advance the clock → next billing period
    // -------------------------------------------------------------------

    it("advances the test clock one month and bills the next period", async () => {
      frozen = frozen + 35 * DAY;
      await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozen });
      await waitForClock(clockId);

      const list = await stripe.invoices.list({ customer: customerId, limit: 10 });
      const paidSubInvoices = list.data.filter(
        (i) => i.amount_paid === SUB_PENCE && i.status === "paid",
      );
      // Two subscription invoices now exist (period 1 + period 2).
      expect(paidSubInvoices.length).toBeGreaterThanOrEqual(2);

      for (const inv of paidSubInvoices) {
        const res = await processStripeEvent(asEvent("invoice.paid", inv));
        expect(["processed", "duplicate"]).toContain(res.status);
      }
      // billing_invoices de-dupes by stripe_invoice_id at the DB; the org stays active.
      expect((await orgRow())?.status).toBe("active");
    }, 120_000);

    // -------------------------------------------------------------------
    // 4. Cancellation — recorded, NOT an automatic org suspension
    // -------------------------------------------------------------------

    it("cancels the subscription; the handler records it but does NOT auto-cancel the org", async () => {
      const cancelled = await stripe.subscriptions.cancel(subscriptionId);
      expect(cancelled.status).toBe("canceled");

      const statusBefore = (await orgRow())?.status;
      const res = await processStripeEvent(
        asEvent("customer.subscription.deleted", cancelled),
      );
      expect(res.status).toBe("processed");
      // High-blast-radius decision left to the operator — org status unchanged.
      expect((await orgRow())?.status).toBe(statusBefore);
    }, 60_000);

    // -------------------------------------------------------------------
    // 5. Failed payment → org suspended (separate customer, failing card)
    // -------------------------------------------------------------------

    it("a failing recurring charge suspends the org via subscription.updated=past_due", async () => {
      const failClock = await stripe.testHelpers.testClocks.create({
        frozen_time: Math.floor(Date.now() / 1000),
      });
      try {
        const failCustomer = await stripe.customers.create({
          name: "Sandbox Dunning Ltd",
          test_clock: failClock.id,
          metadata: { org_id: orgId },
        });
        // Re-point the org at the failing customer for this flow.
        await svc()
          .from("organizations")
          .update({ stripe_customer_id: failCustomer.id })
          .eq("id", orgId);

        const pm = await stripe.paymentMethods.create({
          type: "card",
          card: { token: "tok_chargeCustomerFail" },
        });
        await stripe.paymentMethods.attach(pm.id, { customer: failCustomer.id });
        await stripe.customers.update(failCustomer.id, {
          invoice_settings: { default_payment_method: pm.id },
        });

        const failingSub = await stripe.subscriptions.create({
          customer: failCustomer.id,
          items: [{ price: subPriceId }],
          metadata: { org_id: orgId },
          payment_behavior: "allow_incomplete",
        });

        // Advance a month so the renewal invoice attempts (and fails) a charge.
        await stripe.testHelpers.testClocks.advance(failClock.id, {
          frozen_time: Math.floor(Date.now() / 1000) + 35 * DAY,
        });
        await waitForClock(failClock.id);

        const refreshed = await stripe.subscriptions.retrieve(failingSub.id);
        expect(["past_due", "unpaid", "incomplete", "canceled"]).toContain(refreshed.status);

        // Feed the real (now non-active) subscription through the handler.
        const res = await processStripeEvent(
          asEvent("customer.subscription.updated", refreshed),
        );
        expect(res.status).toBe("processed");

        // A non-access-granting status suspends/cancels the org (never leaves active).
        const status = (await orgRow())?.status;
        expect(["suspended", "cancelled"]).toContain(status as string);
      } finally {
        try {
          await stripe.testHelpers.testClocks.del(failClock.id);
        } catch {
          /* best-effort */
        }
      }
    }, 150_000);
  });
}
