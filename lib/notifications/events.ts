/**
 * CrewFlow — Notification event helpers (HQ-8).
 *
 * One function per real event the directive lists. Each returns a
 * `NotificationCreate` (or an array — some events fan out to both
 * customer + HQ). Pure functions: no I/O, fully unit-testable. The
 * DB write happens via `createNotifications(...)` in
 * `server/services/notifications-service.ts`.
 *
 * Naming convention: `notifyOn<Event>()`. Audience encoded in the
 * return shape — caller doesn't pick.
 */

import type { NotificationCreate } from "./types";

// ---------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------

function customerOrgWide(
  org_id: string,
  type: string,
  base: Omit<NotificationCreate, "org_id" | "user_id" | "audience" | "type">,
): NotificationCreate {
  return {
    org_id,
    user_id: null,
    audience: "customer",
    type,
    ...base,
  };
}

function hqForOrg(
  org_id: string,
  type: string,
  base: Omit<NotificationCreate, "org_id" | "user_id" | "audience" | "type">,
): NotificationCreate {
  // HQ audience never has a user_id — the org_id is the routing key
  // and every super-admin sees the same rows via service-role reads.
  return {
    org_id,
    user_id: null,
    audience: "hq",
    type,
    ...base,
  };
}

function gbp(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return `£${Math.round(amount).toLocaleString("en-GB")}`;
}

// =====================================================================
// SUPPORT
// =====================================================================

export function notifyOnSupportReplyToCustomer(input: {
  org_id: string;
  ticket_id: string;
  ticket_number: number;
  subject: string;
  body_preview: string;
}): NotificationCreate {
  return customerOrgWide(input.org_id, "support.hq_reply", {
    category: "support",
    priority: "medium",
    title: `CrewFlow Support replied to ticket #${input.ticket_number}`,
    body: shortenBody(`Re: ${input.subject} — ${input.body_preview}`),
    action_url: `/support/${input.ticket_id}`,
    source_module: "support",
    source_id: input.ticket_id,
    metadata: { ticket_number: input.ticket_number },
  });
}

export function notifyOnSupportReplyToHq(input: {
  org_id: string;
  ticket_id: string;
  ticket_number: number;
  subject: string;
  body_preview: string;
}): NotificationCreate {
  return hqForOrg(input.org_id, "support.customer_reply", {
    category: "support",
    priority: "high",
    title: `Customer replied to ticket #${input.ticket_number}`,
    body: shortenBody(`${input.subject} — ${input.body_preview}`),
    action_url: `/admin/support/${input.ticket_id}`,
    source_module: "support",
    source_id: input.ticket_id,
    metadata: { ticket_number: input.ticket_number, org_id: input.org_id },
  });
}

export function notifyOnSupportStatusChanged(input: {
  org_id: string;
  ticket_id: string;
  ticket_number: number;
  new_status: string;
}): NotificationCreate {
  const titleMap: Record<string, string> = {
    in_progress: `We're working on ticket #${input.ticket_number}`,
    waiting_on_customer: `Ticket #${input.ticket_number} is waiting on you`,
    resolved: `Ticket #${input.ticket_number} marked resolved`,
    closed: `Ticket #${input.ticket_number} closed`,
    open: `Ticket #${input.ticket_number} reopened`,
  };
  const priority = input.new_status === "waiting_on_customer" ? "high" : "medium";
  return customerOrgWide(input.org_id, "support.status_changed", {
    category: "support",
    priority,
    title: titleMap[input.new_status] ?? `Ticket #${input.ticket_number} status: ${input.new_status}`,
    body: null,
    action_url: `/support/${input.ticket_id}`,
    source_module: "support",
    source_id: input.ticket_id,
    metadata: { new_status: input.new_status, ticket_number: input.ticket_number },
  });
}

/** Fires when HQ flips priority to 'urgent' — pings HQ to act. */
export function notifyOnSupportPriorityUrgent(input: {
  org_id: string;
  ticket_id: string;
  ticket_number: number;
  subject: string;
}): NotificationCreate {
  return hqForOrg(input.org_id, "support.priority_urgent", {
    category: "support",
    priority: "urgent",
    title: `URGENT ticket #${input.ticket_number}: ${input.subject}`,
    body: "Marked urgent — respond ASAP.",
    action_url: `/admin/support/${input.ticket_id}`,
    source_module: "support",
    source_id: input.ticket_id,
    metadata: { ticket_number: input.ticket_number, org_id: input.org_id },
  });
}

// =====================================================================
// BILLING / STRIPE
// =====================================================================

