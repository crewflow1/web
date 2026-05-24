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
  {
    id: "demo_booked_notify_hq",
    label: "Demo booked",
    description: "When a prospect books a demo, notify HQ.",
    trigger: "demo.booked",
    enabled: true,
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
