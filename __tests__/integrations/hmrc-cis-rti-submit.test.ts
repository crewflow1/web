import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HMRC CIS300 + RTI FPS — submit adapters. DARK-gated.
 *
 * These exercise the provider HTTP half (lib/integrations/hmrc/cis-submit.ts,
 * rti-fps-submit.ts) with `fetch` STUBBED — a real HMRC endpoint is NEVER
 * contacted. The dark invariant is real: with the env unset both modules refuse
 * WITHOUT calling fetch; the live-path tests FORCE connectability by setting the
 * two-switch env purely to drive the code, and restore it after. They mirror
 * __tests__/integrations/hmrc-vat-submit.test.ts exactly.
 */

const CONNECT_ENV = {
  HMRC_CLIENT_ID: "test-client-id",
  HMRC_CLIENT_SECRET: "test-client-secret",
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: "1",
} as const;

import type { Cis300Return } from "@/lib/integrations/hmrc/cis-return";
import type { FpsReturn } from "@/lib/integrations/hmrc/rti-fps";

const cisPayload: Cis300Return = {
  taxYear: "2026-27",
  taxMonth: { from: "2026-04-06", to: "2026-05-05" },
  contractor: { aoReference: null, employerPayeReference: "123/AB456", utr: null, name: "Acme" },
  nilReturn: false,
  subcontractors: [
    { name: "Sub", utr: "1234567890", verificationNumber: null, totalPayments: 1000, costOfMaterials: 100, totalDeducted: 180 },
  ],
  declarations: { employmentStatus: null, verification: null, informationCorrect: null, inactivity: null },
};

const fpsPayload: FpsReturn = {
  taxYear: "2026-27",
  payDate: "2026-07-31",
  paymentFrequency: "monthly",
  employer: { employerPayeReference: "123/AB456", accountsOfficeReference: "123PA00012345", name: "Acme" },
  employees: [
    { employeeId: "u1", name: "A", hoursWorked: 160, taxablePay: 3000, taxDeducted: 400, employeeNic: 200, netPay: 2400, yearToDate: { taxablePay: 3000, taxDeducted: 400, employeeNic: 200 } },
  ],
  totals: { taxablePay: 3000, taxDeducted: 400, employeeNic: 200, netPay: 2400 },
  finalSubmission: false,
};

const { submitCis300ReturnToHmrc } = await import("@/lib/integrations/hmrc/cis-submit");
const { submitFpsReturnToHmrc } = await import("@/lib/integrations/hmrc/rti-fps-submit");
const { isHmrcConnectable } = await import("@/lib/integrations/hmrc/oauth");

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

// ---------------------------------------------------------------------------
// CIS300 adapter
// ---------------------------------------------------------------------------

