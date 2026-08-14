import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyInboundEmailSignature,
  parseInboundEmailPayload,
  normalizeInboundEmail,
  normalizeEmailAddress,
} from "@/lib/comms/providers/inbound-email";

/**
 * Inbound-email adapter — signature, parsing, normalization.
 *
 * Pure edge logic, tested behaviourally. The signature verifier is the auth
 * boundary: every unhappy path must fail CLOSED, and a valid signature must pass
 * only when computed over the exact raw bytes with the configured secret.
 */

const SECRET = "test_inbound_email_secret_ffff";
const sign = (raw: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");

describe("verifyInboundEmailSignature — the auth boundary, fail-closed", () => {
  beforeEach(() => vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a signature computed over the exact raw body", () => {
    const raw = '{"from":"a@b.com","to":"hi@org.com","message_id":"<m1@b.com>"}';
    expect(verifyInboundEmailSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
  });

  it("rejects when the body differs by one byte (signature is over bytes)", () => {
    const raw = '{"from":"a@b.com"}';
    expect(verifyInboundEmailSignature({ signature: sign(raw), rawBody: raw + " " })).toBe(false);
  });

  it("fails CLOSED when the secret is unset (dark)", () => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "");
    const raw = "{}";
    // Signature computed with the (now absent) secret must NOT pass.
    expect(verifyInboundEmailSignature({ signature: sign(raw), rawBody: raw })).toBe(false);
  });

  it("rejects a missing / blank / wrong-prefix / non-hex signature", () => {
    const raw = "{}";
    expect(verifyInboundEmailSignature({ signature: null, rawBody: raw })).toBe(false);
    expect(verifyInboundEmailSignature({ signature: "", rawBody: raw })).toBe(false);
    expect(verifyInboundEmailSignature({ signature: "md5=abcd", rawBody: raw })).toBe(false);
    expect(verifyInboundEmailSignature({ signature: "sha256=zzzz", rawBody: raw })).toBe(false);
  });

  it("rejects a signature computed with a DIFFERENT secret", () => {
    const raw = "{}";
    expect(
      verifyInboundEmailSignature({ signature: sign(raw, "another_secret"), rawBody: raw }),
    ).toBe(false);
  });
});

describe("normalizeEmailAddress — stable routing key", () => {
  it("strips display names and lowercases + trims", () => {
    expect(normalizeEmailAddress("Jane Doe <Jane.Doe@Example.COM>")).toBe("jane.doe@example.com");
    expect(normalizeEmailAddress("  HELLO@Org.co.uk ")).toBe("hello@org.co.uk");
  });
  it("returns null for empty/absent", () => {
    expect(normalizeEmailAddress(null)).toBeNull();
    expect(normalizeEmailAddress("")).toBeNull();
    expect(normalizeEmailAddress("   ")).toBeNull();
  });
});

describe("parseInboundEmailPayload — permissive, tolerant of the unknown", () => {
  it("returns null on non-JSON", () => {
    expect(parseInboundEmailPayload("not json")).toBeNull();
  });
  it("parses a canonical body and tolerates extra fields", () => {
    const p = parseInboundEmailPayload(
      JSON.stringify({ from: "a@b.com", to: "hi@org.com", subject: "Hi", text: "body", spf: "pass" }),
    );
    expect(p).not.toBeNull();
    expect(p?.from).toBe("a@b.com");
  });
});

describe("normalizeInboundEmail — → the channel-agnostic ingestion shape", () => {
  it("resolves provider field-name variants (recipient/sender/messageId/body-plain)", () => {
    const p = parseInboundEmailPayload(
      JSON.stringify({
        sender: "Cust <Cust@Mail.com>",
        recipient: "Leads@ORG.com",
        subject: "Leaking tap",
        "body-plain": "Please help, kitchen tap leaking.",
        messageId: "<abc-123@mail.com>",
        timestamp: 1700000000,
      }),
    )!;
    const n = normalizeInboundEmail(p);
    expect(n.from_address).toBe("cust@mail.com");
    expect(n.to_address).toBe("leads@org.com");
    expect(n.message_id).toBe("<abc-123@mail.com>");
    expect(n.subject).toBe("Leaking tap");
    expect(n.raw_text).toContain("Subject: Leaking tap");
    expect(n.raw_text).toContain("kitchen tap leaking");
    expect(n.provider_timestamp).toBe("1700000000");
    expect(n.has_attachments).toBe(false);
  });

  it("falls back to stripped HTML when no plain text is present", () => {
    const p = parseInboundEmailPayload(
      JSON.stringify({
        from: "a@b.com",
        to: "hi@org.com",
        message_id: "<h1@b.com>",
        html: "<p>Hello <b>there</b></p><script>alert(1)</script>",
      }),
    )!;
    const n = normalizeInboundEmail(p);
    expect(n.body_text).toBe("Hello there");
    expect(n.body_text).not.toContain("alert");
  });

  it("captures attachment metadata (no bytes) and flags has_attachments", () => {
    const p = parseInboundEmailPayload(
      JSON.stringify({
        from: "a@b.com",
        to: "hi@org.com",
        message_id: "<a1@b.com>",
        text: "see attached",
        attachments: [
          { filename: "quote.pdf", content_type: "application/pdf", size: 20481 },
          { name: "photo.jpg", type: "image/jpeg", length: "5000" },
        ],
      }),
    )!;
    const n = normalizeInboundEmail(p);
    expect(n.has_attachments).toBe(true);
    expect(n.attachments).toHaveLength(2);
    expect(n.attachments[0]).toEqual({ filename: "quote.pdf", content_type: "application/pdf", size: 20481 });
    expect(n.attachments[1]).toEqual({ filename: "photo.jpg", content_type: "image/jpeg", size: 5000 });
  });

  it("surfaces a missing message id as null (an un-dedupable delivery)", () => {
    const p = parseInboundEmailPayload(JSON.stringify({ from: "a@b.com", to: "hi@org.com" }))!;
    expect(normalizeInboundEmail(p).message_id).toBeNull();
  });
});
