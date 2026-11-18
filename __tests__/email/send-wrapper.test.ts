import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * lib/email/send.ts — the thin Resend SDK wrapper (streams 7 · comms verification).
 *
 * This is CrewFlow's single outbound-email transport: every quote, invoice,
 * reminder, statement, portal reply and staff invite funnels through
 * `sendEmail`. Yet the whole existing suite MOCKS this module away (manual
 * reminder, active-org gate, quote follow-up, staff invite, report delivery,
 * demo route …), so the wrapper's own contract — degrade without a key, refuse
 * a self-loop, DISPATCH with the right shape, and never SILENTLY DROP a provider
 * failure — was unverified. These tests mock the `resend` SDK (nothing ever
 * reaches a transport) and pin that contract.
 *
 * The load-bearing property is the last one: a transient Resend failure must
 * come back as a typed `{ sent: false }` the caller can surface, NOT a thrown
 * 500 and NOT a false "sent". Three failure channels exist and are all proven
 * here: SDK throw, `res.error`, and a success envelope with no id.
 */

// Mutable env the wrapper reads at call time (env.RESEND_API_KEY etc). Mocking
// @/lib/env lets us toggle the key per-test without a real validated env.
const envState = vi.hoisted(() => ({
  RESEND_API_KEY: "re_test_key" as string | undefined,
  RESEND_FROM_EMAIL: "CrewFlow <hello@crewflow.uk>",
  RESEND_REPLY_TO: "hello@crewflow.uk",
}));
vi.mock("@/lib/env", () => ({ env: envState }));

