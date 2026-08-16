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

/**
 * The trigger events an org may compose a CUSTOM rule on — a BUILD-TIME data
 * boundary, mirroring the outbound-webhooks discipline (lib/webhooks/events.ts).
 *
 * `AUTOMATION_EVENT_TYPES` above is the FULL event vocabulary: it stays stable
 * because `automation_runs.event_type` indexes it and a dispatched event may
 * carry any of these verbs. But the custom-rule BUILDER must only offer verbs a
 * real producer actually fires — otherwise a user composes a rule on, say,
 * `invoice.created`, the builder advertises it as live, and it can never run
 * because no `dispatchAutomation({ type: "invoice.created" })` exists. That is the
 * "phantom rule" class the drift-guard test
 * (__tests__/security/automation-phantom-rules.test.ts) exists to prevent for the
 * built-in catalogue; this list extends the same honesty to user-composed rules.
 *
 * A verb is exposable IFF a real literal producer dispatches it from the entity's
 * own transition, WITH COMPLETE coverage of that transition's write paths:
 *   · onboarding.completed  — markCompleted (onboarding/setup/actions.ts)
 *   · import.completed       — import commit (imports/actions.ts)
 *   · quote.sent             — sendQuote (quotes/actions.ts; the sole send path)
 *   · quote.accepted         — operator + portal-token + e-sign paths
 *   · quote.declined         — declineQuoteAsOwner + declineQuoteByToken
 *   · lead.created           — receptionist lead capture
 *   · job.completed          — createJob + updateJob (status→completed)
 *   · invoice.overdue        — the overdue scheduler (cron; the only transition)
 *   · payment.recorded       — the three payment record paths
 *   · support.ticket.created — operator + all portal ticket creators
 *
 * NOT exposed, and why (each has NO producer, or only partial write-path
 * coverage, so a rule on it would silently never fire — or fire on only some of
 * the writes that reach its state):
 *   · quote.created / invoice.created / job.created — created down MANY write
 *     paths (operator, CSV import, public API v1, sample-data, AI writer); no
 *     single producer covers them, so exposing one would be a partial-coverage
 *     phantom. Wiring every path is a producer + data-boundary decision.
 *   · support.ticket.replied — no reply producer exists.
 *   · milestone.reached      — milestones are computed from RetentionSignals and
 *     emitted on dashboard render (server/services/retention-milestones.ts); there
 *     is no imperative "milestone reached" dispatch to watch.
 *   · account.created        — signup has no org-scoped automation producer.
 *   · demo.booked / demo.approved — demos live in a GLOBAL HQ table with no tenant
 *     org_id at booking time; the org-scoped engine has no org to attribute them
 *     to (see the demo_booked_notify_hq annotation in rules.ts).
 *
 * The drift-guard test asserts EVERY entry here has a real literal producer, so
 * re-adding a verb without wiring its producer fails CI. The builder renders its
 * trigger dropdown from this list and the create/update server action rejects a
 * non-exposable trigger, so a custom rule can never be composed on a verb the
 * engine would never fire.
 */
export const EXPOSABLE_AUTOMATION_TRIGGERS = [
  "quote.sent",
  "quote.accepted",
  "quote.declined",
  "lead.created",
  "job.completed",
  "invoice.overdue",
  "payment.recorded",
  "support.ticket.created",
  "onboarding.completed",
  "import.completed",
] as const satisfies readonly AutomationEventType[];

export type ExposableAutomationTrigger =
  (typeof EXPOSABLE_AUTOMATION_TRIGGERS)[number];

const EXPOSABLE_TRIGGER_SET: ReadonlySet<string> = new Set(
  EXPOSABLE_AUTOMATION_TRIGGERS,
);

/** Runtime guard — may an org compose a custom rule on this trigger verb? */
export function isExposableAutomationTrigger(
  value: string,
): value is ExposableAutomationTrigger {
  return EXPOSABLE_TRIGGER_SET.has(value);
}

/** Human labels for the builder's trigger dropdown, keyed so a verb cannot be
 *  offered without one. */
export const AUTOMATION_TRIGGER_LABELS: Readonly<
  Record<ExposableAutomationTrigger, string>
> = {
  "quote.sent": "Quote sent to customer",
  "quote.accepted": "Quote accepted",
  "quote.declined": "Quote declined",
  "lead.created": "New lead captured",
  "job.completed": "Job marked complete",
  "invoice.overdue": "Invoice overdue",
  "payment.recorded": "Payment recorded",
  "support.ticket.created": "Support ticket opened",
  "onboarding.completed": "Onboarding completed",
  "import.completed": "Migration/import completed",
};

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
