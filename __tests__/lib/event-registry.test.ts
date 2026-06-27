import { describe, it, expect } from "vitest";
import {
  ACTOR_TYPES,
  EVENT_SCHEMA_VERSION_BASELINE,
  EVENT_SCHEMA_VERSION_OVERRIDES,
  eventSchemaVersion,
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
    // task.* (5) added under ADR 0005 (Directive #012 / D-02, PR-B); task.cancelled
    // (the 6th) added under ADR 0007 (Directive #013 / D-03, RunContext Runtime Contract).
    expect(VERBS).toHaveLength(78);
    expect(VERB_GROUPS.org).toHaveLength(10);
    expect(VERB_GROUPS.billing).toHaveLength(9);
    expect(VERB_GROUPS.operations).toHaveLength(8);
    expect(VERB_GROUPS.support).toHaveLength(5);
    expect(VERB_GROUPS.ai).toHaveLength(10);
    expect(VERB_GROUPS.approval).toHaveLength(6);
    expect(VERB_GROUPS.memory).toHaveLength(5);
    expect(VERB_GROUPS.comm).toHaveLength(6);
    expect(VERB_GROUPS.task).toHaveLength(6);
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
      "comm.sent",
      "task.created",
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

/**
 * Event Spine versioning rule (CEO Directive #012). Every registered event carries
 * a STABLE schema version (baseline 1), kept registry-first so replay/analytics can
 * key off it — see docs/bible/substrate/event-versioning.md. These pin the rule:
 * every verb resolves to a version, and the override map can only record genuine
 * bumps for real verbs (a typo'd or redundant entry fails here, not in production).
 */
describe("event schema versioning — every registered event has a stable version", () => {
  it("the baseline version is 1", () => {
    expect(EVENT_SCHEMA_VERSION_BASELINE).toBe(1);
  });

  it("every registered verb resolves to a positive-integer version", () => {
    for (const v of VERBS) {
      const version = eventSchemaVersion(v);
      expect(
        Number.isInteger(version) && version >= 1,
        `verb "${v}" → non-positive-integer version ${version}`,
      ).toBe(true);
    }
  });

  it("overrides are only for registered verbs, and only real bumps (>= 2)", () => {
    // v1 is the baseline, so any override must be a genuine bump; an entry for an
    // unregistered verb, or one that merely restates the baseline, fails here.
    for (const [verb, version] of Object.entries(EVENT_SCHEMA_VERSION_OVERRIDES) as [
      string,
      number,
    ][]) {
      expect(VERBS as readonly string[], `override for unregistered verb "${verb}"`).toContain(verb);
      expect(version, `override "${verb}" must be an integer >= 2`).toBeGreaterThanOrEqual(2);
    }
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
