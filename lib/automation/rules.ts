import type { AutomationRule } from "./events";

/**
 * Built-in automation catalogue.
 *
 * Hardcoded for v1. The directive's Step 5 explicitly says "Do not
 * build complex Zapier clone yet" — a static catalogue + an enabled
 * flag is enough until product traction demands user-editable rules.
 *
 * Each rule's `id` is the stable string we write to
 * `automation_runs.rule_id`. Renaming an id breaks the idempotency
 * dedup on existing rows, so don't.
 */
export const AUTOMATION_RULES: ReadonlyArray<AutomationRule> = [
  {
    id: "quote_accepted_notify",
    label: "Quote accepted",
    description:
      "When a customer accepts a quote, notify the org owner + audit.",
    trigger: "quote.accepted",
    enabled: true,
    actions: ["create_notification", "add_internal_note"],
  },
  {
    id: "invoice_overdue_alert",
    label: "Invoice overdue",
    description:
      "When an invoice crosses the overdue threshold, create an alert.",
    trigger: "invoice.overdue",
    enabled: true,
    actions: ["create_alert", "create_notification"],
  },
  {
    id: "job_completed_suggest_invoice",
    label: "Job completed → suggest invoice",
    description:
      "When a job flips to completed, notify the owner to send the final invoice.",
    trigger: "job.completed",
    enabled: true,
    actions: ["create_notification"],
  },
  {
    id: "import_completed_notify",
    label: "Migration completed",
    description: "When an import commits, notify the owner.",
    trigger: "import.completed",
    enabled: true,
    actions: ["create_notification", "create_milestone"],
  },
  // PRODUCER-LESS on the org-scoped engine (honest interim, C29) — enabled:false.
  //
  // Mirrors the outbound-webhooks discipline (lib/webhooks/events.ts:27-30): a
  // rule must never advertise itself as live when no real event can fire it.
  // `demo.booked` has NO org-scoped `dispatchAutomation` producer, and cannot: a
  // demo is booked into `demo_requests`, a GLOBAL HQ marketing table with no
  // tenant `org_id` at booking time (only `linked_org_id`, populated later, once
  // the prospect converts — migration 20260626120000). The automation OS is
  // fundamentally org-scoped: dispatchAutomation resolves per-org rule overrides
  // and writes `automation_runs.org_id` against the EVENT's org. There is no
  // owning tenant org to attribute a fresh demo booking to, so this rule cannot
  // fire honestly. It ships DISABLED until a demo→org producer exists (a real
  // event + data-boundary decision, not a catalogue edit). The drift-guard test
  // __tests__/security/automation-phantom-rules.test.ts fails CI if this is
  // re-enabled without a real producer. The HQ-facing "new demo booked" notice
  // is already handled directly by the demo flow (app/api/demo/route.ts +
  // app/admin/demos/actions.ts), not by this org-scoped engine.
  {
    id: "demo_booked_notify_hq",
    label: "Demo booked",
    description:
      "When a prospect books a demo, notify HQ. Producer-less on the org-scoped " +
      "engine — off until a demo→org event exists (see comment above).",
    trigger: "demo.booked",
    enabled: false,
    actions: ["create_notification"],
  },
  {
    id: "onboarding_completed_notify",
    label: "Onboarding completed",
    description:
      "When setup hits 100%, notify HQ + congratulate the customer.",
    trigger: "onboarding.completed",
    enabled: true,
    actions: ["create_notification", "create_milestone"],
  },
  {
    id: "support_ticket_created_notify",
    label: "Support ticket opened",
    description:
      "When a support ticket is opened, notify the company + HQ.",
    trigger: "support.ticket.created",
    enabled: true,
    actions: ["create_notification"],
  },
  // ── Opt-in rules (default OFF) — the home of the newly-wired actions ────────
  // These carry the previously-stubbed actions that now call real authorities
  // (send_email_queue → the notification→email bridge; create_invoice_draft →
  // the quote→draft-invoice path). They ship `enabled: false` so they have ZERO
  // effect on the live path until an org turns them on via a per-org override
  // (automation_rules) — the exact override mechanism this workstream adds. An
  // org opts in from Settings → Automations; the dispatcher then resolves them
  // enabled for that org only.
  {
    id: "payment_recorded_email_receipt",
    label: "Payment received → email receipt",
    description:
      "When a payment is recorded, queue a receipt email to the customer. " +
      "Off by default — enable per org in Settings → Automations.",
    trigger: "payment.recorded",
    enabled: false,
    actions: ["send_email_queue"],
  },
  {
    id: "quote_accepted_autoinvoice",
    label: "Quote accepted → ensure draft invoice",
    description:
      "When a quote is accepted, make sure a draft invoice exists for it " +
      "(idempotent — reuses the one the accept flow already creates). Off by " +
      "default — enable per org in Settings → Automations.",
    trigger: "quote.accepted",
    enabled: false,
    actions: ["create_invoice_draft"],
  },
  {
    id: "job_completed_autoinvoice",
    label: "Job completed → auto-draft final invoice",
    description:
      "When a job is completed, generate a DRAFT invoice for the remaining " +
      "stages of its billing plan (never sent — a human reviews and sends). " +
      "Idempotent, and if there's no billing plan it falls back to the " +
      "'suggest an invoice' notification. Off by default — enable per org in " +
      "Settings → Automations.",
    trigger: "job.completed",
    enabled: false,
    actions: ["generate_completion_invoice"],
  },
];

/** Find rules whose trigger matches `type`. */
export function rulesForEvent(
  type: AutomationRule["trigger"],
): ReadonlyArray<AutomationRule> {
  return AUTOMATION_RULES.filter((r) => r.trigger === type);
}

/** Build a stable correlation_id for idempotency. */
export function correlationIdFor(
  type: string,
  source_table: string,
  source_id: string,
): string {
  return `${type}:${source_table}:${source_id}`;
}
