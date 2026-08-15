import { describe, it, expect } from "vitest";
import {
  validateCustomRuleDefinition,
  immediateActions,
  downstreamActions,
  MAX_ACTIONS,
  MAX_CONDITION_DEPTH,
} from "@/lib/automation/custom-rules";
import {
  sanitizeActionParams,
  isCustomAvailableAction,
  CUSTOM_AVAILABLE_ACTION_TYPES,
} from "@/lib/automation/action-registry";

/**
 * Custom-rule validation — THE INJECTION BOUNDARY.
 *
 * validateCustomRuleDefinition is the only path that turns untrusted JSON into a
 * runnable rule. These tests pin the properties that keep params DATA, never code:
 * whitelisted actions, sanitised params, bounded condition trees, safe field
 * paths, and an in-range approval position.
 */

const okBase = {
  trigger: "quote.accepted",
  actions: [{ type: "create_notification", params: { priority: "high" } }],
};

describe("validateCustomRuleDefinition — happy path", () => {
  it("accepts a well-formed rule and normalises params", () => {
    const r = validateCustomRuleDefinition({
      ...okBase,
      conditions: {
        combinator: "and",
        conditions: [{ field: "amount", operator: "gt", value: 1000 }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.trigger).toBe("quote.accepted");
    expect(r.value.actions[0]!.type).toBe("create_notification");
    expect(r.value.actions[0]!.params.priority).toBe("high");
    // No approval → position defaults to run-all-immediately.
    expect(r.value.requiresApproval).toBe(false);
    expect(r.value.approvalPosition).toBe(r.value.actions.length);
  });

  it("accepts a null (ungated) condition tree", () => {
    const r = validateCustomRuleDefinition({ ...okBase, conditions: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.conditions).toBeNull();
  });
});

describe("validateCustomRuleDefinition — rejects unsafe input", () => {
  it("rejects an unknown trigger", () => {
    const r = validateCustomRuleDefinition({ ...okBase, trigger: "hack.event" });
    expect(r.ok).toBe(false);
  });

  it("rejects an action type not whitelisted for custom rules (update_status)", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "update_status", params: {} }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not allowed/);
  });

  it("rejects a completely made-up action type", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "exec_shell", params: { cmd: "rm -rf /" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("STRIPS unknown params, keeping only the registry whitelist", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [
        {
          type: "create_notification",
          params: {
            title: "hi",
            priority: "high",
            // hostile / unknown keys — must be dropped
            to: "attacker@evil.test",
            sql: "DROP TABLE quotes;",
            __proto__: { polluted: true },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const params = r.value.actions[0]!.params;
    expect(params).toHaveProperty("title", "hi");
    expect(params).toHaveProperty("priority", "high");
    expect(params).not.toHaveProperty("to");
    expect(params).not.toHaveProperty("sql");
  });

  it("send_email_queue can NEVER carry a free-text recipient (no `to`)", () => {
    const r = validateCustomRuleDefinition({
      trigger: "payment.recorded",
      actions: [
        { type: "send_email_queue", params: { to: "attacker@evil.test", audience: "customer" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const params = r.value.actions[0]!.params;
    expect(params).not.toHaveProperty("to");
    expect(params).toHaveProperty("audience", "customer");
  });

  it("rejects an enum param outside its options", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "create_notification", params: { priority: "SUPER-CRITICAL" } }],
    });
    // The bad enum is stripped (not persisted) but the rule itself is valid.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]!.params).not.toHaveProperty("priority");
  });

  it("caps text params at the registry maxLength", () => {
    const long = "x".repeat(5000);
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "add_internal_note", params: { note: long } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value.actions[0]!.params.note as string).length).toBe(500);
  });

  it("rejects an unsafe / prototype field path in a condition", () => {
    const r = validateCustomRuleDefinition({
      ...okBase,
      conditions: {
        combinator: "and",
        conditions: [{ field: "__proto__.polluted", operator: "eq", value: 1 }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown operator", () => {
    const r = validateCustomRuleDefinition({
      ...okBase,
      conditions: {
        combinator: "and",
        conditions: [{ field: "amount", operator: "regex", value: ".*" }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects too many actions", () => {
    const actions = Array.from({ length: MAX_ACTIONS + 1 }, () => ({
      type: "create_notification",
      params: {},
    }));
    const r = validateCustomRuleDefinition({ trigger: "quote.accepted", actions });
    expect(r.ok).toBe(false);
  });

  it("rejects a condition tree deeper than the depth cap", () => {
    // Build a chain of nested groups deeper than MAX_CONDITION_DEPTH.
    let node: unknown = { field: "amount", operator: "gt", value: 1 };
    for (let i = 0; i < MAX_CONDITION_DEPTH + 2; i++) {
      node = { combinator: "and", conditions: [node] };
    }
    const r = validateCustomRuleDefinition({ ...okBase, conditions: node });
    expect(r.ok).toBe(false);
  });

  it("rejects a top-level condition that is a bare leaf (root must be a group)", () => {
    const r = validateCustomRuleDefinition({
      ...okBase,
      conditions: { field: "amount", operator: "gt", value: 1 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range approval position", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "create_notification", params: {} }],
      requiresApproval: true,
      approvalPosition: 5,
    });
    expect(r.ok).toBe(false);
  });
});

describe("immediate vs downstream action split (the approval node)", () => {
  it("splits actions at the approval position", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [
        { type: "add_internal_note", params: {} },
        { type: "create_invoice_draft", params: {} },
        { type: "send_email_queue", params: {} },
      ],
      requiresApproval: true,
      approvalPosition: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(immediateActions(r.value).map((a) => a.type)).toEqual(["add_internal_note"]);
    expect(downstreamActions(r.value).map((a) => a.type)).toEqual([
      "create_invoice_draft",
      "send_email_queue",
    ]);
  });

  it("with no approval, everything is immediate and nothing is downstream", () => {
    const r = validateCustomRuleDefinition(okBase);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(immediateActions(r.value)).toHaveLength(1);
    expect(downstreamActions(r.value)).toHaveLength(0);
  });
});

describe("action registry helpers", () => {
  it("update_status is not custom-available; the wired actions are", () => {
    expect(isCustomAvailableAction("update_status")).toBe(false);
    expect(isCustomAvailableAction("create_notification")).toBe(true);
    expect(CUSTOM_AVAILABLE_ACTION_TYPES).not.toContain("update_status");
    expect(CUSTOM_AVAILABLE_ACTION_TYPES).toContain("send_email_queue");
  });

  it("sanitizeActionParams returns {} for a non-available action", () => {
    expect(sanitizeActionParams("update_status", { anything: "x" })).toEqual({});
  });

  it("sanitizeActionParams drops unknown keys and bad enums, keeps valid", () => {
    const out = sanitizeActionParams("create_notification", {
      title: "  hello  ",
      priority: "medium",
      audience: "nope",
      junk: "x",
    });
    expect(out).toEqual({ title: "hello", priority: "medium" });
  });
});
