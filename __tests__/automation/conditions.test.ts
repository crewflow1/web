import { describe, it, expect } from "vitest";
import {
  evaluateConditions,
  evaluateLeaf,
  resolvePath,
  CONDITION_OPERATORS,
  type ConditionGroup,
  type LeafCondition,
} from "@/lib/automation/conditions";

/**
 * The condition evaluator — a deterministic truth table.
 *
 * The evaluator is the gate that decides whether a custom rule fires. It is pure
 * (no I/O, no clock), so it can be pinned as an exhaustive truth table: every
 * operator, the AND/OR algebra, the empty-tree "always fire", the fail-closed
 * posture on malformed input, and the prototype-pollution guard on field paths.
 */

const P = {
  amount: 1500,
  status: "accepted",
  currency: "GBP",
  vip: true,
  archived: false,
  tags: ["gold", "priority"],
  customer: { email: "a@b.test", tier: "gold" },
  note: "",
};

describe("resolvePath — safe dot-path reads", () => {
  it("reads shallow + nested own properties", () => {
    expect(resolvePath(P, "amount")).toBe(1500);
    expect(resolvePath(P, "customer.email")).toBe("a@b.test");
  });
  it("returns undefined for missing paths, never throws", () => {
    expect(resolvePath(P, "missing")).toBeUndefined();
    expect(resolvePath(P, "customer.missing.deep")).toBeUndefined();
    expect(resolvePath(null, "x")).toBeUndefined();
    expect(resolvePath(P, "")).toBeUndefined();
  });
  it("refuses prototype-chain segments (pollution guard)", () => {
    expect(resolvePath(P, "__proto__")).toBeUndefined();
    expect(resolvePath(P, "constructor")).toBeUndefined();
    expect(resolvePath(P, "customer.__proto__.polluted")).toBeUndefined();
  });
});

describe("evaluateLeaf — every operator", () => {
  const cases: Array<[LeafCondition, boolean]> = [
    // equality (numeric + string coercion)
    [{ field: "amount", operator: "eq", value: 1500 }, true],
    [{ field: "amount", operator: "eq", value: "1500" }, true], // string coerces
    [{ field: "amount", operator: "eq", value: 1499 }, false],
    [{ field: "status", operator: "eq", value: "accepted" }, true],
    [{ field: "status", operator: "neq", value: "declined" }, true],
    [{ field: "status", operator: "neq", value: "accepted" }, false],
    // ordering
    [{ field: "amount", operator: "gt", value: 1000 }, true],
    [{ field: "amount", operator: "gt", value: 1500 }, false],
    [{ field: "amount", operator: "gte", value: 1500 }, true],
    [{ field: "amount", operator: "lt", value: 2000 }, true],
    [{ field: "amount", operator: "lte", value: 1500 }, true],
    [{ field: "status", operator: "gt", value: 5 }, false], // non-numeric → false
    // string ops
    [{ field: "status", operator: "contains", value: "cept" }, true],
    [{ field: "status", operator: "not_contains", value: "xyz" }, true],
    [{ field: "status", operator: "starts_with", value: "acc" }, true],
    [{ field: "status", operator: "ends_with", value: "ted" }, true],
    // presence
    [{ field: "amount", operator: "exists" }, true],
    [{ field: "missing", operator: "exists" }, false],
    [{ field: "missing", operator: "not_exists" }, true],
    [{ field: "amount", operator: "not_exists" }, false],
    // booleans
    [{ field: "vip", operator: "is_true" }, true],
    [{ field: "archived", operator: "is_false" }, true],
    [{ field: "vip", operator: "is_false" }, false],
    // membership
    [{ field: "currency", operator: "in", value: ["GBP", "EUR"] }, true],
    [{ field: "currency", operator: "in", value: ["EUR", "USD"] }, false],
    [{ field: "currency", operator: "not_in", value: ["EUR", "USD"] }, true],
    // in with a non-array value fails closed
    [{ field: "currency", operator: "in", value: "GBP" }, false],
  ];

  for (const [leaf, expected] of cases) {
    it(`${leaf.field} ${leaf.operator} ${JSON.stringify(leaf.value)} → ${expected}`, () => {
      expect(evaluateLeaf(leaf, P)).toBe(expected);
    });
  }

  it("covers every declared operator in this table", () => {
    const covered = new Set(cases.map(([l]) => l.operator));
    for (const op of CONDITION_OPERATORS) {
      expect(covered.has(op), `operator ${op} untested`).toBe(true);
    }
  });
});

describe("evaluateConditions — AND / OR algebra", () => {
  const and = (conds: LeafCondition[]): ConditionGroup => ({
    combinator: "and",
    conditions: conds,
  });
  const or = (conds: LeafCondition[]): ConditionGroup => ({
    combinator: "or",
    conditions: conds,
  });

  it("AND requires every child", () => {
    expect(
      evaluateConditions(
        and([
          { field: "amount", operator: "gt", value: 1000 },
          { field: "status", operator: "eq", value: "accepted" },
        ]),
        P,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        and([
          { field: "amount", operator: "gt", value: 1000 },
          { field: "status", operator: "eq", value: "declined" },
        ]),
        P,
      ),
    ).toBe(false);
  });

  it("OR requires at least one child", () => {
    expect(
      evaluateConditions(
        or([
          { field: "amount", operator: "gt", value: 9999 },
          { field: "status", operator: "eq", value: "accepted" },
        ]),
        P,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        or([
          { field: "amount", operator: "gt", value: 9999 },
          { field: "status", operator: "eq", value: "declined" },
        ]),
        P,
      ),
    ).toBe(false);
  });

  it("nests groups (AND of an OR)", () => {
    const tree: ConditionGroup = {
      combinator: "and",
      conditions: [
        { field: "amount", operator: "gte", value: 1000 },
        {
          combinator: "or",
          conditions: [
            { field: "currency", operator: "eq", value: "USD" },
            { field: "vip", operator: "is_true" },
          ],
        },
      ],
    };
    expect(evaluateConditions(tree, P)).toBe(true);
  });

  it("an empty / null tree ALWAYS fires (an ungated rule)", () => {
    expect(evaluateConditions(null, P)).toBe(true);
    expect(evaluateConditions(undefined, P)).toBe(true);
    expect(evaluateConditions({ combinator: "and", conditions: [] }, P)).toBe(true);
  });

  it("fail-closed on a non-object payload and a malformed group", () => {
    expect(
      evaluateConditions(
        and([{ field: "amount", operator: "gt", value: 1 }]),
        null,
      ),
    ).toBe(false);
    // A group with a bad combinator is false, never coerced to true.
    expect(
      evaluateConditions(
        { combinator: "xor" as unknown as "and", conditions: [] },
        P,
      ),
    ).toBe(false);
  });

  it("is deterministic — same inputs, same output, repeated", () => {
    const tree = and([{ field: "amount", operator: "gt", value: 1000 }]);
    const first = evaluateConditions(tree, P);
    for (let i = 0; i < 25; i++) expect(evaluateConditions(tree, P)).toBe(first);
  });
});
