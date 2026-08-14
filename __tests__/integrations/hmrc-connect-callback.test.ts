import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * HMRC MTD OAuth — CONNECT substrate drives a REAL callback (c70b).
 *
 * THE BUG. The callback sourced the VRN ONLY from `searchParams.get('vrn')`, but
 * HMRC's OAuth2 authorize/callback returns ONLY `code`+`state` — never a `vrn`.
 * So on any real redirect `vrn` was null, the `if (!vrn) return no_vrn` fired
 * AFTER a successful token exchange, and the DB CHECK
 * (`status='connected'` ⇒ `hmrc_vrn` not null) meant a connected row could NEVER
 * be written. Activation was a permanent dead-end, not a config flip.
 *
 * THE FIX, proven here:
 *   (a) a code+state-ONLY callback (no `vrn` param, no stashed cookie) for an org
 *       that HAS `organizations.vat_number` now writes `status='connected'` with
 *       `hmrc_vrn` resolved from the org (fresh authed re-read fallback);
 *   (b) the same callback with the VRN stashed in the connect cookie uses the
 *       stash; and
 *   (c) the connect INITIATION route REFUSES an org with NO `vat_number` up front
 *       (redirect to settings with a precondition code) instead of dead-ending
 *       post-exchange, and when the org HAS a VAT number it stashes it and 302s to
 *       HMRC.
 *
 * Hermetic: no live HMRC HTTP (the OAuth module is faked connectable), no real
 * Supabase (an in-memory fake). The DARK invariant is untouched — this FORCES the
 * connectable path via mocks purely to exercise the substrate; production stays
 * dark (isHmrcConnectable is false without credentials + flag).
 */

const h = vi.hoisted(() => {
  const state: {
    orgVatNumber: string | null;
    upserts: Array<Record<string, unknown>>;
  } = { orgVatNumber: "GB123456789", upserts: [] };

  function organizationsBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () =>
        Promise.resolve({ data: { vat_number: state.orgVatNumber }, error: null }),
    };
    return builder;
  }
  function hmrcConnectionsBuilder() {
    return {
      upsert: (row: Record<string, unknown>) => {
        state.upserts.push(row);
        return Promise.resolve({ error: null });
      },
    };
  }
  const fakeClient = {
    from: (t: string) =>
      t === "organizations" ? organizationsBuilder() : hmrcConnectionsBuilder(),
  };
  return { state, fakeClient };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.fakeClient }));
vi.mock("@/lib/integrations/token-crypto", () => ({
  encryptToken: (v: string) => `enc(${v})`,
  isTokenEncryptionConfigured: () => true,
}));
vi.mock("@/lib/integrations/hmrc/oauth", () => ({
  isHmrcFlow: (v: unknown) => v === "vat" || v === "cis",
  isHmrcConnectable: () => true,
  buildAuthorizeUrl: (_flow: string, _redirectUri: string) => ({
    ok: true,
    challenge: {
      url: "https://www.tax.service.gov.uk/oauth/authorize?client_id=x",
      state: "server-state",
      codeVerifier: "server-verifier",
    },
  }),
  exchangeCodeForTokens: async () => ({
    ok: true,
    tokens: { accessToken: "acc", refreshToken: "ref", expiresAt: "2099-01-01T00:00:00Z" },
  }),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { membership: { role: "owner" }, org: { id: "org-A" } },
    user: { id: "user-1" },
  }),
}));

const { GET: CALLBACK } = await import(
  "@/app/api/integrations/hmrc/[flow]/callback/route"
);
const { GET: CONNECT } = await import(
  "@/app/api/integrations/hmrc/[flow]/connect/route"
);

const STATE = "st-callback-123";
const params = (flow: string) => Promise.resolve({ flow });

function callbackReq(flow: string, opts: { withVrnCookie?: boolean } = {}): NextRequest {
  const url = `https://crewflow.uk/api/integrations/hmrc/${flow}/callback?code=c1&state=${STATE}`;
  const cookies = [
    `hmrc_oauth_state_${flow}=${STATE}`,
    `hmrc_oauth_verifier_${flow}=verifier-1`,
  ];
  if (opts.withVrnCookie) cookies.push(`hmrc_oauth_vrn_${flow}=GB999888777`);
  return new NextRequest(url, { headers: { cookie: cookies.join("; ") } });
}

function connectReq(flow: string): NextRequest {
  return new NextRequest(`https://crewflow.uk/api/integrations/hmrc/${flow}/connect`);
}

beforeEach(() => {
  h.state.orgVatNumber = "GB123456789";
  h.state.upserts = [];
});

describe("hmrc callback · resolves VRN from the org, not a param HMRC never sends", () => {
  it("code+state-ONLY callback (no vrn param/cookie) writes connected with hmrc_vrn from organizations.vat_number", async () => {
    const res = await CALLBACK(callbackReq("vat"), { params: params("vat") });

    // Lands back on settings as connected — NOT the old no_vrn dead-end.
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/settings/integrations");
    expect(loc.searchParams.get("hmrc")).toBe("connected");

    // A connected row was written with the VRN sourced from the org.
    expect(h.state.upserts).toHaveLength(1);
    const row = h.state.upserts[0]!;
    expect(row.status).toBe("connected");
    expect(row.hmrc_vrn).toBe("GB123456789");
    // Tokens are still encrypted before the DB write.
    expect(row.access_token).toBe("enc(acc)");
  });

  it("prefers the VRN stashed by the connect route (cookie) when present", async () => {
    const res = await CALLBACK(callbackReq("vat", { withVrnCookie: true }), {
      params: params("vat"),
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("hmrc")).toBe("connected");
    expect(h.state.upserts[0]!.hmrc_vrn).toBe("GB999888777");
  });

  it("only returns no_vrn when the org TRULY has no VAT number", async () => {
    h.state.orgVatNumber = null;
    const res = await CALLBACK(callbackReq("vat"), { params: params("vat") });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("hmrc")).toBe("no_vrn");
    expect(h.state.upserts).toHaveLength(0);
  });
});

describe("hmrc connect · precondition-checks the VAT number at INITIATION", () => {
  it("REFUSES an org with no vat_number up front (redirect to settings, no HMRC redirect)", async () => {
    h.state.orgVatNumber = null;
    const res = await CONNECT(connectReq("vat"), { params: params("vat") });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/settings/integrations");
    expect(loc.searchParams.get("hmrc")).toBe("no_vat_number");
    // It must NOT dead-end the tenant at HMRC's authorize endpoint.
    expect(loc.host).not.toContain("tax.service.gov.uk");
  });

  it("with a vat_number present, stashes it and 302s to HMRC", async () => {
    const res = await CONNECT(connectReq("vat"), { params: params("vat") });
    expect(res.headers.get("location")).toContain("tax.service.gov.uk/oauth/authorize");
    // The VRN is stashed alongside the PKCE verifier for the callback.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hmrc_oauth_vrn_vat=");
  });
});
