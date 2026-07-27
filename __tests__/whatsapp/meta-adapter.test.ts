import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyMetaSignature,
  parseMetaWebhookPayload,
  normalizeMetaMessages,
  normalizeMetaStatuses,
  parseMetaWhatsAppStatus,
} from "@/lib/comms/providers/meta-whatsapp";

/**
 * WhatsApp Meta adapter — signature, parsing, normalization.
 *
 * Pure edge logic, so tested behaviourally. The signature verifier is the auth
 * boundary: every unhappy path must fail CLOSED, and a valid signature must pass
 * only when computed over the exact raw bytes with the configured secret.
 */

const SECRET = "test_app_secret_ffff";
const sign = (raw: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");

/** First element, asserting the array is non-empty (also strengthens the test). */
function first<T>(arr: T[]): T {
  const [x] = arr;
  if (x === undefined) throw new Error("expected at least one element, got none");
  return x;
}

describe("verifyMetaSignature — the auth boundary, fail-closed", () => {
  beforeEach(() => vi.stubEnv("WHATSAPP_APP_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a signature computed over the exact raw body", () => {
    const raw = '{"object":"whatsapp_business_account"}';
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
  });

  it("rejects when the body differs by one byte (signature is over bytes)", () => {
    const raw = '{"object":"whatsapp_business_account"}';
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw + " " })).toBe(false);
  });

  it("rejects a signature made with the WRONG secret", () => {
    const raw = "{}";
    expect(verifyMetaSignature({ signature: sign(raw, "other"), rawBody: raw })).toBe(false);
  });

  it("fails closed with no configured secret", () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    const raw = "{}";
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw })).toBe(false);
  });

  it("fails closed on missing / blank / wrong-prefix / non-hex signatures", () => {
    const raw = "{}";
    expect(verifyMetaSignature({ signature: null, rawBody: raw })).toBe(false);
    expect(verifyMetaSignature({ signature: "", rawBody: raw })).toBe(false);
    expect(verifyMetaSignature({ signature: "md5=abc", rawBody: raw })).toBe(false);
    expect(verifyMetaSignature({ signature: "sha256=zzzz", rawBody: raw })).toBe(false);
  });

  it("fails closed on a length-mismatched hex digest (no timingSafeEqual throw)", () => {
    const raw = "{}";
    expect(verifyMetaSignature({ signature: "sha256=abcd", rawBody: raw })).toBe(false);
  });
});

describe("parseMetaWebhookPayload — permissive, null on unusable", () => {
  it("parses a real-shaped envelope", () => {
    const env = parseMetaWebhookPayload(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp" } }] }],
      }),
    );
    expect(env).not.toBeNull();
    expect(env?.entry?.[0]?.id).toBe("waba1");
  });

  it("returns null on non-JSON", () => {
    expect(parseMetaWebhookPayload("not json")).toBeNull();
  });

  it("tolerates unknown extra fields (Meta adds fields over time)", () => {
    const env = parseMetaWebhookPayload(
      JSON.stringify({ object: "x", surprise: true, entry: [{ future: 1, changes: [] }] }),
    );
    expect(env).not.toBeNull();
  });
});

const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value }] }],
});

describe("normalizeMetaMessages — one normalized message per usable message", () => {
  const base = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "+441234", phone_number_id: "PNID_1" },
    contacts: [{ wa_id: "447700900000", profile: { name: "Jane" } }],
  };

  it("normalizes a text message with routing + identity", () => {
    const m = first(normalizeMetaMessages(
      envelope({ ...base, messages: [{ id: "wamid.A", from: "447700900000", type: "text", timestamp: "1700000000", text: { body: "Hello there" } }] }) as never,
    ));
    expect(m.phone_number_id).toBe("PNID_1");
    expect(m.wamid).toBe("wamid.A");
    expect(m.caller).toBe("447700900000");
    expect(m.contact_name).toBe("Jane");
    expect(m.raw_text).toBe("Hello there");
    expect(m.message_type).toBe("text");
    expect(m.has_media).toBe(false);
  });

  it("normalizes media to a placeholder + caption, has_media=true, no fetch", () => {
    const m = first(normalizeMetaMessages(
      envelope({ ...base, messages: [{ id: "wamid.B", from: "447700900000", type: "image", image: { id: "MEDIA_1", caption: "the leak" } }] }) as never,
    ));
    expect(m.has_media).toBe(true);
    expect(m.raw_text).toBe("[image] the leak");
  });

  it("normalizes location, contacts, interactive replies", () => {
    const msgs = normalizeMetaMessages(
      envelope({ ...base, messages: [
        { id: "w1", from: "x", type: "location", location: { latitude: 51.5, longitude: -0.1 } },
        { id: "w2", from: "x", type: "contacts", contacts: [{}] },
        { id: "w3", from: "x", type: "interactive", interactive: { button_reply: { title: "Book now" } } },
      ] }) as never,
    );
    expect(msgs.map((m) => m.raw_text)).toEqual(["[location: 51.5,-0.1]", "[contact card]", "Book now"]);
  });

  it("drops a message with no id (unusable)", () => {
    const out = normalizeMetaMessages(
      envelope({ ...base, messages: [{ from: "x", type: "text", text: { body: "no id" } }] }) as never,
    );
    expect(out).toHaveLength(0);
  });

  it("extracts messages from MULTIPLE entries/changes in one envelope", () => {
    const multi = {
      object: "x",
      entry: [
        { id: "e1", changes: [{ value: { ...base, messages: [{ id: "a", from: "x", type: "text", text: { body: "one" } }] } }] },
        { id: "e2", changes: [{ value: { ...base, messages: [{ id: "b", from: "y", type: "text", text: { body: "two" } }] } }] },
      ],
    };
    expect(normalizeMetaMessages(multi as never)).toHaveLength(2);
  });
});

describe("normalizeMetaStatuses + parseMetaWhatsAppStatus", () => {
  it("maps delivered/failed to the SMS receipt vocabulary", () => {
    expect(parseMetaWhatsAppStatus({ id: "wamid.X", status: "delivered" })?.status).toBe("delivered");
    const failed = parseMetaWhatsAppStatus({ id: "wamid.Y", status: "failed", errors: [{ code: 131 }] });
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("131");
  });

  it("DROPS 'read' — no SMS-ledger analogue (documented limitation)", () => {
    expect(parseMetaWhatsAppStatus({ id: "wamid.Z", status: "read" })).toBeNull();
  });

  it("extracts status transitions carrying their phone_number_id", () => {
    const sts = normalizeMetaStatuses(
      envelope({ metadata: { phone_number_id: "PNID_1" }, statuses: [{ id: "wamid.S", status: "delivered" }] }) as never,
    );
    expect(sts[0]?.phone_number_id).toBe("PNID_1");
    expect(sts[0]?.wamid).toBe("wamid.S");
  });
});
