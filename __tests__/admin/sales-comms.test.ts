import { describe, it, expect } from "vitest";
import {
  COMM_CHANNELS,
  COMM_EVENT_TYPES,
  commDirectionSummary,
  eventChannel,
  isCommEvent,
  summariseComms,
  type CommChannelStat,
} from "@/lib/sales/comms";

/**
 * CrewFlow HQ — AI Communication Centre channel-model tests
 * (CEO Directive 004, Phase 5).
 *
 * The Communication Centre renders its per-channel roll-up and its unified
 * timeline entirely from these pure functions, so the tests pin the event
 * → channel mapping (including the forward-compatible WhatsApp/SMS slugs and
 * the metadata hint) and the window summary maths.
 */

type CommInput = Parameters<typeof summariseComms>[0][number];

function ev(over: Partial<CommInput> = {}): CommInput {
  return {
    event_type: "email",
    direction: "outbound",
    occurred_at: "2026-06-16T09:00:00.000Z",
    metadata: null,
    ...over,
  };
}

describe("comms — eventChannel", () => {
  it("maps human touches and AI comm actions to a channel", () => {
    expect(eventChannel("email")).toBe("email");
    expect(eventChannel("email_sent")).toBe("email");
    expect(eventChannel("email_generated")).toBe("email");
    expect(eventChannel("call")).toBe("phone");
    expect(eventChannel("call_completed")).toBe("phone");
    expect(eventChannel("linkedin_sent")).toBe("linkedin");
    expect(eventChannel("instagram")).toBe("instagram");
    expect(eventChannel("facebook")).toBe("facebook");
  });

  it("is forward-compatible with WhatsApp/SMS event slugs", () => {
    expect(eventChannel("whatsapp")).toBe("whatsapp");
    expect(eventChannel("sms")).toBe("sms");
  });

  it("falls back to a metadata channel hint", () => {
    expect(eventChannel("note", { channel: "whatsapp" })).toBe("whatsapp");
    expect(eventChannel("note", { channel: "pigeon" })).toBeNull();
  });

  it("excludes non-communication events", () => {
    expect(eventChannel("note")).toBeNull();
    expect(eventChannel("demo")).toBeNull();
    expect(eventChannel("scored")).toBeNull();
    expect(eventChannel("task_completed")).toBeNull();
  });
});

describe("comms — isCommEvent + COMM_EVENT_TYPES", () => {
  it("classifies communication events", () => {
    expect(isCommEvent("email")).toBe(true);
    expect(isCommEvent("note")).toBe(false);
    expect(isCommEvent("note", { channel: "sms" })).toBe(true);
  });

  it("exposes the comm event types for a bounded SQL read", () => {
    expect(COMM_EVENT_TYPES).toContain("email");
    expect(COMM_EVENT_TYPES).toContain("call_completed");
    expect(COMM_EVENT_TYPES).toContain("whatsapp");
    expect(COMM_EVENT_TYPES).toContain("sms");
    expect(COMM_EVENT_TYPES).not.toContain("note");
  });
});

describe("comms — summariseComms", () => {
  const events: CommInput[] = [
    ev({ event_type: "email", direction: "inbound", occurred_at: "2026-06-15T09:00:00.000Z" }),
    ev({ event_type: "email", direction: "outbound", occurred_at: "2026-06-16T09:00:00.000Z" }),
    ev({ event_type: "email_generated", direction: "internal", occurred_at: "2026-06-13T09:00:00.000Z" }),
    ev({ event_type: "call_completed", direction: "outbound", occurred_at: "2026-06-17T09:00:00.000Z" }),
    ev({ event_type: "linkedin", direction: "inbound", occurred_at: "2026-06-14T09:00:00.000Z" }),
    // Not a communication — must be ignored entirely.
    ev({ event_type: "note", direction: "internal", occurred_at: "2026-06-18T09:00:00.000Z" }),
  ];
  const summary = summariseComms(events);

  it("rolls up totals across communication events only", () => {
    expect(summary.total).toBe(5); // note excluded
    expect(summary.inbound).toBe(2);
    expect(summary.outbound).toBe(2); // email_generated is internal, uncounted
    expect(summary.channelsActive).toBe(3);
    expect(summary.lastContactAt).toBe("2026-06-17T09:00:00.000Z");
  });

  it("always reports every channel, including the silent ones", () => {
    expect(summary.byChannel).toHaveLength(COMM_CHANNELS.length);
    const email = summary.byChannel.find((s) => s.channel === "email");
    expect(email?.total).toBe(3);
    expect(email?.inbound).toBe(1);
    expect(email?.outbound).toBe(1);
    expect(email?.lastAt).toBe("2026-06-16T09:00:00.000Z");
    const whatsapp = summary.byChannel.find((s) => s.channel === "whatsapp");
    expect(whatsapp?.total).toBe(0);
    expect(whatsapp?.lastAt).toBeNull();
  });
});

describe("comms — commDirectionSummary", () => {
  function stat(over: Partial<CommChannelStat>): CommChannelStat {
    return { channel: "email", label: "Email", total: 0, inbound: 0, outbound: 0, lastAt: null, ...over };
  }
  it("describes the inbound/outbound split", () => {
    expect(commDirectionSummary(stat({}))).toBe("No messages yet");
    expect(commDirectionSummary(stat({ total: 5, inbound: 2, outbound: 3 }))).toBe(
      "2 inbound · 3 outbound",
    );
    expect(commDirectionSummary(stat({ total: 1 }))).toBe("1 logged");
  });
});
