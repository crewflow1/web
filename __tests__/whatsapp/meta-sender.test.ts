import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Meta WhatsApp outbound sender (Part 9) — unit tier.
 *
 * Proves the sender obeys the provider contract WITHOUT a real Graph API call (fetch is
 * mocked): normalize a 200 into {providerMessageId, status}; THROW on any non-2xx, a
 * missing wamid, or missing creds so the transport records a failed/provider_error attempt;
 * and POST the exact Graph shape. Also pins the factory gate — configured ⇒ the real
 * provider, and getTransportProvider('whatsapp') resolves to it (the dark path is pinned in
 * transport-selection.test.ts). The sender is NEVER exercised in CI (creds unset there).
 */

// The sender + factory read WhatsApp creds from the parsed env (frozen at load), so mock the
// env module to present them. Other provider factories read their own (absent) keys → null.
vi.mock("@/lib/env", () => ({
  env: {
    WHATSAPP_ACCESS_TOKEN: "test-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "PNID_TEST",
    WHATSAPP_GRAPH_VERSION: undefined,
    COMMS_WHATSAPP_PROVIDER: undefined,
  },
}));

import { createMetaWhatsAppProvider } from "@/lib/comms/providers/meta-whatsapp-sender";
import { getWhatsAppProvider, getTransportProvider, isWhatsAppConfigured } from "@/lib/comms";

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const errResponse = (status: number, text: string) =>
  ({ ok: false, status, json: async () => null, text: async () => text }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("createMetaWhatsAppProvider — identity + the Graph API send contract", () => {
  it("advertises the meta:whatsapp identity", () => {
    expect(createMetaWhatsAppProvider().info).toEqual({ provider: "meta", channel: "whatsapp" });
  });

  it("normalizes a 200 into {providerMessageId, status} and POSTs the exact Graph shape", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ messages: [{ id: "wamid.SENT.1", message_status: "accepted" }] }),
    );
    const acceptance = await createMetaWhatsAppProvider().send({ to: "+447700900123", body: "hello" });
    expect(acceptance).toEqual({ providerMessageId: "wamid.SENT.1", status: "accepted" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://graph.facebook.com/v21.0/PNID_TEST/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-access-token");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: "+447700900123",
      type: "text",
      text: { body: "hello" },
    });
  });

  it("defaults status to null when the provider reports none", async () => {
    fetchMock.mockResolvedValue(okResponse({ messages: [{ id: "wamid.SENT.2" }] }));
    const acceptance = await createMetaWhatsAppProvider().send({ to: "+447700900123", body: "hi" });
    expect(acceptance.status).toBeNull();
  });

  it("THROWS on a non-2xx (out-of-window / bad token / rate-limit) — a recorded failure, never a leak", async () => {
    fetchMock.mockResolvedValue(errResponse(400, '{"error":{"code":131047,"message":"re-engagement"}}'));
    await expect(
      createMetaWhatsAppProvider().send({ to: "+447700900123", body: "x" }),
    ).rejects.toThrow(/send failed \(400\)/);
  });

  it("THROWS when the response carries no wamid (accepted but uncorrelatable)", async () => {
    fetchMock.mockResolvedValue(okResponse({ messages: [{}] }));
    await expect(
      createMetaWhatsAppProvider().send({ to: "+447700900123", body: "x" }),
    ).rejects.toThrow(/no wamid/);
  });
});

describe("getWhatsAppProvider — configured AND enabled ⇒ the real Meta provider (creds mocked present)", () => {
  // Credentials alone are NOT sufficient: getWhatsAppProvider also requires
  // NEXT_PUBLIC_FEATURE_WHATSAPP="true", so the flag kills the human-approval send path too
  // (see transport-selection.test.ts for the kill-switch suite). The mocked env above supplies
  // the creds; the flag is read from process.env, so it is stubbed per-test here.
  afterEach(() => vi.unstubAllEnvs());

  it("returns a live provider when both creds are set AND the flag is on, and getTransportProvider routes to it", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    const provider = getWhatsAppProvider();
    expect(provider).not.toBeNull();
    expect(provider?.info).toEqual({ provider: "meta", channel: "whatsapp" });
    expect(isWhatsAppConfigured()).toBe(true);
    // The 'whatsapp' transport channel resolves to a Meta provider — never the SMS factory.
    // (Each call constructs a fresh instance, so compare identity, not reference.)
    expect(getTransportProvider("whatsapp")?.info).toEqual({ provider: "meta", channel: "whatsapp" });
  });

  it("the SAME full credentials with the flag off ⇒ null — creds alone can never send", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "false");
    expect(getWhatsAppProvider()).toBeNull();
    expect(isWhatsAppConfigured()).toBe(false);
    expect(getTransportProvider("whatsapp")).toBeNull();
  });
});
