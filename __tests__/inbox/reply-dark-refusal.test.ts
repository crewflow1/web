import { describe, it, expect, vi } from "vitest";
import { sendInboxReply, type ProviderResolvers } from "@/server/services/inbox-send";
import type { EmailProvider, SmsProvider, WhatsAppProvider } from "@/lib/comms";

/**
 * P3 Inbox — the dark-safe send contract. The load-bearing property: when a channel's
 * provider is unset the reply is QUEUED (recorded, nothing sent) and sendInboxReply NEVER
 * throws and NEVER calls a provider. A test NEVER touches a real vendor — the provider
 * resolvers are injected (nulls for the dark path, fakes for the sent path).
 */

const DARK: ProviderResolvers = { email: () => null, sms: () => null, whatsapp: () => null };

function fakeEmail(spy?: (m: unknown) => void): EmailProvider {
  return {
    info: { provider: "resend", channel: "email" },
    async send(m) {
      spy?.(m);
      return { providerMessageId: "email-msg-1" };
    },
  };
}
function fakeSms(spy?: (m: unknown) => void): SmsProvider {
  return {
    info: { provider: "twilio", channel: "sms" },
    async send(m) {
      spy?.(m);
      return { providerMessageId: "sms-msg-1", status: "queued" };
    },
  };
}
function fakeWhatsApp(spy?: (m: unknown) => void): WhatsAppProvider {
  return {
    info: { provider: "meta", channel: "whatsapp" },
    async send(m) {
      spy?.(m);
      return { providerMessageId: "wamid-1" };
    },
  };
}

describe("dark-safe refusal (no provider configured)", () => {
  it("QUEUES an email reply and sends nothing", async () => {
    const r = await sendInboxReply(
      { channel: "email", destination: "cust@example.com", body: "hi" },
      DARK,
    );
    expect(r.status).toBe("queued");
    expect(r.failureReason).toBe("provider_not_configured");
    expect(r.providerMessageId).toBeNull();
    expect(r.destination).toBe("cust@example.com");
  });

  it("QUEUES an sms reply and sends nothing", async () => {
    const r = await sendInboxReply(
      { channel: "sms", destination: "+44 7700 900123", body: "hi" },
      DARK,
    );
    expect(r.status).toBe("queued");
    expect(r.failureReason).toBe("provider_not_configured");
    expect(r.destination).toBe("+447700900123"); // normalised to E.164
  });

  it("QUEUES a whatsapp reply and sends nothing", async () => {
    const r = await sendInboxReply({ channel: "whatsapp", destination: "+447700900123", body: "hi" }, DARK);
    expect(r.status).toBe("queued");
    expect(r.failureReason).toBe("provider_not_configured");
  });

  it("QUEUES voice/chat with no_transport_channel (never a provider even if one existed)", async () => {
    const email = vi.fn(() => fakeEmail());
    const sms = vi.fn(() => fakeSms());
    const whatsapp = vi.fn(() => fakeWhatsApp());
    for (const channel of ["voice", "chat"] as const) {
      const r = await sendInboxReply(
        { channel, destination: "anything", body: "hi" },
        { email, sms, whatsapp },
      );
      expect(r.status).toBe("queued");
      expect(r.failureReason).toBe("no_transport_channel");
    }
    // No transport ⇒ no resolver ever consulted.
    expect(email).not.toHaveBeenCalled();
    expect(sms).not.toHaveBeenCalled();
    expect(whatsapp).not.toHaveBeenCalled();
  });

  it("uses the default (real) resolvers when none injected — dark by default in test env", async () => {
    // No credentials in the test env ⇒ getXProvider() === null ⇒ queued, never sent.
    const r = await sendInboxReply({ channel: "sms", destination: "+447700900123", body: "hi" });
    expect(r.status).toBe("queued");
    expect(r.failureReason).toBe("provider_not_configured");
  });

  it("never throws on the dark path", async () => {
    await expect(
      sendInboxReply({ channel: "email", destination: "cust@example.com", body: "hi" }, DARK),
    ).resolves.toBeTruthy();
  });
});

describe("invalid destination is refused before any provider", () => {
  it("fails an email with a bad address", async () => {
    const spy = vi.fn();
    const r = await sendInboxReply(
      { channel: "email", destination: "not-an-email", body: "hi" },
      { email: () => fakeEmail(spy), sms: () => null, whatsapp: () => null },
    );
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("invalid_destination");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails an sms with an undialable number", async () => {
    const spy = vi.fn();
    const r = await sendInboxReply(
      { channel: "sms", destination: "xyz", body: "hi" },
      { email: () => null, sms: () => fakeSms(spy), whatsapp: () => null },
    );
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("invalid_destination");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("configured provider (fake) — the sent path", () => {
  it("sends email with subject + html and records the message id", async () => {
    const spy = vi.fn();
    const r = await sendInboxReply(
      { channel: "email", destination: "Cust <cust@example.com>", body: "line one\n\nline two", subject: "Re: quote" },
      { email: () => fakeEmail(spy), sms: () => null, whatsapp: () => null },
    );
    expect(r.status).toBe("sent");
    expect(r.provider).toBe("resend");
    expect(r.providerMessageId).toBe("email-msg-1");
    const sent = spy.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string };
    expect(sent.to).toBe("cust@example.com");
    expect(sent.subject).toBe("Re: quote");
    expect(sent.html).toContain("<p>line one</p>");
    expect(sent.text).toBe("line one\n\nline two");
  });

  it("whatsapp resolves ONLY the whatsapp provider — never the sms one", async () => {
    const smsSpy = vi.fn(() => fakeSms());
    const waSpy = vi.fn();
    const r = await sendInboxReply(
      { channel: "whatsapp", destination: "+447700900123", body: "hi" },
      { email: () => null, sms: smsSpy, whatsapp: () => fakeWhatsApp(waSpy) },
    );
    expect(r.status).toBe("sent");
    expect(r.provider).toBe("meta");
    expect(r.providerMessageId).toBe("wamid-1");
    expect(smsSpy).not.toHaveBeenCalled();
    expect(waSpy).toHaveBeenCalledOnce();
  });

  it("records a provider throw as failed/provider_error", async () => {
    const throwing: SmsProvider = {
      info: { provider: "twilio", channel: "sms" },
      async send() {
        throw new Error("network");
      },
    };
    const r = await sendInboxReply(
      { channel: "sms", destination: "+447700900123", body: "hi" },
      { email: () => null, sms: () => throwing, whatsapp: () => null },
    );
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("provider_error");
  });
});
