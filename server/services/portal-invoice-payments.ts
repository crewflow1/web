/**
 * Portal invoice payments — the create + settle ORCHESTRATION (dependency-injected).
 *
 * The tenant→customer payment flow's decision logic lives here, split from its
 * I/O so it is deterministic and unit-testable WITHOUT a database or a real
 * Stripe call:
 *
 *   - `createInvoiceCheckout` — refuse-before-fetch, then mint a Checkout Session
 *     on the tenant's connected account and persist an intent row. The order of
 *     the guards is the dark contract: the injected `stripe.createSession` is
 *     reached only AFTER the feature/config/connection/ownership/balance guards
 *     pass, so with the feature dark no Stripe call is possible.
 *
 *   - `settleInvoicePayment` — idempotently record a settled Stripe payment into
 *     the EXISTING invoice_payments ledger (source 'stripe'), crediting only the
 *     intent's own org + invoice. Idempotency + tenant-isolation are enforced here
 *     regardless of how many times (or from what account) the webhook fires.
 *
 * The webhook handler + the portal action wire the REAL admin-client / Stripe
 * dependencies onto these; tests wire fakes. Nothing here imports server-only or
 * touches the network directly.
 */

import { round2, toPounds } from "@/lib/money";
import { computeInvoiceBalance } from "@/lib/payments/allocation";
import { invoiceCustomerId } from "@/lib/invoices/customer";

