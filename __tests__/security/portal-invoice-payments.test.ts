import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  portalPaymentsFeatureEnabled,
  portalPaymentsKeyPresent,
  isPortalPaymentsConfigured,
  getInvoiceStripe,
  _resetInvoiceStripeCache,
} from "@/lib/payments/portal-stripe";
import {
  createInvoiceCheckout,
  settleInvoicePayment,
  poundsToMinor,
  minorToPounds,
  type CreateCheckoutDeps,
  type SettleDeps,
  type IntentRow,
  type InvoiceForPayment,
} from "@/server/services/portal-invoice-payments";

/**
 * P2 PORTAL INVOICE PAYMENTS (20261120) — trust-boundary proofs.
 *
 * Section 1: the feature is DARK. With the flag off and no platform Connect key,
 * nothing is configured; getInvoiceStripe returns null; createInvoiceCheckout
 * REFUSES with no Stripe call.
 *
 * Section 2: settlement is IDEMPOTENT and TENANT-ISOLATED. A redelivered event
 * records the money once; a race is cleaned up; an event on the wrong account or
 * with mismatched metadata records nothing; a foreign PaymentIntent records
 * nothing; the credited org/invoice is the intent's OWN, never the event body's.
 *
 * Section 3: the migration — RLS enabled, member-read / service-role-write, no
 * fake connected state, DB-level idempotency uniques, composite (id,org_id) FKs,
 * and 'stripe' admitted to invoice_payments.source.
 *
 * Section 4: the SaaS-billing Stripe integration is UNTOUCHED — a different route,
 * secret and client; the pay-now UI is dark-gated; no double-count path.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261120000000_portal_invoice_payments.sql";
const WEBHOOK = "app/api/webhooks/stripe-invoice/route.ts";
const SAAS_WEBHOOK = "app/api/webhooks/stripe/route.ts";
const CLIENT = "lib/payments/portal-stripe.ts";
const SERVICE = "server/services/portal-invoice-payments.ts";
const HANDLER = "server/services/portal-invoice-webhook-handler.ts";
const PAGE = "app/customer-portal/[token]/invoices/page.tsx";
const PAY_ACTION = "app/customer-portal/_pay-action.ts";

const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sql = sqlOnly(read(MIG));

const GATE_ENV = ["NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS", "STRIPE_CONNECT_SECRET_KEY"];

// ---------------------------------------------------------------------------
// 1. THE FEATURE IS DARK — no config, no Stripe client, no session, dark
// ---------------------------------------------------------------------------

describe("portal payments are dark without the flag + key", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of GATE_ENV) delete process.env[k];
    _resetInvoiceStripeCache();
  });
  afterEach(() => {
    process.env = { ...original };
    _resetInvoiceStripeCache();
  });

  it("nothing is configured with neither switch set", () => {
    expect(portalPaymentsFeatureEnabled()).toBe(false);
    expect(portalPaymentsKeyPresent()).toBe(false);
    expect(isPortalPaymentsConfigured()).toBe(false);
    expect(getInvoiceStripe()).toBeNull();
  });

  it("the flag alone is NOT configured (two-switch)", () => {
    process.env.NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS = "true";
    expect(isPortalPaymentsConfigured()).toBe(false);
    expect(getInvoiceStripe()).toBeNull();
  });

  it("the key alone is NOT configured (two-switch)", () => {
    process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_x";
    _resetInvoiceStripeCache();
    expect(isPortalPaymentsConfigured()).toBe(false);
  });

  it("only BOTH switches configure the feature", () => {
    process.env.NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS = "true";
    process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_x";
    _resetInvoiceStripeCache();
    expect(isPortalPaymentsConfigured()).toBe(true);
    expect(getInvoiceStripe()).not.toBeNull();
  });
});

describe("createInvoiceCheckout REFUSES before any Stripe call when dark", () => {
  it("returns feature_disabled and NEVER calls Stripe / loads a connection", async () => {
    let stripeCalled = false;
    let connectionLoaded = false;
    const deps: CreateCheckoutDeps = {
      isConfigured: () => false, // dark
      loadConnection: async () => {
        connectionLoaded = true;
        return null;
      },
      loadInvoice: async () => null,
      stripe: {
        createSession: async () => {
          stripeCalled = true;
          throw new Error("Stripe must not be reached while dark");
        },
      },
      saveIntent: async () => undefined,
    };
    const res = await createInvoiceCheckout(deps, {
      orgId: "o1",
      customerId: "c1",
      invoiceId: "i1",
      appUrl: "https://app.example",
      token: "t",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(stripeCalled).toBe(false);
    // The config guard is FIRST — no connection lookup even happens.
    expect(connectionLoaded).toBe(false);
  });

  it("refuses org_not_connected (no Stripe call) when the org has no account", async () => {
    let stripeCalled = false;
    const deps: CreateCheckoutDeps = {
      isConfigured: () => true,
      loadConnection: async () => null, // configured, but tenant not connected
      loadInvoice: async () => null,
      stripe: {
        createSession: async () => {
          stripeCalled = true;
          throw new Error("unreachable");
        },
      },
      saveIntent: async () => undefined,
    };
    const res = await createInvoiceCheckout(deps, {
      orgId: "o1",
      customerId: "c1",
      invoiceId: "i1",
      appUrl: "https://app.example",
      token: "t",
    });
    expect(res).toEqual({ ok: false, reason: "org_not_connected" });
    expect(stripeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createInvoiceCheckout — ownership + balance guards, happy path
// ---------------------------------------------------------------------------

function connectedOrg(orgId = "o1") {
  return {
    org_id: orgId,
    status: "connected",
    stripe_account_id: "acct_123",
    default_currency: "gbp",
  };
}
function invoiceOf(overrides: Partial<InvoiceForPayment> = {}): InvoiceForPayment {
  return {
    id: "inv1",
    org_id: "o1",
    number: "INV-0001",
    total: 100,
    status: "sent",
    customer_id: "c1",
    quote: null,
    ...overrides,
  };
}

describe("createInvoiceCheckout ownership + balance guards", () => {
  const base = (over: Partial<CreateCheckoutDeps> = {}): CreateCheckoutDeps => ({
    isConfigured: () => true,
    loadConnection: async () => connectedOrg(),
    loadInvoice: async () => ({ invoice: invoiceOf(), paid: 0 }),
    stripe: {
      createSession: async () => ({
        id: "cs_1",
        url: "https://checkout.stripe/cs_1",
        paymentIntentId: "pi_1",
      }),
    },
    saveIntent: async () => undefined,
    ...over,
  });
  const input = {
    orgId: "o1",
    customerId: "c1",
    invoiceId: "inv1",
    appUrl: "https://app.example",
    token: "t",
  };

  it("rejects an invoice belonging to another customer", async () => {
    const res = await createInvoiceCheckout(
      base({ loadInvoice: async () => ({ invoice: invoiceOf({ customer_id: "OTHER" }), paid: 0 }) }),
      input,
    );
    expect(res).toEqual({ ok: false, reason: "not_your_invoice" });
  });

  it("rejects a fully-paid invoice (nothing_due) with no Stripe call", async () => {
    let called = false;
    const res = await createInvoiceCheckout(
      base({
        loadInvoice: async () => ({ invoice: invoiceOf({ total: 100 }), paid: 100 }),
        stripe: { createSession: async () => { called = true; throw new Error("x"); } },
      }),
      input,
    );
    expect(res).toEqual({ ok: false, reason: "nothing_due" });
    expect(called).toBe(false);
  });

  it("mints a session for the OUTSTANDING balance and persists the intent", async () => {
    let sessionArgs: { amountMinor: number; connectedAccountId: string } | null = null;
    let saved: { amount: number; stripeAccountId: string } | null = null;
    const res = await createInvoiceCheckout(
      base({
        loadInvoice: async () => ({ invoice: invoiceOf({ total: 100 }), paid: 40 }),
        stripe: {
          createSession: async (a) => {
            sessionArgs = { amountMinor: a.amountMinor, connectedAccountId: a.connectedAccountId };
            return { id: "cs_1", url: "https://checkout/cs_1", paymentIntentId: "pi_1" };
          },
        },
        saveIntent: async (r) => {
          saved = { amount: r.amount, stripeAccountId: r.stripeAccountId };
        },
      }),
      input,
    );
    expect(res.ok).toBe(true);
    // £60 outstanding → 6000 minor, on the tenant's connected account.
    expect(sessionArgs!.amountMinor).toBe(6000);
    expect(sessionArgs!.connectedAccountId).toBe("acct_123");
    expect(saved!.amount).toBe(60);
    expect(saved!.stripeAccountId).toBe("acct_123");
  });
});

// ---------------------------------------------------------------------------
// 2. settleInvoicePayment — idempotency + tenant isolation
// ---------------------------------------------------------------------------

function makeIntent(over: Partial<IntentRow> = {}): IntentRow {
  return {
    id: "int1",
    org_id: "o1",
    invoice_id: "inv1",
    stripe_account_id: "acct_123",
    stripe_checkout_session_id: "cs_1",
    stripe_payment_intent_id: "pi_1",
    amount: 60,
    currency: "gbp",
    status: "created",
    invoice_payment_id: null,
    ...over,
  };
}

/** An in-memory store that behaves like the DB claim (set-once-while-null). */
function makeStore(intent: IntentRow) {
  const inserted: Array<{ id: string; orgId: string; invoiceId: string; amount: number }> = [];
  let deleted: string[] = [];
  let seq = 0;
  const deps: SettleDeps = {
    findIntent: async ({ sessionId, paymentIntentId }) => {
      if (paymentIntentId && paymentIntentId === intent.stripe_payment_intent_id) return intent;
      if (sessionId && sessionId === intent.stripe_checkout_session_id) return intent;
      return null;
    },
    loadInvoice: async (orgId, invoiceId) =>
      orgId === intent.org_id && invoiceId === intent.invoice_id
        ? { id: invoiceId, org_id: orgId }
        : null,
    insertInvoicePayment: async (row) => {
      const id = `ip_${++seq}`;
      inserted.push({ id, orgId: row.orgId, invoiceId: row.invoiceId, amount: row.amount });
      return { id };
    },
    claimSettlement: async (intentId, invoicePaymentId) => {
      if (intentId !== intent.id) return false;
      if (intent.invoice_payment_id) return false; // already claimed → loser
      intent.invoice_payment_id = invoicePaymentId;
      intent.status = "succeeded";
      return true;
    },
    deleteInvoicePayment: async (id) => {
      deleted.push(id);
    },
  };
  return { deps, inserted, get deleted() { return deleted; } };
}

