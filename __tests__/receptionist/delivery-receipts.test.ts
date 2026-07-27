import { afterEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  SMS_DELIVERY_STATUSES,
  TERMINAL_SMS_DELIVERY_STATUSES,
  isSmsDeliveryStatus,
  isTerminalSmsDeliveryStatus,
} from "@/lib/comms";
import {
  parseTwilioSmsStatusCallback,
  verifyTwilioSignature,
} from "@/lib/comms/providers/twilio";

/**
 * Async delivery receipts — the provider-neutral vocabulary + the Twilio callback
 * adapter, unit tier (the AI Receptionist Programme, R7 — ASYNC DELIVERY RECEIPTS).
 *
 * These pin the three pure/near-pure primitives the R7 callback stands on, WITHOUT a
 * database or the network:
 *   1. the canonical delivery-status vocabulary + its terminal subset (lib/comms/types),
 *   2. `parseTwilioSmsStatusCallback` — Twilio's raw params → a neutral receipt (or null),
 *   3. `verifyTwilioSignature` — the SDK-owned request authentication.
 *
 * The end-to-end correlation, idempotency and append-only proofs run against real
 * Postgres in __tests__/integration/receptionist/delivery-receipts-pipeline.test.ts;
 * the route's 401/400/404/200/500 decision tree is pinned in
 * __tests__/receptionist/twilio-sms-status-route.test.ts.
 */

/**
 * Twilio's reference signing algorithm (twilio-node `getExpectedTwilioSignature`):
 * concatenate the URL with each POST param (key then value) in KEY-sorted order, then
 * HMAC-SHA1 with the auth token and base64. Recomputing it here lets us mint a genuinely
 * valid `X-Twilio-Signature` and prove the verifier accepts the real thing and rejects
 * every tampering — never a hand-waved stub.
 */
function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

