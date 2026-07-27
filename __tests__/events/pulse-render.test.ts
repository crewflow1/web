import { describe, it, expect } from "vitest";
import {
  Send,
  UserPlus,
  Settings2,
  Activity,
  AlertTriangle,
} from "lucide-react";
import {
  eventIcon,
  severityToken,
  actorLabel,
  companyLabel,
  describeEvent,
  eventHref,
  shortId,
  dayBucket,
  absoluteTime,
  BUCKET_ORDER,
  BUCKET_LABEL,
} from "@/lib/events/render";
import type { TimelineEvent } from "@/server/services/spine-timeline";

/**
 * Unit proof for the Pulse render vocabulary (Module 1, PR5 / CEO Directive
 * #005, STEP 5). render.ts is pure + client-safe — it turns one projected
 * `hq_timeline` row into the icon / title / description / severity palette /
 * deep link / actor + company label / day-bucket the feed paints. These are the
 * promises the card and drawer rely on: nothing ever renders a raw `verb.string`,
 * a raw UUID, or an orphaned (un-bucketed) row, and money / time render in en-GB.
 */

function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    event_id: 1,
    ts: "2026-06-20T12:00:00.000Z",
    verb: "system.cron_ran",
    namespace: "system",
    severity: "info",
    actor_type: "system",
    actor_id: null,
    object_type: "system",
    object_id: "cron-1",
    target_type: null,
    target_id: null,
    correlation_id: "00000000-0000-0000-0000-000000000000",
    causation_id: null,
    payload: {},
    visibility: "hq",
    projected_at: "2026-06-20T12:00:00.000Z",
    ...over,
  };
}

describe("render — eventIcon", () => {
  it("prefers a per-verb override where the namespace icon undersells the moment", () => {
    expect(eventIcon("quote.sent")).toBe(Send);
    expect(eventIcon("invoice.payment_failed")).toBe(AlertTriangle);
  });

  it("falls back to the namespace icon, then to a generic Activity for anything unknown", () => {
    expect(eventIcon("customer.created")).toBe(UserPlus); // namespace `customer`
    expect(eventIcon("system.flag_changed")).toBe(Settings2); // namespace `system`
    expect(eventIcon("brandnew.invented")).toBe(Activity); // unmapped namespace
  });
});

describe("render — severityToken", () => {
  it("maps each severity to a labelled dark token", () => {
    expect(severityToken("info").label).toBe("Info");
    expect(severityToken("success").label).toBe("Success");
    expect(severityToken("warn").label).toBe("Warning");
    expect(severityToken("critical").label).toBe("Critical");
  });

  it("falls back to the info token for an unknown severity (never undefined)", () => {
    expect(severityToken("nonsense")).toBe(severityToken("info"));
  });
});

describe("render — actorLabel (resolved at render time, never a raw UUID)", () => {
  it("prefers a name/email carried in the payload", () => {
    expect(actorLabel(ev({ payload: { actor_name: "Alice Brick" } }))).toBe("Alice Brick");
    expect(actorLabel(ev({ payload: { ai_employee: "Research AI" } }))).toBe("Research AI");
  });

  it("shows a human operator's email as-is, but never a bare UUID", () => {
    expect(actorLabel(ev({ actor_type: "human", actor_id: "bob@crewflow.uk" }))).toBe(
      "bob@crewflow.uk",
    );
    expect(
      actorLabel(ev({ actor_type: "human", actor_id: "11111111-2222-3333-4444-555555555555" })),
    ).toBe("11111111");
  });

  it("humanises the actor_type when nothing better is available", () => {
    expect(actorLabel(ev({ actor_type: "ai_employee" }))).toBe("AI employee");
    expect(actorLabel(ev({ actor_type: "system" }))).toBe("System");
    expect(actorLabel(ev({ actor_type: "tenant" }))).toBe("Customer");
  });
});

describe("render — companyLabel", () => {
  it("picks the first company-ish payload field, else null", () => {
    expect(companyLabel(ev({ payload: { company: "Acme Roofing Ltd" } }))).toBe("Acme Roofing Ltd");
    expect(companyLabel(ev({ payload: { org_name: "BuildCo" } }))).toBe("BuildCo");
    expect(companyLabel(ev())).toBeNull();
  });
});