const settleInput = (over: Record<string, unknown> = {}) => ({
  eventId: "evt_1",
  connectedAccountId: "acct_123",
  paymentIntentId: "pi_1",
  amountReceivedMinor: 6000,
  currency: "gbp",
  metadata: { org_id: "o1", invoice_id: "inv1" },
  paidAt: "2026-08-14",
  ...over,
});

describe("settleInvoicePayment idempotency + isolation", () => {
  it("records the money EXACTLY ONCE across a redelivered event", async () => {
    const store = makeStore(makeIntent());
    const first = await settleInvoicePayment(store.deps, settleInput());
    const second = await settleInvoicePayment(store.deps, settleInput());
    expect(first).toMatchObject({ ok: true, recorded: true });
    expect(second).toMatchObject({ ok: true, recorded: false, reason: "already_recorded" });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.amount).toBe(60);
  });

  it("cleans up the race loser's receipt so a TRUE race counts money once", async () => {
    // Simulate a race: claimSettlement fails (another delivery already claimed),
    // even though the pre-check saw null. The just-inserted receipt is deleted.
    const intent = makeIntent();
    const store = makeStore(intent);
    store.deps.claimSettlement = async () => false; // always lose the claim
    const res = await settleInvoicePayment(store.deps, settleInput());
    expect(res).toMatchObject({ ok: true, recorded: false, reason: "already_recorded" });
    expect(store.inserted).toHaveLength(1); // inserted...
    expect(store.deleted).toEqual([store.inserted[0]!.id]); // ...then rolled back
  });

  it("REFUSES an event on the WRONG connected account (no receipt)", async () => {
    const store = makeStore(makeIntent());
    const res = await settleInvoicePayment(
      store.deps,
      settleInput({ connectedAccountId: "acct_ATTACKER" }),
    );
    expect(res).toEqual({ ok: false, reason: "account_mismatch" });
    expect(store.inserted).toHaveLength(0);
  });

  it("REFUSES an event whose metadata org differs from the intent (no receipt)", async () => {
    const store = makeStore(makeIntent());
    const res = await settleInvoicePayment(
      store.deps,
      settleInput({ metadata: { org_id: "o_ATTACKER", invoice_id: "inv1" } }),
    );
    expect(res).toEqual({ ok: false, reason: "account_mismatch" });
    expect(store.inserted).toHaveLength(0);
  });

  it("REFUSES a foreign PaymentIntent we never created (no receipt)", async () => {
    const store = makeStore(makeIntent());
    const res = await settleInvoicePayment(
      store.deps,
      settleInput({ paymentIntentId: "pi_FOREIGN", sessionId: null }),
    );
    expect(res).toEqual({ ok: false, reason: "unknown_intent" });
    expect(store.inserted).toHaveLength(0);
  });

  it("credits the INTENT's own org + invoice, never the event body's", async () => {
    const store = makeStore(makeIntent({ org_id: "o1", invoice_id: "inv1" }));
    // Metadata omitted → no cross-check to fail, but the receipt still goes to
    // the intent's org/invoice, proving the event body can't redirect the credit.
    await settleInvoicePayment(store.deps, settleInput({ metadata: null }));
    expect(store.inserted[0]).toMatchObject({ orgId: "o1", invoiceId: "inv1" });
  });

  // DELETE-THE-FIX ASSERTION. The idempotency invariant is that a settled intent
  // (invoice_payment_id set) records nothing further. If that guard is removed,
  // the second delivery would insert a SECOND receipt — this test would fail.
  it("[delete-the-fix] a pre-settled intent records nothing", async () => {
    const store = makeStore(makeIntent({ invoice_payment_id: "ip_already" }));
    const res = await settleInvoicePayment(store.deps, settleInput());
    expect(res).toMatchObject({ ok: true, recorded: false, reason: "already_recorded" });
    expect(store.inserted).toHaveLength(0);
  });
});

