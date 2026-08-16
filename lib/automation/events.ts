/**
 * Automation OS — pure event registry.
 *
 * Importable everywhere (server + client). Just types + constants.
 * The server-side dispatcher + rule catalogue live next door at
 * `server/services/automation-dispatcher.ts`.
 *
 * Event-type design:
 *   - Stable string ids. Renaming an id is a schema change because
 *     `automation_runs.event_type` indexes it.
 *   - Past tense: `quote.accepted`, NOT `accept_quote`.
 *   - Source-table + source-id always present so the dispatcher can
 *     build a stable correlation_id for idempotency.
 */

export const AUTOMATION_EVENT_TYPES = [
  "demo.booked",
  "demo.approved",
  "account.created",
  "onboarding.completed",
  "import.completed",
  "quote.created",
  "quote.sent",
  "quote.accepted",
  "quote.declined",
  "lead.created",
  "job.created",
  "job.completed",
  "invoice.created",
  "invoice.overdue",
  "payment.recorded",
  "support.ticket.created",
  "support.ticket.replied",
  "milestone.reached",
] as const;

export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number];

export type AutomationEvent<P = Record<string, unknown>> = {
  type: AutomationEventType;
  org_id: string;
  /** The table the row that triggered this event lives in. Used
   *  alongside `source_id` to build the dispatcher's correlation_id. */
  source_table: string;
  source_id: string;
  /** Free-form payload. Action handlers can pull fields they need. */
  payload: P;
  /** Actor email if known (best-effort). */
  actor_email?: string | null;
};

/**
 * Action types the dispatcher knows how to execute. Stable strings —
 * the rule catalogue references these by name.
 */
export const AUTOMATION_ACTION_TYPES = [
  "create_notification",
  "send_email_queue",
  "create_invoice_draft",
  // Job-completion only: generate DRAFT invoices for the remaining stages of a
  // completed job's active billing plan, reusing the guarded stage-invoice
  // authority. Never sends. NOT offered to custom rules (see action-registry).
  "generate_completion_invoice",
  "create_alert",
  "add_internal_note",
  "update_status",
  "create_milestone",
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/**
 * One built-in rule. v1 has no user-editable rules — the catalogue
 * is hardcoded in `lib/automation/rules.ts` (next).
 */
export type AutomationRule = {
  /** Stable id. Used as automation_runs.rule_id. */
  id: string;
  /** Human-readable label for /admin/automations. */
  label: string;
  /** Short description rendered on the page. */
  description: string;
  /** The event type that triggers this rule. */
  trigger: AutomationEventType;
  /** When false, the dispatcher records `status='skipped'` and
   *  no actions run. Hardcoded for v1; user toggles land later. */
  enabled: boolean;
  /** Ordered list of action types this rule executes. */
  actions: ReadonlyArray<AutomationActionType>;
};