export function notifyOnFailedPayment(input: {
  org_id: string;
  amount_gbp: number;
  stripe_invoice_id?: string | null;
  reason?: string | null;
}): NotificationCreate[] {
  return [
    customerOrgWide(input.org_id, "stripe.payment_failed", {
      category: "stripe",
      priority: "urgent",
      title: `Payment of ${gbp(input.amount_gbp)} failed`,
      body:
        input.reason ??
        "Your card was declined. Update your payment method to avoid service interruption.",
      action_url: `/dashboard`,
      source_module: "stripe",
      source_id: input.stripe_invoice_id ?? null,
      metadata: { amount_gbp: input.amount_gbp, reason: input.reason ?? null },
      // Also deliver by email — a declined card is money-critical and the
      // customer may not be logged in to see the in-app notice. Recipient
      // resolves to the org's `organizations.email` (see emitNotifications).
      email: {},
    }),
    hqForOrg(input.org_id, "stripe.payment_failed", {
      category: "stripe",
      priority: "high",
      title: `Failed payment: ${gbp(input.amount_gbp)}`,
      body: input.reason ?? "Card declined.",
      action_url: `/admin/customers/${input.org_id}`,
      source_module: "stripe",
      source_id: input.stripe_invoice_id ?? null,
      metadata: {
        amount_gbp: input.amount_gbp,
        reason: input.reason ?? null,
        stripe_invoice_id: input.stripe_invoice_id ?? null,
      },
    }),
  ];
}

export function notifyOnOverdueInvoice(input: {
  org_id: string;
  amount_gbp: number;
  days_overdue: number;
  invoice_id: string;
}): NotificationCreate[] {
  return [
    customerOrgWide(input.org_id, "billing.invoice_overdue", {
      category: "billing",
      priority: input.days_overdue > 14 ? "urgent" : "high",
      title: `Invoice overdue (${input.days_overdue} days)`,
      body: `${gbp(input.amount_gbp)} outstanding. Please settle to keep your subscription active.`,
      action_url: `/dashboard`,
      source_module: "billing",
      source_id: input.invoice_id,
      metadata: { amount_gbp: input.amount_gbp, days_overdue: input.days_overdue },
    }),
    hqForOrg(input.org_id, "billing.invoice_overdue", {
      category: "billing",
      priority: input.days_overdue > 30 ? "urgent" : "high",
      title: `Invoice ${input.days_overdue}d overdue: ${gbp(input.amount_gbp)}`,
      body: null,
      action_url: `/admin/billing`,
      source_module: "billing",
      source_id: input.invoice_id,
      metadata: { amount_gbp: input.amount_gbp, days_overdue: input.days_overdue },
    }),
  ];
}

export function notifyOnSetupFeePaid(input: {
  org_id: string;
  amount_gbp?: number;
}): NotificationCreate[] {
  return [
    customerOrgWide(input.org_id, "billing.setup_fee_paid", {
      category: "billing",
      priority: "medium",
      title: "Setup fee paid — welcome aboard",
      body: `Thanks! Your ${gbp(input.amount_gbp ?? 1000)} setup is settled. Onboarding continues on /dashboard.`,
      action_url: "/dashboard",
      source_module: "billing",
      source_id: null,
      metadata: { amount_gbp: input.amount_gbp ?? 1000 },
    }),
    hqForOrg(input.org_id, "billing.setup_fee_paid", {
      category: "billing",
      priority: "low",
      title: `Setup fee paid — ${gbp(input.amount_gbp ?? 1000)}`,
      body: null,
      action_url: `/admin/customers/${input.org_id}`,
      source_module: "billing",
      source_id: null,
      metadata: { amount_gbp: input.amount_gbp ?? 1000 },
    }),
  ];
}

export function notifyOnSubscriptionStarted(input: {
  org_id: string;
  stripe_subscription_id: string;
  next_renewal_at?: string | null;
}): NotificationCreate[] {
  return [
    customerOrgWide(input.org_id, "stripe.subscription_started", {
      category: "stripe",
      priority: "medium",
      title: "Subscription active",
      body: input.next_renewal_at
        ? `£500/month — next renewal ${input.next_renewal_at.slice(0, 10)}.`
        : "£500/month subscription active.",
      action_url: "/dashboard",
      source_module: "stripe",
      source_id: input.stripe_subscription_id,
      metadata: { next_renewal_at: input.next_renewal_at ?? null },
    }),
    hqForOrg(input.org_id, "stripe.subscription_started", {
      category: "stripe",
      priority: "medium",
      title: "Subscription started",
      body: input.next_renewal_at
        ? `Next renewal ${input.next_renewal_at.slice(0, 10)}.`
        : null,
      action_url: `/admin/customers/${input.org_id}`,
      source_module: "stripe",
      source_id: input.stripe_subscription_id,
      metadata: { next_renewal_at: input.next_renewal_at ?? null },
    }),
  ];
}

