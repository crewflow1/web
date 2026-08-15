/**
 * Automation OS — the condition evaluator (pure, deterministic, no I/O).
 *
 * A custom rule may gate its actions behind a CONDITION TREE evaluated against
 * the triggering event's payload: leaf conditions (field / operator / value)
 * combined by AND/OR groups that nest. This module is the truth-function; it is
 * importable on the client (the builder previews it) and the server (the
 * dispatcher runs it), so it holds ONLY types + pure functions.
 *
 * DETERMINISM. Same (tree, payload) → same boolean, on every machine, always.
 * No clock, no randomness, no I/O. That is what makes the engine fully unit-
 * testable as a truth table.
 *
 * FAIL-CLOSED. A condition that cannot be evaluated cleanly (a malformed leaf, a
 * bad path, a non-object payload) contributes `false`, never `true`. An automation
 * has SIDE EFFECTS; the safe default when we are unsure is "do not fire". An empty
 * tree (no conditions) is the ONE explicit "always fire" — that is a rule the
 * author deliberately wrote with no gate, not an ambiguous state.
 *
 * NO CODE EXECUTION. `field` is a dot-path READ into a plain object. Path segments
 * that could reach the prototype chain (`__proto__`, `prototype`, `constructor`)
 * are refused, so a crafted field can never escape the payload it is handed.
 */

import type { Json } from "@/lib/supabase/types";

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "exists",
  "not_exists",
  "in",
  "not_in",
  "is_true",
  "is_false",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that need no `value` (they test presence/truthiness of the field). */
export const VALUELESS_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  "exists",
  "not_exists",
  "is_true",
  "is_false",
]);

/** Operators whose `value` must be an array. */
export const ARRAY_VALUE_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  "in",
  "not_in",
]);

export type LeafCondition = {
  /** Dot-path into the event payload, e.g. "amount" or "customer.email". */
  field: string;
  operator: ConditionOperator;
  /** Comparand. Absent for VALUELESS_OPERATORS. */
  value?: Json;
};

export type ConditionCombinator = "and" | "or";

export type ConditionGroup = {
  combinator: ConditionCombinator;
  conditions: Array<LeafCondition | ConditionGroup>;
};

/** Defence-in-depth recursion cap; validation enforces a tighter tree depth. */
const MAX_EVAL_DEPTH = 8;

/** Path segments that must never be traversed (prototype-pollution guard). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function isGroup(node: LeafCondition | ConditionGroup): node is ConditionGroup {
  return (
    typeof (node as ConditionGroup).combinator === "string" &&
    Array.isArray((node as ConditionGroup).conditions)
  );
}

/**
 * Read a dot-path out of a plain object. Own-enumerable properties only; any
 * forbidden segment aborts to `undefined`. Never throws.
 */
export function resolvePath(payload: unknown, path: string): unknown {
  if (typeof path !== "string" || path.length === 0) return undefined;
  let cur: unknown = payload;
  for (const rawSeg of path.split(".")) {
    const seg = rawSeg.trim();
    if (seg.length === 0 || FORBIDDEN_KEYS.has(seg)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Coerce to a finite number, or null. Booleans are NOT numbers here. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Loose equality: numeric when both sides are numeric, else string identity. */
function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return toBool(a) === toBool(b);
  }
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a) === String(b);
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Evaluate a single leaf against the payload. Never throws; fail-closed. */
export function evaluateLeaf(
  leaf: LeafCondition,
  payload: Record<string, unknown>,
): boolean {
  const op = leaf.operator;
  const fieldVal = resolvePath(payload, leaf.field);
  const confVal = leaf.value;

  switch (op) {
    case "exists":
      return fieldVal !== undefined && fieldVal !== null;
    case "not_exists":
      return fieldVal === undefined || fieldVal === null;
    case "is_true":
      return toBool(fieldVal) === true;
    case "is_false":
      return toBool(fieldVal) === false;
    case "eq":
      return looseEq(fieldVal, confVal);
    case "neq":
      return !looseEq(fieldVal, confVal);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNum(fieldVal);
      const b = toNum(confVal);
      if (a === null || b === null) return false;
      return op === "gt"
        ? a > b
        : op === "gte"
          ? a >= b
          : op === "lt"
            ? a < b
            : a <= b;
    }
    case "contains":
      if (fieldVal === undefined || fieldVal === null) return false;
      return String(fieldVal).includes(String(confVal ?? ""));
    case "not_contains":
      if (fieldVal === undefined || fieldVal === null) return true;
      return !String(fieldVal).includes(String(confVal ?? ""));
    case "starts_with":
      if (fieldVal === undefined || fieldVal === null) return false;
      return String(fieldVal).startsWith(String(confVal ?? ""));
    case "ends_with":
      if (fieldVal === undefined || fieldVal === null) return false;
      return String(fieldVal).endsWith(String(confVal ?? ""));
    case "in":
      return Array.isArray(confVal) && confVal.some((v) => looseEq(fieldVal, v));
    case "not_in":
      return !(Array.isArray(confVal) && confVal.some((v) => looseEq(fieldVal, v)));
    default:
      // Unknown operator (should be impossible after validation) → fail-closed.
      return false;
  }
}

/**
 * Evaluate a condition tree against an event payload.
 *
 * - `null` / an empty group → `true` (an ungated rule fires unconditionally).
 * - AND → every child must pass; OR → at least one child must pass.
 * - Any structural malformation contributes `false` (fail-closed).
 */
export function evaluateConditions(
  tree: ConditionGroup | null | undefined,
  payload: unknown,
  depth = 0,
): boolean {
  if (tree === null || tree === undefined) return true;
  if (depth > MAX_EVAL_DEPTH) return false;

  const obj: Record<string, unknown> =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  if (
    (tree.combinator !== "and" && tree.combinator !== "or") ||
    !Array.isArray(tree.conditions)
  ) {
    return false;
  }
  // No children → the group is vacuously satisfied (an empty gate = always fire).
  if (tree.conditions.length === 0) return true;

  const results = tree.conditions.map((node) => {
    if (node === null || typeof node !== "object") return false;
    return isGroup(node)
      ? evaluateConditions(node, obj, depth + 1)
      : evaluateLeaf(node as LeafCondition, obj);
  });

  return tree.combinator === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}