// The Resend SDK double. `sendMock` is the single sink for everything the
// wrapper would put on the wire; `ctorKeys` records the API key the wrapper
// constructs the client with.
const resendMock = vi.hoisted(() => {
  const sendMock = vi.fn((_payload: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve({ data: { id: "re_default" }, error: null }),
  );
  const ctorKeys: string[] = [];
  class Resend {
    emails: { send: typeof sendMock };
    constructor(key: string) {
      ctorKeys.push(key);
      this.emails = { send: sendMock };
    }
  }
  return { sendMock, ctorKeys, Resend };
});
vi.mock("resend", () => ({ Resend: resendMock.Resend }));

const { sendEmail } = await import("@/lib/email/send");

beforeEach(() => {
  resendMock.sendMock.mockReset();
  resendMock.ctorKeys.length = 0;
  envState.RESEND_API_KEY = "re_test_key";
  envState.RESEND_FROM_EMAIL = "CrewFlow <hello@crewflow.uk>";
  envState.RESEND_REPLY_TO = "hello@crewflow.uk";
});

describe("sendEmail — graceful degradation", () => {
  it("returns reason:no_key and NEVER constructs the SDK when the API key is unset", async () => {
    envState.RESEND_API_KEY = undefined;
    const res = await sendEmail({ to: "a@example.com", subject: "x", html: "<p>x</p>" });
    expect(res).toEqual({ sent: false, reason: "no_key" });
    expect(resendMock.ctorKeys).toHaveLength(0);
    expect(resendMock.sendMock).not.toHaveBeenCalled();
  });
});

describe("sendEmail — self-loop guard (From === To is silently dropped by Gmail/Workspace)", () => {
  it("refuses when a display-name From and a bare To collapse to the same mailbox", async () => {
    const res = await sendEmail({
      from: "CrewFlow <hello@crewflow.uk>",
      to: "HELLO@crewflow.uk", // case-insensitive address extraction
      subject: "x",
      html: "<p>x</p>",
    });
    expect(res.sent).toBe(false);
    if (res.sent === false && res.reason === "self_loop") {
      expect(res.from).toBe("CrewFlow <hello@crewflow.uk>");
      expect(res.to).toBe("HELLO@crewflow.uk");
    } else {
      throw new Error(`expected self_loop, got ${JSON.stringify(res)}`);
    }
    // Guard fires BEFORE any dispatch.
    expect(resendMock.sendMock).not.toHaveBeenCalled();
  });

  it("refuses when ANY recipient in a To[] array is the From mailbox", async () => {
    const res = await sendEmail({
      from: "notify@crewflow.uk",
      to: ["customer@example.com", "notify@crewflow.uk"],
      subject: "x",
      html: "<p>x</p>",
    });
    expect(res.sent).toBe(false);
    if (res.sent === false) expect(res.reason).toBe("self_loop");
    expect(resendMock.sendMock).not.toHaveBeenCalled();
  });

  it("does NOT fire for a distinct recipient (the happy path still dispatches)", async () => {
    resendMock.sendMock.mockResolvedValue({ data: { id: "re_ok" }, error: null });
    const res = await sendEmail({
      from: "notify@crewflow.uk",
      to: "customer@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(res).toEqual({ sent: true, id: "re_ok" });
  });
});

describe("sendEmail — dispatch shape (what actually reaches Resend)", () => {
  it("constructs the client with the key and sends with from/to/subject/html/text/replyTo", async () => {
    resendMock.sendMock.mockResolvedValue({ data: { id: "re_123" }, error: null });

    const res = await sendEmail({
      to: "customer@example.com",
      subject: "Invoice INV-001",
      html: "<p>pay up</p>",
      text: "pay up",
    });

    expect(res).toEqual({ sent: true, id: "re_123" });
    expect(resendMock.ctorKeys).toEqual(["re_test_key"]);
    expect(resendMock.sendMock).toHaveBeenCalledTimes(1);
    const payload = resendMock.sendMock.mock.calls[0]![0];
    expect(payload).toMatchObject({
      from: "CrewFlow <hello@crewflow.uk>", // defaulted from env
      to: "customer@example.com",
      subject: "Invoice INV-001",
      html: "<p>pay up</p>",
      text: "pay up",
      replyTo: "hello@crewflow.uk", // defaulted from env
    });
  });

  it("honours explicit from/replyTo overrides over the env defaults", async () => {
    resendMock.sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });
    await sendEmail({
      to: "customer@example.com",
      from: "Acme Builders <notify@crewflow.uk>",
      replyTo: "owner@acme.example",
      subject: "s",
      html: "<p>h</p>",
    });
    const payload = resendMock.sendMock.mock.calls[0]![0];
    expect(payload.from).toBe("Acme Builders <notify@crewflow.uk>");
    expect(payload.replyTo).toBe("owner@acme.example");
  });

  it("normalises a Uint8Array attachment to a Buffer (Resend requires a Buffer)", async () => {
    resendMock.sendMock.mockResolvedValue({ data: { id: "re_pdf" }, error: null });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await sendEmail({
      to: "customer@example.com",
      subject: "Quote QUO-9",
      html: "<p>h</p>",
      attachments: [{ filename: "QUO-9.pdf", content: bytes }],
    });
    const payload = resendMock.sendMock.mock.calls[0]![0];
    const attachments = payload.attachments as Array<{ filename: string; content: Buffer }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("QUO-9.pdf");
    expect(Buffer.isBuffer(attachments[0]!.content)).toBe(true);
    expect([...attachments[0]!.content]).toEqual([1, 2, 3, 4]);
  });
});

describe("sendEmail — failures are SURFACED, never silently dropped", () => {
  it("a provider rejection (res.error) becomes reason:error carrying the message", async () => {
    resendMock.sendMock.mockResolvedValue({
      data: null,
      error: { message: "domain not verified", name: "validation_error" },
    });
    const res = await sendEmail({ to: "c@example.com", subject: "x", html: "<p>x</p>" });
    expect(res.sent).toBe(false);
    if (res.sent === false && res.reason === "error") {
      expect(res.error).toBe("domain not verified");
    } else {
      throw new Error(`expected error, got ${JSON.stringify(res)}`);
    }
  });

  it("a success envelope with no id is treated as a failure (no false 'sent')", async () => {
    resendMock.sendMock.mockResolvedValue({ data: {}, error: null });
    const res = await sendEmail({ to: "c@example.com", subject: "x", html: "<p>x</p>" });
    expect(res.sent).toBe(false);
    if (res.sent === false && res.reason === "error") {
      expect(res.error).toBe("no_id_returned");
    } else {
      throw new Error(`expected error:no_id_returned, got ${JSON.stringify(res)}`);
    }
  });

  it("an SDK THROW is caught and returned as reason:error (the route never 500s)", async () => {
    resendMock.sendMock.mockRejectedValue(new Error("ECONNRESET talking to Resend"));
    const res = await sendEmail({ to: "c@example.com", subject: "x", html: "<p>x</p>" });
    expect(res.sent).toBe(false);
    if (res.sent === false && res.reason === "error") {
      expect(res.error).toContain("ECONNRESET");
    } else {
      throw new Error(`expected error, got ${JSON.stringify(res)}`);
    }
  });

  it("a non-Error throw is still classified (String() fallback, never a crash)", async () => {
    resendMock.sendMock.mockRejectedValue("string blow-up");
    const res = await sendEmail({ to: "c@example.com", subject: "x", html: "<p>x</p>" });
    expect(res.sent).toBe(false);
    if (res.sent === false) expect(res.reason).toBe("error");
  });
});