export function notifyOnSubscriptionCancelled(input: {
  org_id: string;
  stripe_subscription_id: string;
}): NotificationCreate {
  return hqForOrg(input.org_id, "stripe.subscription_cancelled", {
    category: "stripe",
    priority: "urgent",
    title: "Subscription cancelled",
    body: "Customer cancelled. Decide whether to suspend access or downgrade.",
    action_url: `/admin/customers/${input.org_id}`,
    source_module: "stripe",
    source_id: input.stripe_subscription_id,
    metadata: {},
  });
}

// =====================================================================
// ONBOARDING / MIGRATION
// =====================================================================

export function notifyOnOnboardingMilestone(input: {
  org_id: string;
  milestone: string;
  percent: number;
}): NotificationCreate {
  return customerOrgWide(input.org_id, "onboarding.milestone", {
    category: "onboarding",
    priority: "low",
    title: `Onboarding ${input.percent}% — ${input.milestone}`,
    body: "Nice — one step closer.",
    action_url: "/dashboard",
    source_module: "onboarding",
    source_id: null,
    metadata: { milestone: input.milestone, percent: input.percent },
  });
}

export function notifyOnMigrationProgress(input: {
  org_id: string;
  percent: number;
  import_id?: string | null;
}): NotificationCreate {
  return customerOrgWide(input.org_id, "migration.progress", {
    category: "migration",
    priority: input.percent >= 100 ? "medium" : "low",
    title:
      input.percent >= 100
        ? "Migration complete"
        : `Migration ${input.percent}%`,
    body:
      input.percent >= 100
        ? "Your historical data is fully imported. You're ready to roll."
        : "Migration progressing — we'll let you know when it's done.",
    action_url: "/imports",
    source_module: "migration",
    source_id: input.import_id ?? null,
    metadata: { percent: input.percent },
  });
}

export function notifyOnMigrationStalled(input: {
  org_id: string;
  days_stalled: number;
}): NotificationCreate {
  return hqForOrg(input.org_id, "migration.stalled", {
    category: "migration",
    priority: "high",
    title: `Migration stalled (${input.days_stalled}d)`,
    body: "Customer hasn't made progress. Reach out to unblock.",
    action_url: `/admin/onboarding`,
    source_module: "migration",
    source_id: null,
    metadata: { days_stalled: input.days_stalled, org_id: input.org_id },
  });
}

// =====================================================================
// HEALTH
// =====================================================================

export function notifyOnHealthDropped(input: {
  org_id: string;
  org_name?: string | null;
  old_score: number;
  new_score: number;
}): NotificationCreate {
  const delta = input.new_score - input.old_score;
  const priority =
    input.new_score < 40
      ? "urgent"
      : Math.abs(delta) >= 20
        ? "high"
        : "medium";
  return hqForOrg(input.org_id, "health.dropped", {
    category: "health",
    priority,
    title: `${input.org_name ?? "Customer"} health ${input.old_score}→${input.new_score} (${delta})`,
    body:
      input.new_score < 40
        ? "Critical band. Schedule a retention call today."
        : "Watch this customer.",
    action_url: `/admin/customers/${input.org_id}`,
    source_module: "health",
    source_id: null,
    metadata: {
      old_score: input.old_score,
      new_score: input.new_score,
      delta,
    },
  });
}

// =====================================================================
// DEMO / SIGNUP
// =====================================================================

export function notifyOnDemoRequested(input: {
  org_id?: string | null;
  demo_id: string;
  company: string;
  contact_name?: string | null;
}): NotificationCreate {
  // org_id may be null for unlinked leads (pre-signup demos). We
  // still want the HQ notification — store the demo as source_id so
  // /admin/demos/<id> deep-links work.
  //
  // For org_id, fall back to the internal CrewFlow org so the row
  // satisfies the NOT NULL constraint without polluting customer
  // workspaces. The internal org id is in CREWFLOW_INTERNAL_ORG_ID
  // env (see HQ-2). For helpers we use the provided org_id when
  // given, else a sentinel — the caller is responsible for
  // resolving the fallback.
  return hqForOrg(input.org_id ?? "00000000-0000-0000-0000-000000000000", "demo.requested", {
    category: "demo",
    priority: "high",
    title: `New demo request: ${input.company}`,
    body: input.contact_name
      ? `Contact: ${input.contact_name}`
      : "New lead — review and contact.",
    action_url: `/admin/demos`,
    source_module: "demo",
    source_id: input.demo_id,
    metadata: { company: input.company, contact_name: input.contact_name ?? null },
  });
}

