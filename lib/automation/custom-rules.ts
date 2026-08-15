/**
 * Automation OS — custom-rule DEFINITION model + validation.
 *
 * A custom rule's tree — conditions + ordered actions + an optional approval gate
 * — is stored as jsonb (automation_custom_rules.definition). This module is the
 * ONLY place that turns untrusted JSON into a trusted CustomRuleDefinition, and it
 * is imported by the server action (validate on write) AND the dispatcher (re-parse
 * on read before dispatch). Nothing else is permitted to hand-roll the shape.
 *
 * THE VALIDATOR IS THE INJECTION BOUNDARY. It enforces, structurally:
 *   · trigger ∈ AUTOMATION_EVENT_TYPES (a known event, not free text at runtime);
 *   · every action type is whitelisted for custom rules (action-registry);
 *   · every action's params are sanitised to the registry whitelist (unknown keys
 *     dropped, enums checked, text length-capped) — params are DATA, never code;
 *   · the condition tree is bounded (depth, breadth) and every operator is known,
 *     every field path is a safe dot-path (no prototype escape);
 *   · the approval position is an in-range integer.
 * A value that fails any check is REJECTED (write) or SKIPPED (dispatch) — never
 * coerced into something dangerous.
 *
 * Pure + client-safe (the builder validates a preview before submit). Uses zod,
 * already a project dependency.
 */

import { z } from "zod";
import {
  AUTOMATION_EVENT_TYPES,
  type AutomationActionType,
  type AutomationEventType,
} from "./events";
import {
  CONDITION_OPERATORS,
  VALUELESS_OPERATORS,
  ARRAY_VALUE_OPERATORS,
  type ConditionGroup,
  type ConditionOperator,
} from "./conditions";
import {
  isCustomAvailableAction,
  sanitizeActionParams,
} from "./action-registry";

export type CustomRuleAction = {
  type: AutomationActionType;
  params: Record<string, string | boolean>;
};

export type CustomRuleDefinition = {
  trigger: AutomationEventType;
  conditions: ConditionGroup | null;
  /** Ordered. Actions before `approvalPosition` run on trigger; the rest on approval. */
  actions: CustomRuleAction[];
  requiresApproval: boolean;
  /** How many leading actions run immediately before the approval gate (0..len). */
  approvalPosition: number;
};

/** Bounds — kept modest so a rule stays comprehensible and cheap to evaluate. */
export const MAX_CONDITION_DEPTH = 4;
export const MAX_CONDITIONS = 25;
export const MAX_ACTIONS = 10;
export const MAX_FIELD_LEN = 120;

/** A safe dot-path field: alphanumerics, underscore, dot. No prototype escape. */
const FIELD_RX = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function fieldIsSafe(field: string): boolean {
  if (field.length === 0 || field.length > MAX_FIELD_LEN) return false;
  if (!FIELD_RX.test(field)) return false;
  return field.split(".").every((seg) => !FORBIDDEN_SEGMENTS.has(seg));
}

// A JSON scalar or a (bounded) array of scalars — the only shapes a leaf `value`
// may take. Objects are rejected: a comparand is never a nested structure.
const scalarSchema = z.union([z.string().max(500), z.number(), z.boolean()]);
const valueSchema = z
  .union([scalarSchema, z.array(scalarSchema).max(50)])
  .optional();

const leafSchema = z
  .object({
    field: z.string().refine(fieldIsSafe, "unsafe or malformed field path"),
    operator: z.enum(
      CONDITION_OPERATORS as unknown as [ConditionOperator, ...ConditionOperator[]],
    ),
    value: valueSchema,
  })
  .superRefine((leaf, ctx) => {
    const op = leaf.operator;
    if (VALUELESS_OPERATORS.has(op)) return; // value ignored
    if (leaf.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${op}" needs a value` });
      return;
    }
    if (ARRAY_VALUE_OPERATORS.has(op) && !Array.isArray(leaf.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${op}" needs a list value` });
    }
  });

// Recursive group schema with a hard depth + breadth cap. z.lazy handles the
// self-reference; the manual depth walk (below) is the belt-and-braces bound the
// type system can't express.
type RawNode = z.infer<typeof leafSchema> | { combinator: "and" | "or"; conditions: RawNode[] };
const groupSchema: z.ZodType<RawNode> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({
      combinator: z.enum(["and", "or"]),
      conditions: z.array(groupSchema).max(MAX_CONDITIONS),
    }),
  ]),
);

