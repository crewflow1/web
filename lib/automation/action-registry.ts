/**
 * Automation OS — the ACTION REGISTRY for user-composed custom rules.
 *
 * A no-code rule lets an author pick actions and fill in their params. This
 * registry declares, per action type, whether it is offered to custom rules and
 * EXACTLY which params it accepts. It is the single source of truth the builder UI
 * renders from and the validator checks against, so the set of user-reachable
 * params is defined in ONE place.
 *
 * ── THE INJECTION BOUNDARY ───────────────────────────────────────────────────
 * This is the security spine of the feature. Custom-rule params are DATA, never
 * code. The rules that make that true:
 *
 *   1. WHITELISTED ACTIONS. Only `availableToCustom` action types may appear in a
 *      custom rule. `update_status` is deliberately excluded — it is a documented
 *      no-op with no safe generic status-mutation authority (see the dispatcher).
 *   2. WHITELISTED PARAM KEYS. An action may carry ONLY the keys declared here.
 *      The validator strips everything else, so no unknown key ever reaches a
 *      handler.
 *   3. BOUNDED VALUES. `enum` params accept only their declared options; `text`
 *      params are length-capped; `boolean` params are booleans. No param is ever
 *      used as an identifier, a table name, a SQL fragment, or a free-form email
 *      recipient — they only become display copy (titles/notes) or bounded enums
 *      (priority/audience) handed to already-safe authorities.
 *
 * Reuses AUTOMATION_ACTION_TYPES verbatim — a custom rule dispatches the SAME
 * wired handlers the built-in catalogue does; it just gets to choose their params.
 */

import type { AutomationActionType } from "./events";

export type ParamType = "text" | "enum" | "boolean";

export type ParamOption = { value: string; label: string };

export type ParamSpec = {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  /** enum only — the ONLY values accepted. */
  options?: ReadonlyArray<ParamOption>;
  /** text only — hard cap enforced by the validator. */
  maxLength?: number;
  help?: string;
};

export type CustomActionSpec = {
  type: AutomationActionType;
  label: string;
  description: string;
  /** Whether this action is offered to user-composed custom rules. */
  availableToCustom: boolean;
  /** The complete whitelist of params this action may carry. */
  params: ReadonlyArray<ParamSpec>;
};

const PRIORITY_OPTIONS: ReadonlyArray<ParamOption> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const AUDIENCE_OPTIONS: ReadonlyArray<ParamOption> = [
  { value: "customer", label: "My team" },
  { value: "hq", label: "CrewFlow HQ" },
];

/**
 * The action catalogue. Each entry declares its param whitelist. NOTE the two
 * deliberately-constrained wired actions:
 *   · send_email_queue offers ONLY an audience enum — never a free-text recipient,
 *     so a custom rule can never be used to exfiltrate mail to an arbitrary
 *     address. Recipient resolution stays the engine's org-scoped default.
 *   · create_invoice_draft takes NO params — it acts only on quote-sourced events
 *     and reuses the guarded quote→draft-invoice authority.
 */
export const CUSTOM_ACTION_REGISTRY: ReadonlyArray<CustomActionSpec> = [
  {
    type: "create_notification",
    label: "Send an in-app notification",
    description: "Post a notification to the chosen audience.",
    availableToCustom: true,
    params: [
      {
        key: "title",
        label: "Title (optional)",
        type: "text",
        maxLength: 200,
        help: "Leave blank to use the default wording for this event.",
      },
      {
        key: "priority",
        label: "Priority",
        type: "enum",
        options: PRIORITY_OPTIONS,
      },
      {
        key: "audience",
        label: "Notify",
        type: "enum",
        options: AUDIENCE_OPTIONS,
      },
    ],
  },
  {
    type: "send_email_queue",
    label: "Queue an email",
    description:
      "Queue an email to the chosen audience through CrewFlow's email pipeline.",
    availableToCustom: true,
    params: [
      {
        key: "audience",
        label: "Send to",
        type: "enum",
        options: AUDIENCE_OPTIONS,
      },
    ],
  },
  {
    type: "add_internal_note",
    label: "Add an internal note",
    description: "Record an internal note on the audit trail.",
    availableToCustom: true,
    params: [
      { key: "note", label: "Note (optional)", type: "text", maxLength: 500 },
    ],
  },
  {
    type: "create_alert",
    label: "Raise an alert",
    description: "Raise an alert on the audit trail.",
    availableToCustom: true,
    params: [
      { key: "note", label: "Note (optional)", type: "text", maxLength: 500 },
    ],
  },
  {
    type: "create_milestone",
    label: "Record a milestone",
    description: "Record a milestone signal.",
    availableToCustom: true,
    params: [
      { key: "note", label: "Note (optional)", type: "text", maxLength: 500 },
    ],
  },
  {
    type: "create_invoice_draft",
    label: "Create a draft invoice",
    description:
      "For quote events only: ensure a draft invoice exists for the quote.",
    availableToCustom: true,
    params: [],
  },
  {
    type: "update_status",
    label: "Update status",
    description:
      "Not available in custom rules — there is no safe generic status authority.",
    availableToCustom: false,
    params: [],
  },
  {
    type: "generate_completion_invoice",
    label: "Auto-draft final invoice on job completion",
    description:
      "Not available in custom rules — it acts only on job.completed events and " +
      "reuses the guarded billing-plan stage-invoice authority.",
    availableToCustom: false,
    params: [],
  },
];

const BY_TYPE: ReadonlyMap<AutomationActionType, CustomActionSpec> = new Map(
  CUSTOM_ACTION_REGISTRY.map((s) => [s.type, s]),
);

/** The action types a custom rule is allowed to use. */
export const CUSTOM_AVAILABLE_ACTION_TYPES: ReadonlyArray<AutomationActionType> =
  CUSTOM_ACTION_REGISTRY.filter((s) => s.availableToCustom).map((s) => s.type);

export function actionSpec(
  type: AutomationActionType,
): CustomActionSpec | undefined {
  return BY_TYPE.get(type);
}

export function isCustomAvailableAction(type: string): boolean {
  const s = BY_TYPE.get(type as AutomationActionType);
  return Boolean(s?.availableToCustom);
}

/**
 * Sanitise a raw param object against an action's whitelist. Returns ONLY the
 * declared, well-typed params — unknown keys dropped, enums checked against their
 * options, text trimmed + length-capped, booleans coerced. This is called at
 * write time (validation) AND before execution (defence in depth), so a param
 * that somehow slipped past one gate is still neutralised at the other.
 */
export function sanitizeActionParams(
  type: AutomationActionType,
  raw: unknown,
): Record<string, string | boolean> {
  const spec = BY_TYPE.get(type);
  if (!spec || !spec.availableToCustom) return {};
  const src: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string | boolean> = {};

  for (const p of spec.params) {
    const v = src[p.key];
    if (v === undefined || v === null) continue;
    if (p.type === "boolean") {
      if (typeof v === "boolean") out[p.key] = v;
      else if (v === "true") out[p.key] = true;
      else if (v === "false") out[p.key] = false;
      continue;
    }
    if (p.type === "enum") {
      const allowed = new Set((p.options ?? []).map((o) => o.value));
      if (typeof v === "string" && allowed.has(v)) out[p.key] = v;
      continue;
    }
    // text
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      const cap = p.maxLength ?? 500;
      out[p.key] = trimmed.slice(0, cap);
    }
  }
  return out;
}