export function notifyOnCustomerSignup(input: {
  org_id: string;
  org_name: string;
  owner_email?: string | null;
}): NotificationCreate {
  return hqForOrg(input.org_id, "signup.org_created", {
    category: "signup",
    priority: "high",
    title: `New CrewFlow signup: ${input.org_name}`,
    body: input.owner_email ? `Owner: ${input.owner_email}` : null,
    action_url: `/admin/customers/${input.org_id}`,
    source_module: "signup",
    source_id: null,
    metadata: { owner_email: input.owner_email ?? null },
  });
}

// =====================================================================
// URGENT HQ ALERT (HQ-5 alert rules can hook this)
// =====================================================================

export function notifyOnUrgentHqAlert(input: {
  org_id: string;
  org_name?: string | null;
  alert_label: string;
  detail?: string | null;
  alert_url?: string | null;
}): NotificationCreate {
  return hqForOrg(input.org_id, "alert.urgent", {
    category: "alert",
    priority: "urgent",
    title: `Alert: ${input.alert_label}${input.org_name ? ` (${input.org_name})` : ""}`,
    body: input.detail ?? null,
    action_url: input.alert_url ?? `/admin/alerts`,
    source_module: "alert",
    source_id: null,
    metadata: { alert_label: input.alert_label },
  });
}

// =====================================================================
// Internal helpers
// =====================================================================

function shortenBody(text: string): string {
  if (text.length <= 280) return text;
  return text.slice(0, 277) + "…";
}

// =====================================================================
// PAYMENTS (tenant ↔ their own customer)
// =====================================================================

/**
 * A customer submitted payment proof through their portal.
 *
 * The first event here about the TENANT's own money rather than CrewFlow's
 * subscription billing. The portal already tells the customer "{org} will
 * confirm here once it's matched to your payment", and the staff proof panel
 * on the invoice exists — but nothing told staff a proof had arrived, so the
 * promise depended on someone happening to open that invoice.
 *
 * Audience is the org, org-wide: `customerOrgWide` sets audience 'customer'
 * (which in Support OS terms means the CrewFlow customer = THIS TENANT) with
 * user_id null, and the notifications RLS resolves that to every member of the
 * org. So org isolation comes from `org_id` alone — the end-customer is never a
 * recipient, and no other org can be.
 *
 * category 'billing' rather than 'stripe': /notifications filters on category,
 * and both live 'stripe' emitters are CrewFlow's own subscription events —
 * filing a tenant's bank-transfer proof there would mix two unrelated things
 * under the "Payment" label. 'billing' labels correctly and its only other
 * emitter (notifyOnOverdueInvoice) has no call sites. Widening the category
 * CHECK would need a migration, which this doesn't justify.
 *
 * `source_id` is the portal_uploads row id — the authoritative record's own
 * primary key — so a notification is traceable back to exactly one upload.
 */
export function notifyOnPaymentProofUploaded(input: {
  org_id: string;
  upload_id: string;
  invoice_id: string;
  invoice_number: string | null;
  customer_id: string;
  customer_name: string;
  filename: string;
  customer_note?: string | null;
}): NotificationCreate {
  const invoiceLabel = input.invoice_number ?? "an invoice";
  return customerOrgWide(input.org_id, "payment.proof_uploaded", {
    category: "billing",
    priority: "medium",
    title: `${input.customer_name} sent payment proof for ${invoiceLabel}`,
    body: shortenBody(
      `${input.filename} — open the invoice to check it against your bank, then record the payment.${
        input.customer_note ? ` Their note: ${input.customer_note}` : ""
      }`,
    ),
    // The staff proof panel lives on the invoice detail page.
    action_url: `/invoices/${input.invoice_id}`,
    source_module: "payments",
    source_id: input.upload_id,
    metadata: {
      invoice_id: input.invoice_id,
      customer_id: input.customer_id,
      upload_id: input.upload_id,
      filename: input.filename,
    },
  });
}

// Stable list of event helper names — used by tests to ensure
// nothing was renamed silently.
export const EVENT_HELPERS = [
  "notifyOnSupportReplyToCustomer",
  "notifyOnSupportReplyToHq",
  "notifyOnSupportStatusChanged",
  "notifyOnSupportPriorityUrgent",
  "notifyOnFailedPayment",
  "notifyOnOverdueInvoice",
  "notifyOnSetupFeePaid",
  "notifyOnSubscriptionStarted",
  "notifyOnSubscriptionCancelled",
  "notifyOnOnboardingMilestone",
  "notifyOnMigrationProgress",
  "notifyOnMigrationStalled",
  "notifyOnHealthDropped",
  "notifyOnDemoRequested",
  "notifyOnCustomerSignup",
  "notifyOnUrgentHqAlert",
  "notifyOnPaymentProofUploaded",
] as const;