describe("SMS delivery status vocabulary", () => {
  it("SMS_DELIVERY_STATUSES is the nine canonical statuses in lifecycle order", () => {
    expect(SMS_DELIVERY_STATUSES).toEqual([
      "accepted",
      "scheduled",
      "queued",
      "sending",
      "sent",
      "delivered",
      "undelivered",
      "failed",
      "canceled",
    ]);
  });

  it("isSmsDeliveryStatus accepts every canonical status", () => {
    for (const status of SMS_DELIVERY_STATUSES) {
      expect(isSmsDeliveryStatus(status), status).toBe(true);
    }
  });

  it("isSmsDeliveryStatus rejects unknown / empty / non-string values", () => {
    for (const value of ["bogus", "DELIVERED", "", "  ", "delivered ", 42, null, undefined, {}]) {
      expect(isSmsDeliveryStatus(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("TERMINAL_SMS_DELIVERY_STATUSES is a subset of SMS_DELIVERY_STATUSES", () => {
    expect(TERMINAL_SMS_DELIVERY_STATUSES).toEqual([
      "delivered",
      "undelivered",
      "failed",
      "canceled",
    ]);
    for (const status of TERMINAL_SMS_DELIVERY_STATUSES) {
      expect(SMS_DELIVERY_STATUSES as readonly string[]).toContain(status);
    }
  });

  it("isTerminalSmsDeliveryStatus is true for exactly the four terminal states", () => {
    for (const status of SMS_DELIVERY_STATUSES) {
      const expected = (TERMINAL_SMS_DELIVERY_STATUSES as readonly string[]).includes(status);
      expect(isTerminalSmsDeliveryStatus(status), status).toBe(expected);
    }
    // A canonical-but-non-terminal status is explicitly NOT terminal.
    expect(isTerminalSmsDeliveryStatus("queued")).toBe(false);
    expect(isTerminalSmsDeliveryStatus("sent")).toBe(false);
    // And an unknown value never counts as terminal.
    expect(isTerminalSmsDeliveryStatus("bogus")).toBe(false);
  });
});

describe("parseTwilioSmsStatusCallback", () => {
  it("parses MessageSid + MessageStatus into a canonical receipt", () => {
    expect(
      parseTwilioSmsStatusCallback({ MessageSid: "SM123", MessageStatus: "delivered" }),
    ).toEqual({
      providerMessageId: "SM123",
      status: "delivered",
      providerStatus: null,
      errorCode: null,
    });
  });

  it("accepts the legacy SmsSid / SmsStatus aliases", () => {
    expect(
      parseTwilioSmsStatusCallback({ SmsSid: "SM999", SmsStatus: "sent" }),
    ).toEqual({
      providerMessageId: "SM999",
      status: "sent",
      providerStatus: null,
      errorCode: null,
    });
  });

  it("prefers MessageSid over the legacy SmsSid when both are present", () => {
    const receipt = parseTwilioSmsStatusCallback({
      MessageSid: "SMnew",
      SmsSid: "SMold",
      MessageStatus: "queued",
    });
    expect(receipt?.providerMessageId).toBe("SMnew");
  });

  it("lower-cases the status and preserves the raw casing in providerStatus", () => {
    expect(
      parseTwilioSmsStatusCallback({ MessageSid: "SM1", MessageStatus: "Delivered" }),
    ).toEqual({
      providerMessageId: "SM1",
      status: "delivered",
      providerStatus: "Delivered",
      errorCode: null,
    });
  });

  it("captures ErrorCode on a non-delivery", () => {
    expect(
      parseTwilioSmsStatusCallback({
        MessageSid: "SM1",
        MessageStatus: "undelivered",
        ErrorCode: "30008",
      }),
    ).toEqual({
      providerMessageId: "SM1",
      status: "undelivered",
      providerStatus: null,
      errorCode: "30008",
    });
  });

  it("returns null for a status outside the canonical vocabulary", () => {
    expect(
      parseTwilioSmsStatusCallback({ MessageSid: "SM1", MessageStatus: "bogus" }),
    ).toBeNull();
  });

  it("returns null when the message sid is missing", () => {
    expect(parseTwilioSmsStatusCallback({ MessageStatus: "delivered" })).toBeNull();
  });

  it("returns null when the status is missing", () => {
    expect(parseTwilioSmsStatusCallback({ MessageSid: "SM1" })).toBeNull();
  });

  it("trims surrounding whitespace on the sid and status", () => {
    expect(
      parseTwilioSmsStatusCallback({ MessageSid: "  SM1  ", MessageStatus: "  delivered  " }),
    ).toEqual({
      providerMessageId: "SM1",
      status: "delivered",
      providerStatus: null,
      errorCode: null,
    });
  });
});

describe("verifyTwilioSignature", () => {
  const TOKEN = "unit_test_auth_token_deadbeef";
  const URL = "https://app.crewflow.uk/api/webhooks/twilio/sms-status";
  const PARAMS = { MessageSid: "SM123", MessageStatus: "delivered" };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true for a correctly computed X-Twilio-Signature", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    await expect(
      verifyTwilioSignature({ signature, url: URL, params: PARAMS }),
    ).resolves.toBe(true);
  });

  it("returns false when the params are tampered after signing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    await expect(
      verifyTwilioSignature({
        signature,
        url: URL,
        params: { ...PARAMS, MessageStatus: "failed" },
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the signed URL differs (proxy/host mismatch)", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    await expect(
      verifyTwilioSignature({ signature, url: `${URL}?tampered=1`, params: PARAMS }),
    ).resolves.toBe(false);
  });

  it("returns false when the signature header is missing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    await expect(
      verifyTwilioSignature({ signature: null, url: URL, params: PARAMS }),
    ).resolves.toBe(false);
    await expect(
      verifyTwilioSignature({ signature: undefined, url: URL, params: PARAMS }),
    ).resolves.toBe(false);
  });

  it("returns false when the auth token is not configured (fail closed)", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    await expect(
      verifyTwilioSignature({ signature, url: URL, params: PARAMS }),
    ).resolves.toBe(false);
  });

  it("returns false for a malformed signature string", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    await expect(
      verifyTwilioSignature({ signature: "!!!not-base64!!!", url: URL, params: PARAMS }),
    ).resolves.toBe(false);
  });
});
