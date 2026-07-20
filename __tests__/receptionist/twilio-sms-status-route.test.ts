import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Twilio SMS status-callback route — the decision tree, unit tier (the AI Receptionist
 * Programme, R7 — ASYNC DELIVERY RECEIPTS).
 *
 * POST /api/webhooks/twilio/sms-status is the ONE inbound door for an async delivery
 * receipt. These tests pin its 401/400/404/200/500 mapping against a GENUINELY signed
 * request (a real `X-Twilio-Signature` recomputed with Node crypto), proving:
 *   - an authentic callback records exactly one receipt and returns 200,
 *   - an invalid / missing / wrong-token signature is rejected 401 BEFORE any side effect,
 *   - a malformed / unknown-status payload is rejected 400,
 *   - an unknown provider message id is rejected 404,
 *   - a duplicate is an idempotent 200 no-op,
 *   - a persistence error surfaces as 500 (so Twilio retries),
 *   - the signed URL is reconstructed from forwarded headers when no explicit callback
 *     URL is configured (the production path behind Vercel's proxy).
 *
 * Only the canonical persistence path (`recordSmsDeliveryReceipt`) is mocked — the
 * Twilio verification and parsing run for real, so the auth gate is proven, not stubbed.
 */

vi.mock("@/server/services/receptionist", () => ({
  recordSmsDeliveryReceipt: vi.fn(),
}));

// Late import so the mock is applied before the route module binds its import.
async function loadRoute() {
  return import("@/app/api/webhooks/twilio/sms-status/route");
}
async function recordMock() {
  const { recordSmsDeliveryReceipt } = await import("@/server/services/receptionist");
  return vi.mocked(recordSmsDeliveryReceipt);
}

const TOKEN = "route_test_auth_token_abc123";
const CALLBACK_URL = "https://app.crewflow.uk/api/webhooks/twilio/sms-status";

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

function buildRequest(opts: {
  params: Record<string, string>;
  signature: string | null;
  requestUrl?: string;
  extraHeaders?: Record<string, string>;
}): Request {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    ...(opts.extraHeaders ?? {}),
  });
  if (opts.signature !== null) headers.set("x-twilio-signature", opts.signature);
  return new Request(
    opts.requestUrl ?? "https://internal.vercel.local/api/webhooks/twilio/sms-status",
    {
      method: "POST",
      headers,
      body: new URLSearchParams(opts.params).toString(),
    },
  );
}

/** A request carrying a VALID signature over CALLBACK_URL for the given params. */
function signedRequest(params: Record<string, string>): Request {
  return buildRequest({ params, signature: twilioSignature(TOKEN, CALLBACK_URL, params) });
}

describe("POST /api/webhooks/twilio/sms-status", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    // Pin the signed URL so the crafted signature is deterministic (the explicit
    // callback URL wins over header reconstruction).
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", CALLBACK_URL);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    (await recordMock()).mockReset();
  });

  it("records an authentic terminal callback and returns 200", async () => {
    const record = await recordMock();
    record.mockResolvedValue({
      recorded: true,
      duplicate: false,
      receipt_id: "receipt-1",
      transport_id: "transport-1",
      reply_audit_id: "audit-1",
      org_id: "org-1",
      status: "delivered",
      terminal: true,
    });

    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ MessageSid: "SM1", MessageStatus: "delivered" }) as never,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      recorded: true,
      duplicate: false,
      status: "delivered",
      terminal: true,
    });
    // Correlated by the provider message id, with the normalised receipt — nothing else.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      providerMessageId: "SM1",
      status: "delivered",
      providerStatus: null,
      errorCode: null,
    });
  });

  it("is an idempotent 200 no-op for a duplicate callback", async () => {
    const record = await recordMock();
    record.mockResolvedValue({
      recorded: true,
      duplicate: true,
      receipt_id: "receipt-1",
      transport_id: "transport-1",
      reply_audit_id: "audit-1",
      org_id: "org-1",
      status: "delivered",
      terminal: true,
    });

    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ MessageSid: "SM1", MessageStatus: "delivered" }) as never,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, duplicate: true });
  });

  it("rejects a tampered payload with 401 and records nothing", async () => {
    const record = await recordMock();
    // Sign the original params, then send DIFFERENT params under that signature.
    const signature = twilioSignature(TOKEN, CALLBACK_URL, {
      MessageSid: "SM1",
      MessageStatus: "delivered",
    });
    const req = buildRequest({
      params: { MessageSid: "SM1", MessageStatus: "failed" },
      signature,
    });

    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: "signature_verification_failed",
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header with 401 and records nothing", async () => {
    const record = await recordMock();
    const req = buildRequest({
      params: { MessageSid: "SM1", MessageStatus: "delivered" },
      signature: null,
    });

    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a signature minted with the wrong token with 401", async () => {
    const record = await recordMock();
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    // Attacker signs with a token that is NOT the configured one.
    const req = buildRequest({
      params,
      signature: twilioSignature("attacker_token", CALLBACK_URL, params),
    });

    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects an authentic-but-malformed payload (unknown status) with 400", async () => {
    const record = await recordMock();
    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ MessageSid: "SM1", MessageStatus: "not-a-status" }) as never,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "unsupported_or_malformed_callback",
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects an authentic payload with no message sid with 400", async () => {
    const record = await recordMock();
    const { POST } = await loadRoute();
    const res = await POST(signedRequest({ MessageStatus: "delivered" }) as never);

    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider message id with 404", async () => {
    const record = await recordMock();
    record.mockResolvedValue({ recorded: false, reason: "unknown_message" });

    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ MessageSid: "SMunknown", MessageStatus: "delivered" }) as never,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "unknown_message" });
  });

  it("surfaces a persistence error as 500 so Twilio retries", async () => {
    const record = await recordMock();
    record.mockRejectedValue(new Error("ai_reply_delivery_receipts write failed"));

    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ MessageSid: "SM1", MessageStatus: "delivered" }) as never,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });

  it("reconstructs the signed URL from forwarded headers when no callback URL is set", async () => {
    // Production path behind Vercel's proxy: TWILIO_STATUS_CALLBACK_URL unset, so the
    // route rebuilds proto/host from x-forwarded-* headers. The signature is minted over
    // THAT reconstructed URL — if the route reconstructs it wrongly, verification fails.
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    const record = await recordMock();
    record.mockResolvedValue({
      recorded: true,
      duplicate: false,
      receipt_id: "receipt-1",
      transport_id: "transport-1",
      reply_audit_id: "audit-1",
      org_id: "org-1",
      status: "delivered",
      terminal: true,
    });

    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const reconstructed = "https://app.crewflow.uk/api/webhooks/twilio/sms-status";
    const req = buildRequest({
      params,
      signature: twilioSignature(TOKEN, reconstructed, params),
      requestUrl: "https://internal.vercel.local/api/webhooks/twilio/sms-status",
      extraHeaders: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.crewflow.uk",
      },
    });

    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
