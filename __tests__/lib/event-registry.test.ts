import { describe, it, expect } from "vitest";
import {
  ACTOR_TYPES,
  isVerb,
  SEVERITIES,
  VERB_GROUPS,
  VERBS,
  verbNamespace,
  type Verb,
} from "@/lib/events/registry";

/**
 * The verb registry is the SINGLE SOURCE of event names (Ch.04). These are its
 * contract tests: the spine's analogue of an API contract. A producer that drifts
 * — a duplicate, a malformed name, a verb added without updating the count —
 * fails CI here, exactly as intended ("sprawl is the enemy of one source").
 */

describe("event-verb registry — single-source invariants", () => {
  it("has no duplicate verbs", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const v of VERBS) {
      if (seen.has(v)) dupes.push(v);
      seen.add(v);
    }
    expect(dupes, `duplicate verbs: ${dupes.join(", ")}`).toHaveLength(0);
  });

  it("every verb is `domain.action`, lower-snake, exactly one dot", () => {
    const bad = VERBS.filter((v) => !/^[a-z]+\.[a-z_]+$/.test(v));
    expect(bad, `malformed verbs: ${bad.join(", ")}`).toHaveLength(0);
  });

  it("flattened VERBS is exactly the union of the groups (one place to edit)", () => {
    const fromGroups = Object.values(VERB_GROUPS).flatMap((g) => [...g]);
    expect([...VERBS].sort()).toEqual([...fromGroups].sort());
  });

  it("locks the registry size + per-group counts (a deliberate-change tripwire)", () => {
    // Changing these requires an ADR (Ch.20) + updating this test on purpose.
    expect(VERBS).toHaveLength(66);
    expect(VERB_GROUPS.org).toHaveLength(10);
    expect(VERB_GROUPS.billing).toHaveLength(9);
    expect(VERB_GROUPS.operations).toHaveLength(8);
    expect(VERB_GROUPS.support).toHaveLength(5);
    expect(VERB_GROUPS.ai).toHaveLength(10);
    expect(VERB_GROUPS.approval).toHaveLength(6);
    expect(VERB_GROUPS.memory).toHaveLength(5);
    expect(VERB_GROUPS.permission).toHaveLength(3);
    expect(VERB_GROUPS.system).toHaveLength(7);
    expect(VERB_GROUPS.notification).toHaveLength(3);
  });

  it("pins a representative verb from every domain (rename = breaking change)", () => {
    const required: Verb[] = [
      "org.trial_started",
      "invoice.payment_failed",
      "customer.created",
      "support.ticket_opened",
      "ai.run_started",
      "approval.requested",
      "memory.asserted",
      "permission.role_granted",
      "system.alert_raised",
      "notification.emailed",
    ];
    for (const v of required) expect(VERBS).toContain(v);
  });
});

describe("isVerb — runtime guard", () => {
  it("accepts registered verbs", () => {
    expect(isVerb("ai.run_completed")).toBe(true);
    expect(isVerb("billing.refund_issued")).toBe(true);
  });

  it("rejects unregistered strings and non-strings", () => {
    expect(isVerb("ai.world_domination")).toBe(false);
    expect(isVerb("")).toBe(false);
    expect(isVerb(undefined)).toBe(false);
    expect(isVerb(42)).toBe(false);
    expect(isVerb({ verb: "org.created" })).toBe(false);
  });
});

describe("verbNamespace", () => {
  it("returns the segment before the first dot", () => {
    expect(verbNamespace("invoice.payment_succeeded")).toBe("invoice");
    expect(verbNamespace("ai.tool_called")).toBe("ai");
    expect(verbNamespace("org.created")).toBe("org");
  });
});

describe("envelope enums mirror the hq_events CHECK constraints", () => {
  it("actor types", () => {
    expect([...ACTOR_TYPES]).toEqual(["human", "ai_employee", "system", "tenant"]);
  });
  it("severities", () => {
    expect([...SEVERITIES]).toEqual(["info", "success", "warn", "critical"]);
  });
});
