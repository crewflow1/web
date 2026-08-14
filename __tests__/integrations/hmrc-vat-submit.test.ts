import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HMRC MTD VAT — submit adapter + OAuth refresh path. DARK-gated.
 *
 * These exercise the provider HTTP half (lib/integrations/hmrc/vat-submit.ts) and
 * the token-refresh path (lib/integrations/hmrc/oauth.ts) with `fetch` STUBBED —
 * a real HMRC endpoint is NEVER contacted. The dark invariant is real: with the
 * env unset both modules refuse WITHOUT calling fetch; the tests that exercise the
 * live path FORCE connectability by setting the two-switch env, purely to drive
 * the code, and restore it after.
 */

const CONNECT_ENV = {
  HMRC_CLIENT_ID: "test-client-id",
  HMRC_CLIENT_SECRET: "test-client-secret",
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: "1",
} as const;

const payload = {
  periodKey: "18A1",
  vatDueSales: 100,
  vatDueAcquisitions: 0,
  totalVatDue: 100,
  vatReclaimedCurrPeriod: 40,
  netVatDue: 60,
  totalValueSalesExVAT: 500,
  totalValuePurchasesExVAT: 200,
  totalValueGoodsSuppliedExVAT: 0,
  totalAcquisitionsExVAT: 0,
  finalised: true,
} as const;

const { submitVatReturnToHmrc } = await import("@/lib/integrations/hmrc/vat-submit");
const { refreshAccessTokens, isHmrcConnectable } = await import("@/lib/integrations/hmrc/oauth");

const original = { ...process.env };
function goDark() {
  for (const k of Object.keys(CONNECT_ENV)) delete process.env[k];
}
function goLive() {
  Object.assign(process.env, CONNECT_ENV);
}

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("submitVatReturnToHmrc — dark refusal", () => {
  beforeEach(goDark);

  it("REFUSES with NO fetch when HMRC is not connectable", async () => {
    expect(isHmrcConnectable()).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await submitVatReturnToHmrc({
      vrn: "GB123456789",
      payload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("submitVatReturnToHmrc — live path (forced connectable)", () => {
  beforeEach(goLive);

  it("POSTs to the /{vrn}/returns endpoint with Bearer + fraud headers and returns the receipt", async () => {
    const fetchSpy = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          processingDate: "2026-01-31T09:00:00.000Z",
          formBundleNumber: "256660290587",
          chargeRefNumber: "aCID",
          paymentIndicator: "BANK",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await submitVatReturnToHmrc({
      vrn: "GB123456789",
      payload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: { "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.formBundleNumber).toBe("256660290587");
      expect(res.receipt.chargeRefNumber).toBe("aCID");
      expect(res.receipt.processingDate).toBe("2026-01-31T09:00:00.000Z");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0];
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(String(url)).toBe(
      "https://api.service.hmrc.gov.uk/organisations/vat/GB123456789/returns",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers.accept).toContain("application/vnd.hmrc.1.0+json");
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    // The exact 9-box body is transmitted verbatim.
    expect(JSON.parse(init.body as string)).toMatchObject({ periodKey: "18A1", netVatDue: 60 });
  });

  it("classifies a 400/403 as a BUSINESS rejection (rejected, no retry)", async () => {
    for (const status of [400, 403]) {
      const fetchSpy = vi.fn(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await submitVatReturnToHmrc({
        vrn: "GB1",
        payload,
        tokens: { accessToken: "a", refreshToken: "r" },
        fraudHeaders: {},
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.rejected).toBe(true);
        expect(res.terminal).toBeUndefined();
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it("classifies a 5xx as TRANSIENT (neither rejected nor terminal)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await submitVatReturnToHmrc({
      vrn: "GB1",
      payload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejected).toBeUndefined();
      expect(res.terminal).toBeUndefined();
    }
  });

  it("on 401 REFRESHES the token and retries once, surfacing the refreshed tokens", async () => {
    let call = 0;
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      call += 1;
      // 1st call: submit → 401. 2nd call: token endpoint (refresh) → new token.
      // 3rd call: submit retry with new token → 201.
      if (call === 1) return new Response("{}", { status: 401 });
      if (call === 2) {
        // The refresh POST goes to the token URL as form-urlencoded.
        expect(String(_url)).toContain("/oauth/token");
        expect((init!.body as string)).toContain("grant_type=refresh_token");
        return new Response(
          JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
          { status: 200 },
        );
      }
      // Retry uses the refreshed access token.
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer access-2");
      return new Response(JSON.stringify({ formBundleNumber: "FB-2" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await submitVatReturnToHmrc({
      vrn: "GB1",
      payload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: {},
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.formBundleNumber).toBe("FB-2");
      expect(res.refreshed?.accessToken).toBe("access-2");
      expect(res.refreshed?.refreshToken).toBe("refresh-2");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("a 401 that survives the refresh+retry is TERMINAL (dead grant)", async () => {
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        return new Response(
          JSON.stringify({ access_token: "access-2", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 401 }); // both submit attempts 401
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await submitVatReturnToHmrc({
      vrn: "GB1",
      payload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });
});

describe("refreshAccessTokens — dark refusal + live path", () => {
  it("REFUSES with NO fetch when dark", async () => {
    goDark();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await refreshAccessTokens({ refreshToken: "r" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the existing refresh token when HMRC omits a rotated one", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const res = await refreshAccessTokens({ refreshToken: "old-refresh" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.accessToken).toBe("new-access");
      expect(res.tokens.refreshToken).toBe("old-refresh");
    }
  });

  it("classifies invalid_grant (400) as TERMINAL", async () => {
    goLive();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const res = await refreshAccessTokens({ refreshToken: "dead" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });

  it("classifies a 5xx as transient (not terminal)", async () => {
    goLive();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const res = await refreshAccessTokens({ refreshToken: "r" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(false);
  });
});
