import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * sentry.client.config.ts — consent wiring drift guard.
 *
 * lib/monitoring/consent-transport.ts only protects anything if the browser
 * config actually routes every envelope through it AND asks the real consent
 * store. This imports the real client config (SDK mocked) and drives the
 * transport it hands to Sentry.init end-to-end: cookie → consent → envelope.
 * Removing the `transport` option, or wiring it to something that ignores the
 * stored choice, fails here.
 */

const { initMock, innerSend } = vi.hoisted(() => ({
  initMock: vi.fn(),
  innerSend: vi.fn(async (_envelope: unknown) => ({ statusCode: 200 })),
}));
vi.mock("@sentry/nextjs", () => ({
  init: (opts: unknown) => initMock(opts),
  makeFetchTransport: () => ({ send: innerSend, flush: async () => true }),
}));

type Envelope = [unknown, Array<[{ type: string }, unknown]>];
type Transport = { send: (e: Envelope) => PromiseLike<unknown> };
const g = globalThis as unknown as {
  window?: { location: { pathname: string; protocol: string } };
  document?: { cookie: string };
};

const env = (...types: string[]): Envelope => [{}, types.map((t) => [{ type: t }, {}])];
const sentTypes = () =>
  innerSend.mock.calls.map((c) => (c[0] as Envelope)[1].map((i) => i[0].type));

function browser(pathname: string, cookie: string) {
  g.window = { location: { pathname, protocol: "https:" } };
  g.document = { cookie };
}

let transport: Transport;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
  await import("../../sentry.client.config");
  expect(initMock).toHaveBeenCalledTimes(1);
  const opts = initMock.mock.calls[0]![0] as { transport?: (o: unknown) => Transport };
  expect(typeof opts.transport).toBe("function");
  transport = opts.transport!({});
});

afterEach(() => {
  innerSend.mockClear();
  delete g.window;
  delete g.document;
});

describe("sentry.client.config consent-gated transport", () => {
  it("with no consent cookie: the page-load session ping is not sent, an error is", async () => {
    browser("/", "");
    await transport.send(env("session"));
    expect(innerSend).not.toHaveBeenCalled();
    await transport.send(env("event"));
    expect(sentTypes()).toEqual([["event"]]);
  });

  it("after Reject all: still only errors", async () => {
    browser("/dashboard", "cf_cookie_consent=v2.t1794564000.analytics0.performance0");
    await transport.send(env("session"));
    await transport.send(env("transaction"));
    expect(innerSend).not.toHaveBeenCalled();
  });

  it("analytics-only consent does NOT unlock performance telemetry", async () => {
    browser("/", "cf_cookie_consent=v2.t1794564000.analytics1.performance0");
    await transport.send(env("session"));
    expect(innerSend).not.toHaveBeenCalled();
    // …and neither does the legacy v1 'granted' cookie
    browser("/", "cf_cookie_consent=granted");
    await transport.send(env("session"));
    expect(innerSend).not.toHaveBeenCalled();
  });

  it("performance consent unlocks the session ping", async () => {
    browser("/", "cf_cookie_consent=v2.t1794564000.analytics0.performance1");
    await transport.send(env("session"));
    expect(sentTypes()).toEqual([["session"]]);
  });

  it("never on external surfaces, even with consent — errors still flow", async () => {
    const cookie = "cf_cookie_consent=v2.t1794564000.analytics1.performance1";
    for (const path of ["/customer-portal/tok/invoices", "/q/tok", "/worker-portal/tok", "/l/acme"]) {
      browser(path, cookie);
      await transport.send(env("session", "transaction"));
    }
    expect(innerSend).not.toHaveBeenCalled();
    browser("/q/tok", cookie);
    await transport.send(env("event", "session"));
    expect(sentTypes()).toEqual([["event"]]);
  });
});