// Stripe's smallest currency unit (pence for GBP). Invoice money is pounds
// (numeric(12,2)); Stripe amounts are integer minor units.
export function poundsToMinor(pounds: number): number {
  return Math.round(round2(pounds) * 100);
}
export function minorToPounds(minor: number): number {
  return round2(minor / 100);
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type OrgPaymentConnection = {
  org_id: string;
  status: string;
  stripe_account_id: string | null;
  default_currency: string;
};

export type InvoiceForPayment = {
  id: string;
  org_id: string;
  number: string | null;
  total: number | string | null;
  status: string;
  customer_id: string | null;
  quote?: { customer_id?: string | null } | null;
};

export type IntentRow = {
  id: string;
  org_id: string;
  invoice_id: string;
  stripe_account_id: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  amount: number | string;
  currency: string;
  status: string;
  invoice_payment_id: string | null;
};

// ---------------------------------------------------------------------------
// createInvoiceCheckout
// ---------------------------------------------------------------------------

export type CreateCheckoutInput = {
  orgId: string;
  customerId: string;
  invoiceId: string;
  /** Absolute origin for the return URLs, e.g. https://app.crewflow.uk. */
  appUrl: string;
  /** Portal token — used only to build the customer's return URL. */
  token: string;
};

export type CreateCheckoutDeps = {
  /** Switch-1+2 config gate (flag AND platform key). No network. */
  isConfigured: () => boolean;
  /** The org's connected-account binding, or null. */
  loadConnection: (orgId: string) => Promise<OrgPaymentConnection | null>;
  /** The invoice + paid-so-far, org+customer scoped, or null when not found. */
  loadInvoice: (
    orgId: string,
    invoiceId: string,
  ) => Promise<{ invoice: InvoiceForPayment; paid: number } | null>;
  /** Reuse a still-open session for this invoice, or null. */
  findReusableIntent?: (
    orgId: string,
    invoiceId: string,
  ) => Promise<{ url: string; sessionId: string } | null>;
  /** Create a Checkout Session ON the connected account. */
  stripe: {
    createSession: (args: {
      connectedAccountId: string;
      amountMinor: number;
      currency: string;
      invoiceNumber: string;
      metadata: Record<string, string>;
      successUrl: string;
      cancelUrl: string;
      /** Stripe idempotency key so a double-click reuses the same session. */
      idempotencyKey: string;
    }) => Promise<{ id: string; url: string | null; paymentIntentId: string | null }>;
  };
  /** Persist the intent ledger row. */
  saveIntent: (row: {
    orgId: string;
    invoiceId: string;
    customerId: string;
    stripeAccountId: string;
    sessionId: string;
    paymentIntentId: string | null;
    amount: number;
    currency: string;
  }) => Promise<void>;
};

export type CreateCheckoutResult =
  | { ok: true; url: string; reused: boolean; amount: number }
  | {
      ok: false;
      reason:
        | "feature_disabled"
        | "org_not_connected"
        | "invoice_not_found"
        | "not_your_invoice"
        | "nothing_due"
        | "stripe_error";
      message?: string;
    };

export async function createInvoiceCheckout(
  deps: CreateCheckoutDeps,
  input: CreateInvoiceCheckoutInput,
): Promise<CreateCheckoutResult> {
  // GUARD 1 — the two-switch config gate. Refuse BEFORE any I/O or Stripe call.
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };

  // GUARD 2 — the paying tenant must have a connected account (org-level switch).
  const connection = await deps.loadConnection(input.orgId);
  if (
    !connection ||
    connection.status !== "connected" ||
    !connection.stripe_account_id
  ) {
    return { ok: false, reason: "org_not_connected" };
  }

  // GUARD 3 — the invoice must exist, be this org's, and be this customer's.
  const loaded = await deps.loadInvoice(input.orgId, input.invoiceId);
  if (!loaded) return { ok: false, reason: "invoice_not_found" };
  const { invoice, paid } = loaded;
  if (invoice.org_id !== input.orgId) {
    return { ok: false, reason: "not_your_invoice" };
  }
  if (invoiceCustomerId(invoice) !== input.customerId) {
    return { ok: false, reason: "not_your_invoice" };
  }

  // GUARD 4 — there must be an outstanding balance to collect.
  const balance = computeInvoiceBalance({
    invoiceTotal: invoice.total,
    payments: [{ amount: paid }],
  });
  if (balance.outstanding <= 0 || invoice.status === "paid") {
    return { ok: false, reason: "nothing_due" };
  }
  const amount = balance.outstanding;
  const amountMinor = poundsToMinor(amount);
  const currency = (connection.default_currency || "gbp").toLowerCase();

  // Reuse a still-open session for the SAME invoice (idempotent UX on re-click).
  if (deps.findReusableIntent) {
    const reusable = await deps.findReusableIntent(input.orgId, input.invoiceId);
    if (reusable?.url) {
      return { ok: true, url: reusable.url, reused: true, amount };
    }
  }

  const returnBase = `${input.appUrl.replace(/\/$/, "")}/customer-portal/${input.token}/invoices`;
  const metadata: Record<string, string> = {
    kind: "portal_invoice",
    org_id: input.orgId,
    invoice_id: input.invoiceId,
    customer_id: input.customerId,
  };

  let session: { id: string; url: string | null; paymentIntentId: string | null };
  try {
    session = await deps.stripe.createSession({
      connectedAccountId: connection.stripe_account_id,
      amountMinor,
      currency,
      invoiceNumber: invoice.number ?? input.invoiceId,
      metadata,
      successUrl: `${returnBase}?saved=paid#inv-${input.invoiceId}`,
      cancelUrl: `${returnBase}?error=payment_cancelled#inv-${input.invoiceId}`,
      // Same invoice + same balance → same key → Stripe returns the same session.
      idempotencyKey: `portal_inv_${input.invoiceId}_${amountMinor}`,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "stripe_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!session.url) {
    return { ok: false, reason: "stripe_error", message: "no_session_url" };
  }

  await deps.saveIntent({
    orgId: input.orgId,
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    stripeAccountId: connection.stripe_account_id,
    sessionId: session.id,
    paymentIntentId: session.paymentIntentId,
    amount,
    currency,
  });

  return { ok: true, url: session.url, reused: false, amount };
}

export type CreateInvoiceCheckoutInput = CreateCheckoutInput;

// ---------------------------------------------------------------------------
// settleInvoicePayment
// ---------------------------------------------------------------------------

export type SettleInput = {
  /** The Stripe event id (audit + provenance). */
  eventId: string;
  /** The connected account the event fired on (Connect `event.account`). */
  connectedAccountId: string | null;
  /** Look the intent up by whichever Stripe id the event carries. */
  sessionId?: string | null;
  paymentIntentId?: string | null;
  /** Minor-unit amount actually received (amount_total / amount_received). */
  amountReceivedMinor: number;
  currency: string | null;
  /** Metadata mirrored onto the session / PI. */
  metadata: { org_id?: string | null; invoice_id?: string | null } | null;
  /** Payment date (YYYY-MM-DD) — the settlement date. */
  paidAt: string;
};

export type SettleDeps = {
  /** Find the intent we created for this session / PI, or null. */
  findIntent: (keys: {
    sessionId?: string | null;
    paymentIntentId?: string | null;
  }) => Promise<IntentRow | null>;
  /** Load the target invoice (org-pinned), or null. */
  loadInvoice: (
    orgId: string,
    invoiceId: string,
  ) => Promise<{ id: string; org_id: string } | null>;
  /** Insert the invoice_payments receipt; returns its id. */
  insertInvoicePayment: (row: {
    orgId: string;
    invoiceId: string;
    amount: number;
    paidAt: string;
    reference: string;
    eventId: string;
  }) => Promise<{ id: string }>;
  /**
   * Atomically CLAIM the settlement: set invoice_payment_id + status only WHILE
   * it is still NULL. Returns true if this call won the claim, false if another
   * delivery already settled it (the race loser). This is the DB-level
   * idempotency backstop behind the in-memory pre-check.
   */
  claimSettlement: (
    intentId: string,
    invoicePaymentId: string,
    eventId: string,
  ) => Promise<boolean>;
  /** Best-effort rollback of a payment inserted by a race loser. */
  deleteInvoicePayment?: (paymentId: string) => Promise<void>;
  /** Record a terminal non-success status on the intent. */
  markStatus?: (
    intentId: string,
    status: "processing" | "failed" | "canceled",
    eventId: string,
  ) => Promise<void>;
};

export type SettleResult =
  | { ok: true; recorded: true; invoicePaymentId: string }
  | { ok: true; recorded: false; reason: "already_recorded" | "status_only" }
  | {
      ok: false;
      reason: "unknown_intent" | "account_mismatch" | "invoice_missing";
    };

/**
 * Idempotently record a settled Stripe payment as an invoice_payments receipt.
 *
 * IDEMPOTENCY. A payment is recorded only while the intent's invoice_payment_id
 * is NULL. The in-memory pre-check short-circuits a redelivered event; the atomic
 * `claimSettlement` (set-only-while-null) is the backstop that makes a true race
 * safe — the loser's just-inserted receipt is rolled back so the money is counted
 * exactly once.
 *
 * TENANT ISOLATION. We only ever act on an intent WE created (found by our own
 * Stripe id), and we reject the event unless its connected account AND its
 * metadata org/invoice match that intent. A forged or cross-tenant event records
 * nothing. The receipt is written to the intent's OWN org + invoice — never an
 * org taken from the (attacker-controllable) event.
 */
export async function settleInvoicePayment(
  deps: SettleDeps,
  input: SettleInput,
): Promise<SettleResult> {
  const intent = await deps.findIntent({
    sessionId: input.sessionId,
    paymentIntentId: input.paymentIntentId,
  });
  // Refuse to record a payment for a PaymentIntent / Session we never created:
  // a foreign or forged id resolves to no intent and records nothing.
  if (!intent) return { ok: false, reason: "unknown_intent" };

  // TENANT-ISOLATION cross-checks — the event must match the intent we hold.
  if (
    input.connectedAccountId &&
    input.connectedAccountId !== intent.stripe_account_id
  ) {
    return { ok: false, reason: "account_mismatch" };
  }
  if (input.metadata) {
    if (input.metadata.org_id && input.metadata.org_id !== intent.org_id) {
      return { ok: false, reason: "account_mismatch" };
    }
    if (
      input.metadata.invoice_id &&
      input.metadata.invoice_id !== intent.invoice_id
    ) {
      return { ok: false, reason: "account_mismatch" };
    }
  }

  // IDEMPOTENCY pre-check — a settled intent records nothing further.
  if (intent.invoice_payment_id) {
    return { ok: true, recorded: false, reason: "already_recorded" };
  }

  // Credit the intent's OWN invoice (never an org from the event body).
  const invoice = await deps.loadInvoice(intent.org_id, intent.invoice_id);
  if (!invoice) return { ok: false, reason: "invoice_missing" };

  // Prefer the intent's recorded amount; fall back to what Stripe reported.
  const amount =
    input.amountReceivedMinor > 0
      ? minorToPounds(input.amountReceivedMinor)
      : round2(toPounds(intent.amount));

  const reference =
    input.paymentIntentId ??
    intent.stripe_payment_intent_id ??
    input.sessionId ??
    intent.stripe_checkout_session_id ??
    intent.id;

  const inserted = await deps.insertInvoicePayment({
    orgId: intent.org_id,
    invoiceId: intent.invoice_id,
    amount,
    paidAt: input.paidAt,
    reference: `stripe:${reference}`,
    eventId: input.eventId,
  });

  // Atomic claim — set the link ONLY while still null. If we lost a race, roll
  // back the receipt we just inserted so the payment is counted exactly once.
  const won = await deps.claimSettlement(intent.id, inserted.id, input.eventId);
  if (!won) {
    if (deps.deleteInvoicePayment) {
      await deps.deleteInvoicePayment(inserted.id).catch(() => undefined);
    }
    return { ok: true, recorded: false, reason: "already_recorded" };
  }

  return { ok: true, recorded: true, invoicePaymentId: inserted.id };
}