describe("render — describeEvent (never a raw verb.string)", () => {
  it("prettifies the verb into a human title for every namespace", () => {
    expect(describeEvent(ev({ verb: "system.cron_ran" })).title).toBe("System cron ran");
    expect(describeEvent(ev({ verb: "ai.run_completed" })).title).toBe("AI run completed");
  });

  it("writes a bespoke description for the high-value verbs", () => {
    const customer = describeEvent(
      ev({ verb: "customer.created", payload: { name: "Jane", company: "Acme Ltd" } }),
    );
    expect(customer.title).toBe("Customer created");
    expect(customer.description).toBe("Jane · Acme Ltd");

    const quote = describeEvent(
      ev({ verb: "quote.sent", payload: { number: "Q-1", total: 1200, company: "Acme Ltd" } }),
    );
    expect(quote.title).toBe("Quote sent");
    expect(quote.description).toContain("Quote Q-1");
    expect(quote.description).toContain("£1,200"); // en-GB money
    expect(quote.description).toContain("Acme Ltd");

    const invoice = describeEvent(
      ev({ verb: "invoice.paid", payload: { number: "INV-9", total: 500 } }),
    );
    expect(invoice.title).toBe("Invoice paid");
    expect(invoice.description).toContain("Invoice INV-9");
    expect(invoice.description).toContain("paid");
  });

  it("has a clean generic fallback so an unmapped verb still reads well", () => {
    const d = describeEvent(
      ev({ verb: "memory.asserted", object_type: "memory", object_id: "mem-12345" }),
    );
    expect(d.title).toBe("Memory asserted");
    expect(d.description).toBe("Memory mem-12345");
    expect(d.title).not.toContain(".");
  });
});

describe("render — eventHref (best-effort deep link, null when unknown)", () => {
  it("routes tenant + HQ objects to their canonical pages", () => {
    expect(eventHref(ev({ object_type: "customer", object_id: "c1" }))).toBe("/customers/c1");
    expect(eventHref(ev({ object_type: "job", object_id: "j1" }))).toBe("/jobs/j1");
    expect(eventHref(ev({ object_type: "invoice", object_id: "i1" }))).toBe("/invoices/i1");
    expect(eventHref(ev({ object_type: "org", object_id: "o1" }))).toBe("/admin/customers?org=o1");
    expect(eventHref(ev({ object_type: "support_ticket", object_id: "t1" }))).toBe(
      "/admin/support?ticket=t1",
    );
  });

  it("returns null for an object type with no canonical page", () => {
    expect(eventHref(ev({ object_type: "system", object_id: "x" }))).toBeNull();
  });
});

describe("render — shortId", () => {
  it("collapses a UUID to its first segment and a long opaque id to 8 chars", () => {
    expect(shortId("11111111-2222-3333-4444-555555555555")).toBe("11111111");
    expect(shortId("abcdefghijkl")).toBe("abcdefgh…");
    expect(shortId("abc")).toBe("abc");
    expect(shortId(null)).toBe("—");
  });
});

describe("render — dayBucket (Europe/London, relative to now)", () => {
  // A fixed "now" makes the buckets deterministic regardless of when CI runs.
  const now = new Date("2026-06-20T12:00:00.000Z");

  it("buckets today / yesterday / this-week / earlier by London calendar day", () => {
    expect(dayBucket("2026-06-20T08:00:00.000Z", now)).toBe("today");
    expect(dayBucket("2026-06-19T12:00:00.000Z", now)).toBe("yesterday");
    expect(dayBucket("2026-06-15T12:00:00.000Z", now)).toBe("week");
    expect(dayBucket("2026-06-13T12:00:00.000Z", now)).toBe("week"); // 7 days ago: still "week"
    expect(dayBucket("2026-06-12T12:00:00.000Z", now)).toBe("earlier"); // 8 days ago
  });

  it("collapses a future-dated row to today (clock skew never orphans a card)", () => {
    expect(dayBucket("2026-06-25T12:00:00.000Z", now)).toBe("today");
  });

  it("exposes the bucket order + labels the feed groups by", () => {
    expect(BUCKET_ORDER).toEqual(["today", "yesterday", "week", "earlier"]);
    expect(BUCKET_LABEL).toEqual({
      today: "Today",
      yesterday: "Yesterday",
      week: "This Week",
      earlier: "Earlier",
    });
  });
});

describe("render — absoluteTime", () => {
  it("formats a valid ISO timestamp, and echoes a non-date unchanged", () => {
    expect(absoluteTime("2026-06-20T12:00:00.000Z")).toContain("2026");
    expect(absoluteTime("not-a-date")).toBe("not-a-date");
  });
});
