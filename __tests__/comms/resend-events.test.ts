import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyResendSignature,
  parseResendEventPayload,
  normalizeResendEvent,
  RESEND_SIGNATURE_TOLERANCE_SECONDS,
} from "@/lib/comms/providers/resend-events";

/**
 * Resend delivery-events adapter — signature (the auth boundary) + normalization.
 *
 * Svix scheme: HMAC-SHA256 over `"<id>.<timestamp>.<body>"`, keyed by the base64
 * secret behind the `whsec_` prefix, base64-encoded, carried as `v1,<sig>`.
 */

const SECRET_B64 = Buffer.from("super-secret-signing-key-0123456789").toString("base64");
const SECRET = `whsec_${SECRET_B64}`;

function sign(id: string, timestamp: string, body: string, secretB64 = SECRET_B64): string {
  const key = Buffer.from(secretB64, "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
  return `v1,${digest}`;
}

afterEach(() => vi.unstubAllEnvs());

describe("verifyResendSignature", () => {
  const now = 1_700_000_000;
  const ts = String(now);
  const id = "msg_abc123";
  const body = JSON.stringify({ type: "email.opened", data: { email_id: "re_1" } });

  it("accepts a correctly signed, in-tolerance delivery", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: sign(id, ts, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("accepts when the secret has no whsec_ prefix (raw base64)", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET_B64);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: sign(id, ts, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("accepts when the header carries multiple space-separated signatures (rotation)", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const good = sign(id, ts, body);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: `v1,AAAA ${good}` },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("fails closed with no secret configured", () => {
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: sign(id, ts, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: sign(id, ts, body) },
        rawBody: body + "x",
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a wrong-secret signature", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const forged = sign(id, ts, body, Buffer.from("attacker-key").toString("base64"));
    expect(
      verifyResendSignature({
        headers: { id, timestamp: ts, signature: forged },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const staleTs = String(now - RESEND_SIGNATURE_TOLERANCE_SECONDS - 1);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: staleTs, signature: sign(id, staleTs, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    expect(
      verifyResendSignature({
        headers: { id: null, timestamp: ts, signature: sign(id, ts, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    expect(
      verifyResendSignature({
        headers: { id, timestamp: "not-a-number", signature: sign(id, ts, body) },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });
});

describe("parse + normalize", () => {
  it("normalizes an opened event, stripping the email. prefix and resolving id + recipient", () => {
    const raw = JSON.stringify({
      type: "email.opened",
      created_at: "2026-08-16T10:00:00.000Z",
      data: { email_id: "re_abc", to: ["cust@example.com"], subject: "Your quote" },
    });
    const parsed = parseResendEventPayload(raw);
    expect(parsed).not.toBeNull();
    const norm = normalizeResendEvent(parsed!);
    expect(norm.event_type).toBe("opened");
    expect(norm.provider_message_id).toBe("re_abc");
    expect(norm.recipient).toBe("cust@example.com");
    expect(norm.occurred_at).toBe("2026-08-16T10:00:00.000Z");
  });

  it("handles a string `to` and a bounced type", () => {
    const norm = normalizeResendEvent(
      parseResendEventPayload(
        JSON.stringify({ type: "email.bounced", data: { email_id: "re_x", to: "a@b.com" } }),
      )!,
    );
    expect(norm.event_type).toBe("bounced");
    expect(norm.recipient).toBe("a@b.com");
  });

  it("returns null for an unparseable body", () => {
    expect(parseResendEventPayload("{not json")).toBeNull();
  });

  it("surfaces a missing email id as null (handler rejects it)", () => {
    const norm = normalizeResendEvent(parseResendEventPayload(JSON.stringify({ type: "email.delivered" }))!);
    expect(norm.provider_message_id).toBeNull();
  });
});
