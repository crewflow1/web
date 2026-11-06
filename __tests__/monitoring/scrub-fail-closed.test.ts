import { describe, it, expect } from "vitest";
import { scrubEvent } from "@/lib/monitoring/scrub";

/**
 * Sentry scrub — the FAIL-CLOSED guarantee (comms+recovery launch readiness).
 *
 * scrubEvent is wired into `beforeSend` / `beforeSendTransaction` on all three
 * sentry.*.config.ts files. Its contract has two halves, and the existing
 * scrub.test.ts proves the happy half (a genuine error is never dropped — the
 * scrubbed event is returned, not null). This file pins the OTHER half, the one
 * that actually protects customer data: if redaction itself throws, scrubEvent
 * must return `null` so the SDK DROPS the event rather than shipping unscrubbed
 * context (Authorization headers, Supabase keys, invoice PII) to a third party.
 *
 * A `beforeSend` that returned the event on a redaction bug would be a silent
 * data-protection breach. These are additive; they touch no source.
 */

describe("scrubEvent — fails CLOSED when redaction throws", () => {
  it("returns null (drops the event) if iterating a request-body field throws", () => {
    // A hostile value whose key enumeration throws forces redactObject to throw
    // deep inside scrubEvent's try — exactly the "cannot guarantee it is
    // scrubbed" case. Shipping it anyway could leak the secrets this field holds.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("enumeration blew up mid-redaction");
        },
      },
    );
    const event = { request: { data: hostile } } as unknown as {
      request: { data: unknown };
    };
    expect(scrubEvent(event)).toBeNull();
  });

  it("returns null if a nested extra value throws during redaction", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const event = { extra: { nested: hostile } } as unknown as {
      extra: Record<string, unknown>;
    };
    expect(scrubEvent(event)).toBeNull();
  });

  it("still returns the event (never null) for an ordinary error with no sensitive data", () => {
    // Guards the inverse: fail-closed must not degrade into dropping clean
    // events. A plain error event passes through.
    const event = { message: "something broke", level: "error" };
    expect(scrubEvent(event)).toBe(event);
  });
});
