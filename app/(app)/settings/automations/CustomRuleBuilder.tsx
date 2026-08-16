"use client";

import { useMemo, useState } from "react";
import {
  createCustomRuleAction,
  updateCustomRuleAction,
} from "./actions";
import {
  EXPOSABLE_AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_LABELS,
} from "@/lib/automation/events";
import {
  CONDITION_OPERATORS,
  VALUELESS_OPERATORS,
  ARRAY_VALUE_OPERATORS,
  type ConditionOperator,
} from "@/lib/automation/conditions";
import {
  CUSTOM_ACTION_REGISTRY,
  actionSpec,
} from "@/lib/automation/action-registry";

/**
 * The no-code custom-rule builder (client).
 *
 * Composes a CustomRuleDefinition from form state and mirrors it into a hidden
 * `definition` JSON input, submitted to the create/update server action. The
 * SERVER re-validates via validateCustomRuleDefinition (the injection boundary) —
 * this UI is a convenience, never the security gate. Only actions offered by the
 * action registry are selectable, and their params come straight from the registry
 * whitelist, so a user cannot compose an out-of-catalogue action or an unknown
 * param here in the first place.
 */

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "is present",
  not_exists: "is empty",
  in: "is one of (comma-separated)",
  not_in: "is not one of (comma-separated)",
  is_true: "is true",
  is_false: "is false",
};

type LeafRow = { field: string; operator: ConditionOperator; value: string };
type ActionRow = { type: string; params: Record<string, string> };

const CUSTOM_ACTIONS = CUSTOM_ACTION_REGISTRY.filter((s) => s.availableToCustom);

export type BuilderInitial = {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
};

function toRows(def: unknown): {
  trigger: string;
  combinator: "and" | "or";
  conditions: LeafRow[];
  actions: ActionRow[];
  requiresApproval: boolean;
  approvalPosition: number;
} {
  const d = (def ?? {}) as Record<string, unknown>;
  const trigger =
    typeof d.trigger === "string" ? d.trigger : EXPOSABLE_AUTOMATION_TRIGGERS[0];
  const cond = d.conditions as
    | { combinator?: string; conditions?: unknown[] }
    | null
    | undefined;
  const combinator = cond?.combinator === "or" ? "or" : "and";
  const conditions: LeafRow[] = Array.isArray(cond?.conditions)
    ? (cond!.conditions as Record<string, unknown>[])
        .filter((c) => typeof c.field === "string")
        .map((c) => ({
          field: String(c.field),
          operator: (CONDITION_OPERATORS as readonly string[]).includes(
            String(c.operator),
          )
            ? (c.operator as ConditionOperator)
            : "eq",
          value: Array.isArray(c.value)
            ? (c.value as unknown[]).join(", ")
            : c.value === undefined || c.value === null
              ? ""
              : String(c.value),
        }))
    : [];
  const actionsRaw = Array.isArray(d.actions) ? (d.actions as Record<string, unknown>[]) : [];
  const actions: ActionRow[] = actionsRaw.map((a) => {
    const params: Record<string, string> = {};
    const rawParams = (a.params ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawParams)) {
      params[k] = typeof v === "boolean" ? String(v) : String(v ?? "");
    }
    return { type: String(a.type ?? CUSTOM_ACTIONS[0]?.type ?? ""), params };
  });
  return {
    trigger,
    combinator,
    conditions,
    actions:
      actions.length > 0
        ? actions
        : [{ type: CUSTOM_ACTIONS[0]?.type ?? "", params: {} }],
    requiresApproval: Boolean(d.requiresApproval),
    approvalPosition:
      typeof d.approvalPosition === "number" ? d.approvalPosition : 0,
  };
}