describe("submitCis300ReturnToHmrc — dark refusal", () => {
  beforeEach(goDark);

  it("REFUSES with NO fetch when HMRC is not connectable", async () => {
    expect(isHmrcConnectable()).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: cisPayload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("submitCis300ReturnToHmrc — live path (forced connectable)", () => {
  beforeEach(goLive);

  it("POSTs the composed payload to /{contractorRef}/monthly-returns with Bearer + fraud headers and returns the receipt", async () => {
    const fetchSpy = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          processingDate: "2026-05-19T09:00:00.000Z",
          correlationId: "CID-cis-1",
          chargeRefNumber: "XCIS0001",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: cisPayload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: { "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.submissionReference).toBe("CID-cis-1");
      expect(res.receipt.chargeRefNumber).toBe("XCIS0001");
      expect(res.receipt.processingDate).toBe("2026-05-19T09:00:00.000Z");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0];
    const init = fetchSpy.mock.calls[0]![1]!;
    // The employer PAYE reference contains a slash — it MUST be percent-encoded.
    expect(String(url)).toBe(
      "https://api.service.hmrc.gov.uk/organisations/cis/123%2FAB456/monthly-returns",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers.accept).toContain("application/vnd.hmrc.1.0+json");
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    // The exact composed CIS300 body is transmitted verbatim.
    expect(JSON.parse(init.body as string)).toMatchObject({
      taxYear: "2026-27",
      contractor: { employerPayeReference: "123/AB456" },
    });
  });

  it("classifies a 400/403 as a BUSINESS rejection (rejected, no retry)", async () => {
    for (const status of [400, 403]) {
      const fetchSpy = vi.fn(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await submitCis300ReturnToHmrc({
        contractorRef: "123/AB456",
        payload: cisPayload,
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: cisPayload,
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
      if (call === 1) return new Response("{}", { status: 401 });
      if (call === 2) {
        expect(String(_url)).toContain("/oauth/token");
        expect(init!.body as string).toContain("grant_type=refresh_token");
        return new Response(
          JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
          { status: 200 },
        );
      }
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer access-2");
      return new Response(JSON.stringify({ correlationId: "CID-2" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: cisPayload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.submissionReference).toBe("CID-2");
      expect(res.refreshed?.accessToken).toBe("access-2");
      expect(res.refreshed?.refreshToken).toBe("refresh-2");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("a 401 that survives the refresh+retry is TERMINAL (dead grant)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 2) {
          return new Response(JSON.stringify({ access_token: "access-2", expires_in: 3600 }), { status: 200 });
        }
        return new Response("{}", { status: 401 });
      }),
    );
    const res = await submitCis300ReturnToHmrc({
      contractorRef: "123/AB456",
      payload: cisPayload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RTI FPS adapter
// ---------------------------------------------------------------------------

describe("submitFpsReturnToHmrc — dark refusal", () => {
  beforeEach(goDark);

  it("REFUSES with NO fetch when HMRC is not connectable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: fpsPayload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("submitFpsReturnToHmrc — live path (forced connectable)", () => {
  beforeEach(goLive);

  it("POSTs the composed payload to the RTI FPS endpoint with Bearer + fraud headers and returns the receipt", async () => {
    const fetchSpy = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({ processingDate: "2026-07-31T09:00:00.000Z", correlationId: "CID-fps-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: fpsPayload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: { "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.submissionReference).toBe("CID-fps-1");
      expect(res.receipt.processingDate).toBe("2026-07-31T09:00:00.000Z");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0];
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(String(url)).toBe(
      "https://api.service.hmrc.gov.uk/organisations/paye/123%2FAB456/rti/full-payment-submissions",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers.accept).toContain("application/vnd.hmrc.1.0+json");
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(JSON.parse(init.body as string)).toMatchObject({
      payDate: "2026-07-31",
      employer: { employerPayeReference: "123/AB456" },
    });
  });

  it("classifies a 400 as a BUSINESS rejection, a 5xx as transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const rej = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: fpsPayload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(rej.ok).toBe(false);
    if (!rej.ok) expect(rej.rejected).toBe(true);
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const tr = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: fpsPayload,
      tokens: { accessToken: "a", refreshToken: "r" },
      fraudHeaders: {},
    });
    expect(tr.ok).toBe(false);
    if (!tr.ok) {
      expect(tr.rejected).toBeUndefined();
      expect(tr.terminal).toBeUndefined();
    }
  });

  it("on 401 REFRESHES the token and retries once", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        call += 1;
        if (call === 1) return new Response("{}", { status: 401 });
        if (call === 2) {
          return new Response(
            JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
            { status: 200 },
          );
        }
        expect((init!.headers as Record<string, string>).authorization).toBe("Bearer access-2");
        return new Response(JSON.stringify({ correlationId: "CID-fps-2" }), { status: 200 });
      }),
    );
    const res = await submitFpsReturnToHmrc({
      employerRef: "123/AB456",
      payload: fpsPayload,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fraudHeaders: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.submissionReference).toBe("CID-fps-2");
      expect(res.refreshed?.accessToken).toBe("access-2");
    }
  });
});
