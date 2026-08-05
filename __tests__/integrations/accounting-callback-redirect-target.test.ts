import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Accounting OAuth CALLBACK — redirect lands on a REAL page (c35).
 *
 * THE BUG. backToReports() built `${origin}/reports/accounting` and returned it on
 * EVERY exit (success + every failure). But app/(app)/reports/accounting/ holds
 * only panel/action components — no page.tsx / route.ts — so `/reports/accounting`
 * is a genuine 404. After an otherwise-successful OAuth the admin dead-ended on a
 * 404 (the connection row was persisted first, so no data was lost — but the UI
 * was a dead end and the intended banner never rendered).
 *
 * THE FIX, proven here:
 *   (a) the callback redirects to `/reports` (not `/reports/accounting`) for BOTH
 *       a success exit and an error exit, keeping the ?connect= param; and
 *   (b) `/reports` is a real routable page that reads the connect param, while
 *       `/reports/accounting` has no page/route.
 *
 * Hermetic: no live provider HTTP (the OAuth module is faked), no real Supabase
 * (an in-memory fake). The DARK invariant is untouched — this FORCES the
 * connectable path via mocks purely to reach the redirect; production stays dark
 * (isProviderConnectable is false without credentials).
 */

const h = vi.hoisted(() => {
  // exchangeOk flips the success vs. error exit without touching anything else.
  const state = { exchangeOk: true };
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => builder,
      then: (onF: (v: { error: null }) => unknown, onR?: () => unknown) =>
        Promise.resolve({ error: null }).then(onF, onR),
    };
    return builder;
  }
  const fakeClient = { from: () => makeBuilder() };
  return { state, fakeClient };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.fakeClient }));
vi.mock("@/lib/integrations/token-crypto", () => ({
  encryptToken: (v: string) => v,
  isTokenEncryptionConfigured: () => true,
}));
vi.mock("@/lib/integrations/accounting/oauth", () => ({
  isProviderConnectable: () => true,
  accountingRedirectUri: () =>
    "https://crewflow.uk/api/integrations/accounting/xero/callback",
  exchangeCodeForTokens: async () =>
    h.state.exchangeOk
      ? {
          ok: true,
          tokens: {
            accessToken: "acc",
            refreshToken: "ref",
            expiresAt: "2099-01-01T00:00:00Z",
            externalTenantId: "tenant-1",
            realmId: null,
          },
        }
      : { ok: false },
  resolveXeroTenantId: async () => ({ ok: true, tenantId: "tenant-1" }),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { membership: { role: "owner" }, org: { id: "org-A" } },
    user: { id: "user-1" },
  }),
}));

const { GET } = await import(
  "@/app/api/integrations/accounting/[provider]/callback/route"
);

const STATE = "st-123";

function makeReq(provider: string): NextRequest {
  const url = `https://crewflow.uk/api/integrations/accounting/${provider}/callback?code=c1&state=${STATE}`;
  return new NextRequest(url, {
    headers: {
      cookie: `acct_oauth_state_${provider}=${STATE}; acct_oauth_verifier_${provider}=verifier-1`,
    },
  });
}
const params = (provider: string) => Promise.resolve({ provider });

beforeEach(() => {
  h.state.exchangeOk = true;
});

describe("accounting callback · redirect target resolves to a real page", () => {
  it("SUCCESS redirects to /reports (not /reports/accounting), keeping ?connect=connected", async () => {
    const res = await GET(makeReq("xero"), { params: params("xero") });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/reports");
    expect(loc.pathname).not.toBe("/reports/accounting");
    expect(loc.searchParams.get("connect")).toBe("connected");
  });

  it("ERROR redirects to /reports (not /reports/accounting), keeping ?connect=error", async () => {
    h.state.exchangeOk = false;
    const res = await GET(makeReq("xero"), { params: params("xero") });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/reports");
    expect(loc.pathname).not.toBe("/reports/accounting");
    expect(loc.searchParams.get("connect")).toBe("error");
  });
});

describe("accounting callback · /reports is routable and reads ?connect=", () => {
  const appDir = path.resolve(__dirname, "../../app/(app)/reports");

  it("/reports has a page that reads the connect param", () => {
    const page = path.join(appDir, "page.tsx");
    expect(existsSync(page)).toBe(true);
    const src = readFileSync(page, "utf8");
    // The page must actually consume the redirect's ?connect= param.
    expect(src).toMatch(/searchParams/);
    expect(src).toMatch(/connect/);
  });

  it("/reports/accounting has NO page or route (it is not routable)", () => {
    expect(existsSync(path.join(appDir, "accounting/page.tsx"))).toBe(false);
    expect(existsSync(path.join(appDir, "accounting/route.ts"))).toBe(false);
    expect(existsSync(path.join(appDir, "accounting/route.tsx"))).toBe(false);
  });
});
