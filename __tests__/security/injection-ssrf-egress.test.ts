import { describe, it, expect, vi, beforeEach } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * INJ-03 — SSRF through tenant-supplied egress targets that did NOT go through
 * the outbound-webhook SSRF policy (lib/webhooks/ssrf).
 *
 *   (a) Web Push: `push_subscriptions.endpoint` is registered from the browser
 *       and the table is client-writable under RLS. sendOnePush did a raw
 *       `fetch(sub.endpoint)` — a POST to any URL a member chose, following
 *       redirects, from inside our network.
 *   (b) Enterprise SSO (OIDC): the discovery URL is admin-typed, and `jwks_uri` /
 *       `token_endpoint` come from that tenant-controlled discovery document.
 *       All three were fetched unvetted, redirects followed — and the
 *       /api/sso/oidc/<org>/start route that triggers discovery is unauthenticated.
 *
 * No network is touched: DNS is mocked and every refused case is refused BEFORE
 * a connection (asserted by a fetch spy that must stay uncalled).
 */

let mockLookup: (host: string, opts: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("dns disabled in tests"));
vi.mock("node:dns/promises", () => ({
  lookup: (host: string, opts: unknown) => mockLookup(host, opts),
}));
vi.mock("server-only", () => ({}));
// push.ts pulls these in at module scope; none is reached by sendOnePush.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/server/services/notification-preferences-service", () => ({ getPreferencesForUserKeys: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
vi.stubGlobal("fetch", fetchSpy);

const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function subscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    id: "sub-1",
    org_id: "org-1",
    user_id: "user-1",
    endpoint,
    p256dh: b64u(ecdh.getPublicKey()),
    auth: b64u(randomBytes(16)),
  } as never;
}

function vapid() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subject: "mailto:test@example.test" };
}

const INTERNAL_TARGETS = [
  "http://push.example.com/x", //                 not https
  "https://127.0.0.1/x", //                        loopback literal
  "https://169.254.169.254/latest/meta-data/", //  link-local metadata
  "https://10.0.0.5:8443/x", //                    RFC-1918
  "https://[::1]/x", //                            v6 loopback
  "https://[::ffff:127.0.0.1]/x", //               v4-mapped v6
  "https://2130706433/x", //                       decimal 127.0.0.1
  "https://0x7f000001/x", //                       hex 127.0.0.1
  "https://localhost/x",
  "https://intranet/x", //                         no-dot host
  "https://db.internal/x",
  "https://printer.local/x",
  "https://crewflow.uk/api/cron/push-drain", //    SSRF-to-self
  "https://anything.vercel.app/x",
  "not a url",
  "",
];

beforeEach(() => {
  fetchSpy.mockClear();
  mockLookup = () => Promise.reject(new Error("dns disabled in tests"));
});

describe("Web Push — a stored endpoint is vetted before any egress", async () => {
  const { sendOnePush } = await import("@/lib/notifications/push");

  it("refuses every internal / non-public endpoint, makes no connection, and prunes the row", async () => {
    let dnsCalled = false;
    mockLookup = () => {
      dnsCalled = true;
      return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    };
    for (const endpoint of INTERNAL_TARGETS) {
      const r = await sendOnePush(vapid(), subscription(endpoint), "{}");
      expect(r.ok, endpoint).toBe(false);
      expect(r.gone, `${endpoint} must be pruned`).toBe(true);
      expect(r.error, endpoint).toMatch(/^push_endpoint_blocked:/);
    }
    expect(dnsCalled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a public-looking name that RESOLVES to a private address (DNS rebind / internal alias)", async () => {
    mockLookup = () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]);
    const r = await sendOnePush(vapid(), subscription("https://push.attacker.example.com/x"), "{}");
    expect(r.ok).toBe(false);
    expect(r.gone).toBe(true);
    expect(r.error).toBe("push_endpoint_blocked:dns-private");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT prune on a transient DNS failure", async () => {
    mockLookup = () => Promise.reject(new Error("EAI_AGAIN"));
    const r = await sendOnePush(vapid(), subscription("https://fcm.googleapis.com/fcm/send/abc"), "{}");
    expect(r.ok).toBe(false);
    expect(r.gone).toBe(false);
    expect(r.error).toBe("push_endpoint_blocked:dns-failed");
  });

  it("the send path has no raw fetch — egress is the vetted, pinned, redirect-refusing door only", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "lib/notifications/push.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(src).toMatch(/safeWebhookFetch\(sub\.endpoint/);
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it("the settings action applies the same policy at registration", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "app/(app)/settings/push-actions.ts"), "utf8");
    expect(src).toMatch(/validateWebhookUrl\(endpoint\)\.ok/);
  });
});

describe("OIDC — discovery, jwks_uri and token_endpoint are vetted before any fetch", async () => {
  const { fetchDiscovery, fetchJwks, vetIdpUrl, idpFetchInit } = await import("@/lib/enterprise-sso/oidc");

  it("refuses every internal / non-public IdP URL without fetching", async () => {
    for (const url of INTERNAL_TARGETS) {
      await expect(fetchJwks(url), url).rejects.toThrow(/rejected by SSRF policy/);
      await expect(fetchDiscovery("https://idp.example.com", url || "http://x"), url).rejects.toThrow(
        /rejected by SSRF policy/,
      );
      await expect(vetIdpUrl(url, "token_endpoint"), url).rejects.toThrow(/rejected by SSRF policy/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an issuer-derived discovery URL that is internal", async () => {
    await expect(fetchDiscovery("https://169.254.169.254", null)).rejects.toThrow(/rejected by SSRF policy: ip-literal/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a public-looking IdP name that resolves to a private address", async () => {
    mockLookup = () => Promise.resolve([{ address: "10.1.2.3", family: 4 }]);
    await expect(fetchJwks("https://login.attacker.example.com/keys")).rejects.toThrow(/dns-private/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a vetted public IdP URL is fetched with redirects REFUSED", async () => {
    mockLookup = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] }), { status: 200 }));
    await expect(fetchJwks("https://login.example.com/keys")).resolves.toEqual({ keys: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect(idpFetchInit().redirect).toBe("error");
  });

  it("the callback route vets the discovery-supplied token_endpoint before POSTing the client secret", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "app/api/sso/oidc/[orgId]/callback/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/fetch\(await vetIdpUrl\(disco\.token_endpoint, "token_endpoint"\)/);
    expect(src).not.toMatch(/fetch\(disco\.token_endpoint/);
  });
});