describe("money conversion is exact", () => {
  it("round-trips pounds↔minor without float drift", () => {
    expect(poundsToMinor(60)).toBe(6000);
    expect(poundsToMinor(19.99)).toBe(1999);
    expect(minorToPounds(1999)).toBe(19.99);
    expect(poundsToMinor(0.1 + 0.2)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 3. THE MIGRATION — RLS, tenancy, idempotency uniques, source widening
// ---------------------------------------------------------------------------

describe("migration 20261120 — RLS + shape", () => {
  it("admits 'stripe' to invoice_payments.source (keeps manual + bank_csv)", () => {
    expect(sql).toMatch(
      /add constraint invoice_payments_source_check[\s\S]*check \(source in \('manual', 'bank_csv', 'stripe'\)\)/i,
    );
  });

  it("org_payment_connections: RLS on, member-read, admin-write", () => {
    expect(sql).toMatch(/alter table public\.org_payment_connections enable row level security/i);
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    expect(sql).toMatch(/create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can update[^;]*for update[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i);
  });

  it("org_payment_connections FORBIDS a fake connected state", () => {
    expect(sql).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or stripe_account_id is not null\s*\)/i,
    );
  });

  it("both tables are org-pinned with cascade + composite (id, org_id) key", () => {
    const both = sql.match(/org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/gi) ?? [];
    expect(both.length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/constraint org_payment_connections_id_org_key unique \(id, org_id\)/i);
    expect(sql).toMatch(/constraint invoice_payment_intents_id_org_key unique \(id, org_id\)/i);
  });

  it("invoice_payment_intents: RLS on, member-READ, NO authenticated write policy (service-role only)", () => {
    expect(sql).toMatch(/alter table public\.invoice_payment_intents enable row level security/i);
    expect(sql).toMatch(
      /create policy[^;]*invoice_payment_intents: members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    // No insert/update/delete policy exists for this table → only service_role writes.
    expect(sql).not.toMatch(/invoice_payment_intents[^;]*for insert/i);
    expect(sql).not.toMatch(/invoice_payment_intents[^;]*for update/i);
    expect(sql).not.toMatch(/invoice_payment_intents[^;]*for delete/i);
  });

  it("intents carry DB-level idempotency uniques (PI, session, and the receipt link)", () => {
    expect(sql).toMatch(/constraint invoice_payment_intents_pi_uniq unique \(stripe_payment_intent_id\)/i);
    expect(sql).toMatch(/constraint invoice_payment_intents_session_uniq unique \(stripe_checkout_session_id\)/i);
    expect(sql).toMatch(/constraint invoice_payment_intents_payment_uniq unique \(invoice_payment_id\)/i);
  });

  it("intents reference invoice + customer by COMPOSITE (id, org_id) FK (no cross-tenant injection)", () => {
    expect(sql).toMatch(
      /foreign key \(invoice_id, org_id\) references public\.invoices\(id, org_id\)/i,
    );
    expect(sql).toMatch(
      /foreign key \(customer_id, org_id\) references public\.customers\(id, org_id\)/i,
    );
  });

  it("writes NOTHING (no seeded rows — dark by default)", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.org_payment_connections/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.invoice_payment_intents/i);
  });
});

// ---------------------------------------------------------------------------
// 4. SEPARATION FROM SAAS BILLING + refuse-before-verify + dark UI
// ---------------------------------------------------------------------------

describe("SaaS billing is untouched + the webhook is dark-gated", () => {
  it("the invoice webhook uses its OWN secret + client, never the SaaS ones", () => {
    const code = codeOf(read(WEBHOOK));
    expect(code).toMatch(/STRIPE_INVOICE_WEBHOOK_SECRET/);
    expect(code).toMatch(/getInvoiceStripe\(/);
    // Never reaches for the SaaS-billing secret or client.
    expect(code).not.toMatch(/STRIPE_WEBHOOK_SECRET\b/);
    expect(code).not.toMatch(/from "@\/lib\/stripe\/client"/);
    expect(code).not.toMatch(/billing_events/);
  });

  it("the SaaS webhook still exists and still uses STRIPE_WEBHOOK_SECRET (untouched)", () => {
    const code = codeOf(read(SAAS_WEBHOOK));
    expect(code).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(code).not.toMatch(/STRIPE_INVOICE_WEBHOOK_SECRET/);
  });

  it("the webhook REFUSES-before-verify: config + secret guards precede constructEvent", () => {
    const code = codeOf(read(WEBHOOK));
    const cfgIdx = code.indexOf("isPortalPaymentsConfigured()");
    const secretIdx = code.indexOf("STRIPE_INVOICE_WEBHOOK_SECRET");
    const verifyIdx = code.indexOf("constructEvent(");
    expect(cfgIdx).toBeGreaterThan(-1);
    expect(secretIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(cfgIdx).toBeLessThan(verifyIdx);
    expect(secretIdx).toBeLessThan(verifyIdx);
  });

  it("the pay-now client never reads the SaaS key + only fetches after guards", () => {
    const code = codeOf(read(CLIENT));
    expect(code).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(code).toMatch(/STRIPE_CONNECT_SECRET_KEY/);
  });

  it("the portal page gates the Pay-now button on isPortalPaymentsConfigured + a connected org", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/isPortalPaymentsConfigured\(\)/);
    expect(code).toMatch(/payEnabled\s*=\s*!!c && c\.status === "connected"/);
    expect(code).toMatch(/payEnabled && !isFullyPaid/);
  });

  it("the pay action is a portal-token action that records via the intent service", () => {
    const code = codeOf(read(PAY_ACTION));
    expect(code).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(code).toMatch(/createInvoiceCheckout\(/);
    // The connected-account header is what isolates funds to the tenant.
    expect(code).toMatch(/stripeAccount:\s*args\.connectedAccountId/);
  });

  it("the handler records into invoice_payments with source 'stripe' (existing ledger)", () => {
    const code = codeOf(read(HANDLER));
    expect(code).toMatch(/\.from\("invoice_payments"\)/);
    expect(code).toMatch(/source:\s*"stripe"/);
    // The atomic idempotency claim sets the link ONLY while null.
    expect(code).toMatch(/\.is\("invoice_payment_id", null\)/);
  });
});