export function CustomRuleBuilder({
  initial,
}: {
  initial?: BuilderInitial;
}) {
  const seed = useMemo(() => toRows(initial?.definition), [initial]);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(seed.trigger);
  const [combinator, setCombinator] = useState<"and" | "or">(seed.combinator);
  const [conditions, setConditions] = useState<LeafRow[]>(seed.conditions);
  const [actions, setActions] = useState<ActionRow[]>(seed.actions);
  const [requiresApproval, setRequiresApproval] = useState(seed.requiresApproval);
  const [approvalPosition, setApprovalPosition] = useState(seed.approvalPosition);

  const isEdit = Boolean(initial?.id);

  // Build the definition JSON that the server will re-validate.
  const definitionJson = useMemo(() => {
    const leafNodes = conditions
      .filter((c) => c.field.trim().length > 0)
      .map((c) => {
        const node: Record<string, unknown> = {
          field: c.field.trim(),
          operator: c.operator,
        };
        if (!VALUELESS_OPERATORS.has(c.operator)) {
          node.value = ARRAY_VALUE_OPERATORS.has(c.operator)
            ? c.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : c.value;
        }
        return node;
      });
    const acts = actions
      .filter((a) => a.type.length > 0)
      .map((a) => ({ type: a.type, params: a.params }));
    const pos = requiresApproval ? Math.min(approvalPosition, acts.length) : acts.length;
    return JSON.stringify({
      trigger,
      conditions: leafNodes.length > 0 ? { combinator, conditions: leafNodes } : null,
      actions: acts,
      requiresApproval,
      approvalPosition: pos,
    });
  }, [trigger, combinator, conditions, actions, requiresApproval, approvalPosition]);

  const updateCondition = (i: number, patch: Partial<LeafRow>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const updateAction = (i: number, patch: Partial<ActionRow>) =>
    setActions((as) => as.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const updateActionParam = (i: number, key: string, val: string) =>
    setActions((as) =>
      as.map((a, idx) =>
        idx === i ? { ...a, params: { ...a.params, [key]: val } } : a,
      ),
    );

  const inputCls =
    "rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900";

  return (
    <form
      action={isEdit ? updateCustomRuleAction : createCustomRuleAction}
      className="space-y-5"
    >
      {isEdit ? (
        <input type="hidden" name="rule_id" value={initial!.id} />
      ) : null}
      <input type="hidden" name="definition" value={definitionJson} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Rule name
          <input
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Big quote accepted → alert owner"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          When this happens (trigger)
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className={inputCls}
          >
            {EXPOSABLE_AUTOMATION_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {AUTOMATION_TRIGGER_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Description (optional)
        <input
          name="description"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
      </label>

      {/* Conditions -------------------------------------------------------- */}
      <fieldset className="rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Only if (conditions)
        </legend>
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-600">
          Match
          <select
            value={combinator}
            onChange={(e) => setCombinator(e.target.value as "and" | "or")}
            className={inputCls}
          >
            <option value="and">ALL of</option>
            <option value="or">ANY of</option>
          </select>
          these (leave empty to always run)
        </div>
        <div className="space-y-2">
          {conditions.map((c, i) => {
            const needsValue = !VALUELESS_OPERATORS.has(c.operator);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  value={c.field}
                  onChange={(e) => updateCondition(i, { field: e.target.value })}
                  placeholder="payload field (e.g. amount)"
                  className={`${inputCls} w-48 font-mono`}
                />
                <select
                  value={c.operator}
                  onChange={(e) =>
                    updateCondition(i, {
                      operator: e.target.value as ConditionOperator,
                    })
                  }
                  className={inputCls}
                >
                  {CONDITION_OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </option>
                  ))}
                </select>
                {needsValue ? (
                  <input
                    value={c.value}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder="value"
                    className={`${inputCls} w-40`}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setConditions((cs) => cs.filter((_, idx) => idx !== i))
                  }
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() =>
            setConditions((cs) => [...cs, { field: "", operator: "eq", value: "" }])
          }
          className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          + Add condition
        </button>
      </fieldset>

      {/* Actions ----------------------------------------------------------- */}
      <fieldset className="rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Then do (actions, in order)
        </legend>
        <div className="space-y-3">
          {actions.map((a, i) => {
            const spec = actionSpec(a.type as never);
            return (
              <div key={i} className="rounded-md border border-slate-100 bg-slate-50 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-400">#{i + 1}</span>
                  <select
                    value={a.type}
                    onChange={(e) => updateAction(i, { type: e.target.value, params: {} })}
                    className={inputCls}
                  >
                    {CUSTOM_ACTIONS.map((s) => (
                      <option key={s.type} value={s.type}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <div className="ml-auto flex gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() =>
                        setActions((as) => {
                          if (i === 0) return as;
                          const copy = [...as];
                          [copy[i - 1], copy[i]] = [copy[i]!, copy[i - 1]!];
                          return copy;
                        })
                      }
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === actions.length - 1}
                      onClick={() =>
                        setActions((as) => {
                          if (i === as.length - 1) return as;
                          const copy = [...as];
                          [copy[i + 1], copy[i]] = [copy[i]!, copy[i + 1]!];
                          return copy;
                        })
                      }
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={actions.length <= 1}
                      onClick={() =>
                        setActions((as) => as.filter((_, idx) => idx !== i))
                      }
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {spec && spec.params.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {spec.params.map((p) => (
                      <label
                        key={p.key}
                        className="flex flex-col gap-0.5 text-[11px] text-slate-500"
                      >
                        {p.label}
                        {p.type === "enum" ? (
                          <select
                            value={a.params[p.key] ?? ""}
                            onChange={(e) => updateActionParam(i, p.key, e.target.value)}
                            className={inputCls}
                          >
                            <option value="">(default)</option>
                            {(p.options ?? []).map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : p.type === "boolean" ? (
                          <select
                            value={a.params[p.key] ?? ""}
                            onChange={(e) => updateActionParam(i, p.key, e.target.value)}
                            className={inputCls}
                          >
                            <option value="">(default)</option>
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                          </select>
                        ) : (
                          <input
                            value={a.params[p.key] ?? ""}
                            maxLength={p.maxLength ?? 500}
                            onChange={(e) => updateActionParam(i, p.key, e.target.value)}
                            className={`${inputCls} w-56`}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() =>
            setActions((as) => [
              ...as,
              { type: CUSTOM_ACTIONS[0]?.type ?? "", params: {} },
            ])
          }
          className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          + Add action
        </button>
      </fieldset>

      {/* Approval gate ----------------------------------------------------- */}
      <fieldset className="rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Approval
        </legend>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => setRequiresApproval(e.target.checked)}
          />
          Require a human to approve before some actions run
        </label>
        {requiresApproval ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            Run the first
            <select
              value={approvalPosition}
              onChange={(e) => setApprovalPosition(Number(e.target.value))}
              className={inputCls}
            >
              {Array.from({ length: actions.length + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            action(s) immediately, then wait for approval before the rest.
          </div>
        ) : null}
      </fieldset>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          {isEdit ? "Save changes" : "Create rule"}
        </button>
      </div>
    </form>
  );
}