function isRawGroup(
  n: RawNode,
): n is { combinator: "and" | "or"; conditions: RawNode[] } {
  return (n as { combinator?: unknown }).combinator === "and" || (n as { combinator?: unknown }).combinator === "or";
}

/** Count nodes + assert depth ≤ MAX. Returns null if the tree is too deep/broad. */
function boundsOk(node: RawNode, depth: number, counter: { n: number }): boolean {
  if (depth > MAX_CONDITION_DEPTH) return false;
  if (isRawGroup(node)) {
    for (const child of node.conditions) {
      if (!boundsOk(child, depth + 1, counter)) return false;
    }
    return true;
  }
  counter.n += 1;
  return counter.n <= MAX_CONDITIONS;
}

const actionSchema = z.object({
  type: z.string(),
  params: z.record(z.unknown()).optional(),
});

const definitionSchema = z.object({
  trigger: z.enum(
    AUTOMATION_EVENT_TYPES as unknown as [AutomationEventType, ...AutomationEventType[]],
  ),
  conditions: groupSchema.nullable().optional(),
  actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  requiresApproval: z.boolean().optional(),
  approvalPosition: z.number().int().min(0).optional(),
});

export type ValidationResult =
  | { ok: true; value: CustomRuleDefinition }
  | { ok: false; error: string };

/**
 * Validate + normalise an untrusted definition into a trusted
 * CustomRuleDefinition. The single chokepoint: every path in and out of the
 * feature that turns JSON into a runnable rule goes through here.
 */
export function validateCustomRuleDefinition(raw: unknown): ValidationResult {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid rule" };
  }
  const d = parsed.data;

  // Condition tree: enforce depth/breadth beyond zod's per-level cap.
  let conditions: ConditionGroup | null = null;
  if (d.conditions !== null && d.conditions !== undefined) {
    if (!isRawGroup(d.conditions)) {
      // A lone leaf is not a valid TOP node — the root must be an AND/OR group.
      return { ok: false, error: "conditions must be an and/or group" };
    }
    const counter = { n: 0 };
    if (!boundsOk(d.conditions, 1, counter)) {
      return {
        ok: false,
        error: `conditions exceed limits (max depth ${MAX_CONDITION_DEPTH}, max ${MAX_CONDITIONS} conditions)`,
      };
    }
    conditions = d.conditions as unknown as ConditionGroup;
  }

  // Actions: every type whitelisted for custom rules; params sanitised.
  const actions: CustomRuleAction[] = [];
  for (const a of d.actions) {
    if (!isCustomAvailableAction(a.type)) {
      return { ok: false, error: `action "${a.type}" is not allowed in custom rules` };
    }
    const type = a.type as AutomationActionType;
    actions.push({ type, params: sanitizeActionParams(type, a.params ?? {}) });
  }

  const requiresApproval = d.requiresApproval ?? false;
  let approvalPosition = d.approvalPosition ?? 0;
  if (!requiresApproval) {
    approvalPosition = actions.length; // no gate → all actions run immediately
  } else if (approvalPosition > actions.length) {
    return { ok: false, error: "approval position is out of range" };
  }

  return {
    ok: true,
    value: {
      trigger: d.trigger,
      conditions,
      actions,
      requiresApproval,
      approvalPosition,
    },
  };
}

/** Actions that run the instant the trigger fires (before the approval gate). */
export function immediateActions(def: CustomRuleDefinition): CustomRuleAction[] {
  return def.requiresApproval
    ? def.actions.slice(0, def.approvalPosition)
    : def.actions;
}

/** Actions that run only after a human approves (after the gate). */
export function downstreamActions(def: CustomRuleDefinition): CustomRuleAction[] {
  return def.requiresApproval ? def.actions.slice(def.approvalPosition) : [];
}
