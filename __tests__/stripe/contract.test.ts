import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROCESSED_STRIPE_EVENTS,
  isProcessedEvent,
} from "@/lib/stripe/events";

/**
 * Stripe integration contract tests.
 *
 * Pinned here:
 *   1. Event registry covers every type the webhook handler branches
 *      on. Missing one means we'd silently drop the event.
 *   2. Webhook route: signature verify is mandatory, missing config
 *      returns 503 (so a half-configured deploy fails loudly), missing
 *      signature returns 401, raw body is read with `request.text()`
 *      (NOT JSON-parsed — that would break signature verification).
 *   3. Handler: idempotency via billing_events.event_id unique
 *      collision; every event handler returns a deterministic action
 *      string for the response body.
 *   4. Diagnostic endpoint: gated by isSuperAdminEmail, returns 404
 *      on miss (no info leak), runs all 7 checks.
 *   5. Server actions: re-check isSuperAdminEmail, attach metadata
 *      with org_id + kind + actor_id, set both success and cancel
 *      URLs to /admin/customers/<id>.
 *   6. Env schema: STRIPE_* vars are optional at boot — app should
 *      start without them, individual routes return 503 when used.
 *   7. Customer page wires both setup + subscription checkout forms.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const WEBHOOK_ROUTE = read("app/api/webhooks/stripe/route.ts");
const MIDDLEWARE = read("middleware.ts");
const HANDLER = read("server/services/stripe-webhook-handler.ts");
const DIAG_ROUTE = read("app/api/admin/stripe/verify/route.ts");
const CHECKOUT_ACTIONS = read(
  "app/admin/customers/[id]/_stripe-actions.ts",
);
const CUSTOMER_PAGE = read("app/admin/customers/[id]/page.tsx");
const ENV_SCHEMA = read("lib/env.ts");
const CLIENT = read("lib/stripe/client.ts");
const PRICES = read("lib/stripe/prices.ts");

// =====================================================================
// 1. Event registry
// =====================================================================

describe("PROCESSED_STRIPE_EVENTS — every directive-mandated event", () => {
  it("includes every event type the handler branches on", () => {
    // Cross-reference against the switch statement in the handler.
    // Any case there must appear in this list — else the event would
    // slip through isProcessedEvent and skip the side-effects.
    for (const evt of [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.finalized",
      "invoice.voided",
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "customer.created",
      "customer.updated",
    ]) {
      expect(PROCESSED_STRIPE_EVENTS).toContain(evt);
    }
  });

  it("isProcessedEvent narrows correctly", () => {
    expect(isProcessedEvent("checkout.session.completed")).toBe(true);
    expect(isProcessedEvent("invoice.paid")).toBe(true);
    expect(isProcessedEvent("not.a.real.event")).toBe(false);
    expect(isProcessedEvent("")).toBe(false);
  });
});

// =====================================================================
// 2. Webhook route
// =====================================================================

describe("middleware — webhook endpoints bypass auth redirect", () => {
  it("excludes api/webhooks from the matcher (Stripe-Signature owns auth)", () => {
    // Regression guard: I shipped Stripe once with the webhook hitting
    // the Supabase session middleware, which 307'd Stripe to /login
    // and broke webhook delivery silently. Pin the exclusion.
    expect(MIDDLEWARE).toMatch(/api\/webhooks/);
  });
});

describe("/api/webhooks/stripe route", () => {
  it("uses the nodejs runtime + force-dynamic", () => {
    expect(WEBHOOK_ROUTE).toMatch(/runtime = "nodejs"/);
    expect(WEBHOOK_ROUTE).toMatch(/dynamic = "force-dynamic"/);
  });

  it("returns 503 when STRIPE_SECRET_KEY or webhook secret missing", () => {
    expect(WEBHOOK_ROUTE).toMatch(/stripe_not_configured/);
    expect(WEBHOOK_ROUTE).toMatch(/webhook_secret_not_configured/);
    expect(WEBHOOK_ROUTE).toMatch(/status: 503/);
  });

  it("returns 401 on missing or invalid signature", () => {
    expect(WEBHOOK_ROUTE).toMatch(/missing_stripe_signature/);
    expect(WEBHOOK_ROUTE).toMatch(/signature_verification_failed/);
    const status401Count = (WEBHOOK_ROUTE.match(/status: 401/g) ?? []).length;
    expect(status401Count).toBeGreaterThanOrEqual(2);
  });

  it("reads the RAW body with request.text() — never JSON-parses", () => {
    expect(WEBHOOK_ROUTE).toMatch(/request\.text\(\)/);
    expect(WEBHOOK_ROUTE).not.toMatch(/request\.json\(\)/);
  });

  it("delegates to processStripeEvent so route + service stay testable", () => {
    expect(WEBHOOK_ROUTE).toMatch(/processStripeEvent/);
  });

  it("calls stripe.webhooks.constructEvent for signature verification", () => {
    expect(WEBHOOK_ROUTE).toMatch(/stripe\.webhooks\.constructEvent/);
  });
});

// =====================================================================
// 3. Handler — idempotency + dispatch
// =====================================================================

describe("processStripeEvent handler", () => {
  it("INSERTs into billing_events first (drives idempotency)", () => {
    expect(HANDLER).toMatch(/adminTable\("billing_events"\)\.insert/);
  });

  it("treats unique-violation as duplicate ack (200 to Stripe)", () => {
    expect(HANDLER).toMatch(/"23505"/);
    expect(HANDLER).toMatch(/status: "duplicate"/);
  });

  it("triggers recomputeHealthForOrg with trigger='payment_change' on money events", () => {
    const occurrences = (HANDLER.match(
      /recomputeHealthForOrg\([^,]+, "payment_change"/g,
    ) ?? []).length;
    // setup checkout + subscription upsert + invoice paid + invoice failed
    // = at least 4 callsites.
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it("dual-writes admin_activity_log for every dispatched event", () => {
    const occurrences = (HANDLER.match(/recordAdminActivity\(/g) ?? []).length;
    // checkout, subscription_upsert, subscription_deleted, invoice_paid,
    // invoice_failed, payment_intent → 6+ writes.
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  it("marks the event processed (or error) on the billing_events row", () => {
    expect(HANDLER).toMatch(/markProcessed/);
    expect(HANDLER).toMatch(/processed_at/);
  });

  it("looks up the org by stripe_customer_id when metadata is absent", () => {
    expect(HANDLER).toMatch(/orgIdByCustomer/);
    expect(HANDLER).toMatch(/\.eq\("stripe_customer_id"/);
  });

  it("flips org.status when subscription transitions to canceled / past_due", () => {
    expect(HANDLER).toMatch(/"canceled"/);
    expect(HANDLER).toMatch(/"past_due"/);
    expect(HANDLER).toMatch(/handleSubscriptionUpsert/);
  });

  it("does NOT auto-cancel the org on customer.subscription.deleted (high-blast operator decision)", () => {
    expect(HANDLER).toMatch(/handleSubscriptionDeleted/);
    expect(HANDLER).toMatch(/subscription_deleted_recorded/);
  });
});

// =====================================================================
// 4. Diagnostic endpoint
// =====================================================================

describe("/api/admin/stripe/verify diagnostic", () => {
  it("gates on isSuperAdminEmail with 404 on miss (no info leak)", () => {
    expect(DIAG_ROUTE).toMatch(/isSuperAdminEmail/);
    expect(DIAG_ROUTE).toMatch(/status: 404/);
  });

  it("includes every directive check", () => {
    for (const label of [
      "STRIPE_SECRET_KEY set",
      "STRIPE_WEBHOOK_SECRET set",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY set",
      "Stripe SDK reachable",
      "£1,000 setup-fee price resolves",
      "£500/mo subscription price resolves",
      "billing_events table reachable",
    ]) {
      expect(DIAG_ROUTE).toContain(label);
    }
  });

  it("surfaces TEST vs LIVE mode for the operator", () => {
    expect(DIAG_ROUTE).toMatch(/isLiveMode/);
    expect(DIAG_ROUTE).toMatch(/env_mode/);
  });
});

// =====================================================================
// 5. Checkout server actions
// =====================================================================

describe("checkout server actions", () => {
  it("both actions gate on HQ access via requireHq()", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/import \{ requireHq \} from "@\/server\/auth\/hq"/);
    expect(CHECKOUT_ACTIONS).toMatch(/requireHq\(\)/);
  });

  it("exports both setup + subscription checkout creators", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/export async function createSetupCheckout/);
    expect(CHECKOUT_ACTIONS).toMatch(/export async function createSubscriptionCheckout/);
  });

  it("attaches metadata { org_id, kind, actor_id } so the webhook can dispatch", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/org_id: org\.id/);
    // `kind` arrives as a parameter to runCheckout — the literal
    // strings appear in CheckoutKind, in branch logic, and in the
    // page-redirect labels.
    expect(CHECKOUT_ACTIONS).toMatch(/"setup_fee"/);
    expect(CHECKOUT_ACTIONS).toMatch(/"subscription"/);
    expect(CHECKOUT_ACTIONS).toMatch(/actor_id: admin\.id/);
  });

  it("propagates metadata to payment_intent_data + subscription_data", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/payment_intent_data: \{ metadata \}/);
    expect(CHECKOUT_ACTIONS).toMatch(/subscription_data: \{ metadata \}/);
  });

  it("reuses an existing stripe_customer_id when set", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/ensureStripeCustomer/);
    expect(CHECKOUT_ACTIONS).toMatch(/if \(org\.stripe_customer_id\) return org\.stripe_customer_id/);
  });

  it("writes admin_activity_log so the audit trail shows operator intent", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/recordAdminActivity/);
    expect(CHECKOUT_ACTIONS).toMatch(/"stripe\.checkout_created"/);
  });

  it("redirects the operator to the hosted Stripe Checkout URL (or to an error page on failure)", () => {
    // Post-refactor: runCheckout() returns session.url, the action
    // then redirect()s to that target. On exception the action
    // redirects with ?error= and ?detail= so the page can render a
    // diagnostic banner instead of bouncing to /error.tsx.
    expect(CHECKOUT_ACTIONS).toMatch(/return session\.url/);
    expect(CHECKOUT_ACTIONS).toMatch(/redirect\(target\)/);
    expect(CHECKOUT_ACTIONS).toMatch(/\?error=\$\{encodeURIComponent\(code\)\}/);
  });

  it(
    "REGRESSION: wraps every Stripe SDK call so a thrown error never reaches Next's error boundary (was 'Something went wrong' in prod)",
    () => {
      // Pin the safety net: outer action body has try/catch around
      // runCheckout, errors funnel into structured `[stripe-checkout]`
      // logs, and redirect() runs OUTSIDE the try/catch (so it can
      // throw NEXT_REDIRECT without being swallowed).
      expect(CHECKOUT_ACTIONS).toMatch(/\[stripe-checkout\]/);
      expect(CHECKOUT_ACTIONS).toMatch(/isNextRedirect/);
      expect(CHECKOUT_ACTIONS).toMatch(/class CheckoutError/);
    },
  );

  it("success + cancel URLs return to /admin/customers/<id>", () => {
    expect(CHECKOUT_ACTIONS).toMatch(/success_url/);
    expect(CHECKOUT_ACTIONS).toMatch(/cancel_url/);
    expect(CHECKOUT_ACTIONS).toMatch(/\/admin\/customers\/\$\{org\.id\}\?stripe=success/);
    expect(CHECKOUT_ACTIONS).toMatch(/\/admin\/customers\/\$\{org\.id\}\?stripe=cancelled/);
  });
});

// =====================================================================
// 6. Env schema
// =====================================================================

describe("env schema — Stripe vars are optional at boot", () => {
  it("STRIPE_SECRET_KEY is optional", () => {
    expect(ENV_SCHEMA).toMatch(/STRIPE_SECRET_KEY: z\.string\(\)\.optional\(\)/);
  });
  it("STRIPE_WEBHOOK_SECRET is optional", () => {
    expect(ENV_SCHEMA).toMatch(/STRIPE_WEBHOOK_SECRET: z\.string\(\)\.optional\(\)/);
  });
  it("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is optional", () => {
    expect(ENV_SCHEMA).toMatch(
      /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z\.string\(\)\.optional\(\)/,
    );
  });
  it("setup + subscription price override env vars are declared", () => {
    expect(ENV_SCHEMA).toMatch(/STRIPE_SETUP_PRICE_ID/);
    expect(ENV_SCHEMA).toMatch(/STRIPE_SUBSCRIPTION_PRICE_ID/);
  });
});

// =====================================================================
// 7. Client + price discovery
// =====================================================================

describe("Stripe client + price discovery", () => {
  it("client pins apiVersion so SDK upgrades don't silently change wire behaviour", () => {
    // Pin matches the version bundled with stripe@^17.4.0 (acacia).
    // When the SDK is upgraded the pin should also be re-checked.
    expect(CLIENT).toMatch(/apiVersion: "20\d{2}-\d{2}-\d{2}\.[a-z]+"/);
  });
  it("client returns null when STRIPE_SECRET_KEY is unset (no crash at boot)", () => {
    expect(CLIENT).toMatch(/if \(!key\)/);
    expect(CLIENT).toMatch(/cached = null/);
  });
  it("isLiveMode flips on sk_live_ prefix", () => {
    expect(CLIENT).toMatch(/sk_live_/);
  });
  it("price resolver caches results per process", () => {
    expect(PRICES).toMatch(/let cache:/);
    expect(PRICES).toMatch(/clearPriceCache/);
  });
  it("price resolver honours env-var override before auto-discovery", () => {
    expect(PRICES).toMatch(/STRIPE_SETUP_PRICE_ID/);
    expect(PRICES).toMatch(/STRIPE_SUBSCRIPTION_PRICE_ID/);
    expect(PRICES).toMatch(/source: "env_override"/);
    expect(PRICES).toMatch(/source: "auto_discovery"/);
  });
  it("auto-discovery looks for active GBP prices at the expected amounts", () => {
    expect(PRICES).toMatch(/SETUP_AMOUNT_PENCE = 100_000/);
    expect(PRICES).toMatch(/SUBSCRIPTION_AMOUNT_PENCE = 50_000/);
    expect(PRICES).toMatch(/CURRENCY = "gbp"/);
  });
});

// =====================================================================
// 8. Customer page wiring
// =====================================================================

describe("/admin/customers/[id] page", () => {
  it("imports both checkout actions", () => {
    expect(CUSTOMER_PAGE).toMatch(/createSetupCheckout/);
    expect(CUSTOMER_PAGE).toMatch(/createSubscriptionCheckout/);
  });
  it("renders both checkout buttons with the right copy", () => {
    expect(CUSTOMER_PAGE).toMatch(/Open setup-fee checkout/);
    expect(CUSTOMER_PAGE).toMatch(/Open subscription checkout/);
    expect(CUSTOMER_PAGE).toMatch(/£1,000/);
    expect(CUSTOMER_PAGE).toMatch(/£500\/mo/);
  });
  it("links to the diagnostic endpoint so the CEO can verify in-app", () => {
    expect(CUSTOMER_PAGE).toMatch(/\/api\/admin\/stripe\/verify/);
  });
});
