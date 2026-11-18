import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_ALLOWED_ITEM_TYPES,
  type MinimalEnvelope,
  filterEnvelopeForConsent,
  makeConsentGatedTransport,
} from "@/lib/monitoring/consent-transport";

/**
 * Browser Sentry consent gate.
 *
 * The contract: without "performance" consent, the ONLY thing that may leave
 * the browser for Sentry is an error report. Session-health pings (which the
 * SDK sends on every page load), performance traces, replays, client reports —
 * and any envelope item type this code has never heard of — are dropped.
 */

const HEADERS = { sent_at: "2026-11-13T10:00:00.000Z" };
const item = (type: string, payload: unknown = {}) => [{ type }, payload] as const;
const envelope = (...types: string[]): MinimalEnvelope => [HEADERS, types.map((t) => item(t))];
const typesOf = (e: MinimalEnvelope | null) => e?.[1].map((i) => i[0].type) ?? null;

describe("filterEnvelopeForConsent", () => {
  it("passes everything through untouched when performance is allowed", () => {
    const e = envelope("session", "transaction", "event");
    expect(filterEnvelopeForConsent(e, true)).toBe(e);
  });

  it("drops the page-load session ping entirely without consent", () => {
    expect(filterEnvelopeForConsent(envelope("session"), false)).toBeNull();
    expect(filterEnvelopeForConsent(envelope("sessions"), false)).toBeNull();
  });

  it("drops every non-error telemetry type without consent", () => {
    for (const type of [
      "session",
      "sessions",
      "transaction",
      "span",
      "profile",
      "profile_chunk",
      "replay_event",
      "replay_recording",
      "client_report",
      "check_in",
      "statsd",
      "raw_security",
    ]) {
      expect(filterEnvelopeForConsent(envelope(type), false), type).toBeNull();
    }
  });

  it("always lets an error report (and its attachment) through", () => {
    const e = envelope("event", "attachment");
    expect(filterEnvelopeForConsent(e, false)).toBe(e);
  });

  it("keeps the error but strips gated items from a mixed envelope, without mutating it", () => {
    const e = envelope("event", "session", "client_report");
    const out = filterEnvelopeForConsent(e, false);
    expect(typesOf(out)).toEqual(["event"]);
    expect(out?.[0]).toBe(HEADERS);
    expect(typesOf(e)).toEqual(["event", "session", "client_report"]);
  });

  it("is an allow-list: an unknown or malformed item type is dropped", () => {
    expect(filterEnvelopeForConsent(envelope("some_future_type"), false)).toBeNull();
    const malformed = [HEADERS, [[{}, {}], [{ type: 7 }, {}]]] as unknown as MinimalEnvelope;
    expect(filterEnvelopeForConsent(malformed, false)).toBeNull();
  });

  it("pins the always-allowed list (changing it is a privacy decision)", () => {
    expect([...ALWAYS_ALLOWED_ITEM_TYPES].sort()).toEqual([
      "attachment",
      "event",
      "feedback",
      "user_report",
    ]);
  });
});

describe("makeConsentGatedTransport", () => {
  function setup(allowed: () => boolean) {
    const send = vi.fn(async (_e: MinimalEnvelope) => ({ statusCode: 200 }));
    const flush = vi.fn(async (_t?: number) => true);
    return { send, flush, gated: makeConsentGatedTransport({ send, flush }, allowed) };
  }

  it("sends nothing for a session ping without consent, and resolves as a no-op", async () => {
    const { send, gated } = setup(() => false);
    await expect(gated.send(envelope("session"))).resolves.toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the session ping once consent is given — read live per send", async () => {
    let allowed = false;
    const { send, gated } = setup(() => allowed);
    await gated.send(envelope("session"));
    expect(send).not.toHaveBeenCalled();
    allowed = true;
    await gated.send(envelope("session"));
    expect(send).toHaveBeenCalledTimes(1);
    allowed = false; // withdrawn
    await gated.send(envelope("session"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("always forwards error reports", async () => {
    const { send, gated } = setup(() => false);
    await gated.send(envelope("event"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(typesOf(send.mock.calls[0]![0])).toEqual(["event"]);
  });

  it("fails closed if the consent check throws", async () => {
    const { send, gated } = setup(() => {
      throw new Error("cookies blocked");
    });
    await gated.send(envelope("session", "transaction"));
    expect(send).not.toHaveBeenCalled();
    await gated.send(envelope("event", "session"));
    expect(typesOf(send.mock.calls[0]![0])).toEqual(["event"]);
  });

  it("delegates flush", async () => {
    const { flush, gated } = setup(() => false);
    await expect(gated.flush(500)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(500);
  });
});
