import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HMRC CIS subcontractor VERIFICATION — the G5 dark adapter + orchestrator
 * (lib/integrations/hmrc/cis-verify.ts).
 *
 * These exercise the provider HTTP half with `fetch` STUBBED — a real HMRC
 * endpoint is NEVER contacted — mirroring hmrc-cis-rti-submit.test.ts exactly.
 * The dark invariant is real: with the env unset the module refuses WITHOUT
 * calling fetch; the live-path tests FORCE connectability by setting the
 * two-switch env purely to drive the code, and restore it after.
 *
 * The orchestrator runs against mocked CIS services + a fake service-role
 * client, proving the SOURCE CONTRACT: a successful HMRC answer is recorded
 * through recordVerification (the single write authority) with
 * source='hmrc_api', and NOTHING is recorded on any failure.
 */

const CONNECT_ENV = {
  HMRC_CLIENT_ID: "test-client-id",
  HMRC_CLIENT_SECRET: "test-client-secret",
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: "1",
} as const;

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    cryptoConfigured: true,
    profile: null as Row | null,
    contractor: null as Row | null,
    connection: null as Row | null,
    recordResult: { ok: true, data: {} as Row } as
      | { ok: true; data: Row }
      | { ok: false; error: string },
    adminUpdates: [] as Array<{ table: string; row: Row }>,
  };
  const getCisProfile = vi.fn(async (..._args: unknown[]) => state.profile);
  const recordVerification = vi.fn(async (..._args: unknown[]) => state.recordResult);
  const getContractorProfile = vi.fn(async (..._args: unknown[]) => state.contractor);
  return { state, getCisProfile, recordVerification, getContractorProfile };
});

vi.mock("@/server/services/cis", () => ({
  getCisProfile: h.getCisProfile,
  recordVerification: h.recordVerification,
}));

vi.mock("@/server/services/cis-statements", () => ({
  getContractorProfile: h.getContractorProfile,
}));

vi.mock("@/lib/integrations/token-crypto", () => ({
  isTokenEncryptionConfigured: () => h.state.cryptoConfigured,
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => v.replace(/^enc:/, ""),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      return {
        select(_cols: string) {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: h.state.connection, error: null }),
          };
          return chain;
        },
        update(row: Row) {
          h.state.adminUpdates.push({ table, row });
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(onFulfilled),
          };
          return chain;
        },
      };
    },
  }),
}));

const {
  HMRC_API_VERIFICATION_SOURCE,
  requestHmrcCisVerification,
  statusForTaxTreatment,
  verifyCisSubcontractorWithHmrc,
} = await import("@/lib/integrations/hmrc/cis-verify");
const { isHmrcConnectable } = await import("@/lib/integrations/hmrc/oauth");
const { needsReverification, rateForStatus } = await import("@/lib/cis/verification");

const request = {
  legalName: "D J Smith Ltd",
  tradingName: null,
  utr: "1234567890",
  companyNumber: null,
  subcontractorType: "sole_trader",
  contractorUtr: "9876543210",
  contractorAccountsOfficeReference: "123PA00012345",
};

const tokens = { accessToken: "access-1", refreshToken: "refresh-1" };

const baseProfile: Row = {
  org_id: "org-1",
  supplier_id: "sup-1",
  legal_name: "D J Smith Ltd",
  trading_name: null,
  company_number: null,
  utr: "1234567890",
  subcontractor_type: "sole_trader",
  vat_registered: false,
  vat_number: null,
  cis_status: "unverified",
  deduction_rate: null,
  verification_reference: null,
  verification_source: "manual",
  verified_at: null,
  verification_expires_at: null,
  verified_by: null,
  notes: null,
  created_by: null,
  updated_by: null,
  created_at: "",
  updated_at: "",
};

const contractorProfile: Row = {
  org_id: "org-1",
  legal_name: "Acme Contracts Ltd",
  employer_paye_reference: "123/AB456",
  accounts_office_reference: "123PA00012345",
  contractor_utr: "9876543210",
};

const original = { ...process.env };
function goDark() {
  for (const k of Object.keys(CONNECT_ENV)) delete process.env[k];
}
function goLive() {
  Object.assign(process.env, CONNECT_ENV);
}

function okResponse(body: Row, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  h.state.cryptoConfigured = true;
  h.state.profile = { ...baseProfile };
  h.state.contractor = { ...contractorProfile };
  h.state.connection = {
    status: "connected",
    access_token: "enc:access-1",
    refresh_token: "enc:refresh-1",
  };
  h.state.recordResult = { ok: true, data: { ...baseProfile } };
  h.state.adminUpdates = [];
  h.getCisProfile.mockClear();
  h.recordVerification.mockClear();
  h.getContractorProfile.mockClear();
});

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tax treatment → status mapping (pure)
// ---------------------------------------------------------------------------

describe("statusForTaxTreatment — HMRC treatment → domain status → rate", () => {
  it("maps the four HMRC treatments to the four outcome statuses (and their rates)", () => {
    expect(statusForTaxTreatment("gross")).toBe("gross");
    expect(rateForStatus("gross")).toBe(0);

    expect(statusForTaxTreatment("net")).toBe("standard_20");
    expect(rateForStatus("standard_20")).toBe(20);

    expect(statusForTaxTreatment("higher")).toBe("higher_30");
    expect(rateForStatus("higher_30")).toBe(30);

    // Unmatched applies the HIGHER rate (30) but stays the DISTINCT 'failed'
    // status so the operator can see the 30% came from a failed match.
    expect(statusForTaxTreatment("unmatched")).toBe("failed");
    expect(rateForStatus("failed")).toBe(30);
  });

  it("is case/whitespace tolerant but NEVER guesses an unknown treatment", () => {
    expect(statusForTaxTreatment(" GROSS ")).toBe("gross");
    expect(statusForTaxTreatment("Net")).toBe("standard_20");
    expect(statusForTaxTreatment("matched")).toBeNull();
    expect(statusForTaxTreatment("")).toBeNull();
    expect(statusForTaxTreatment("20")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adapter — dark refusal
// ---------------------------------------------------------------------------

describe("verifyCisSubcontractorWithHmrc — dark refusal", () => {
  beforeEach(goDark);

  it("REFUSES with NO fetch when HMRC is not connectable", async () => {
    expect(isHmrcConnectable()).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Adapter — live path (forced connectable)
// ---------------------------------------------------------------------------

describe("verifyCisSubcontractorWithHmrc — live path (forced connectable)", () => {
  beforeEach(goLive);

  it("POSTs contractor UTR+AO ref and subcontractor identity with Bearer + fraud headers, and maps the receipt", async () => {
    const fetchSpy = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      okResponse({
        verificationNumber: "V1234567890",
        taxTreatment: "gross",
        verificationDate: "2026-08-29",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await verifyCisSubcontractorWithHmrc({
      request,
      tokens,
      fraudHeaders: { "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.verificationNumber).toBe("V1234567890");
      expect(res.receipt.taxTreatment).toBe("gross");
      expect(res.receipt.status).toBe("gross");
      expect(res.receipt.deductionRate).toBe(0);
      expect(res.receipt.verifiedAt).toBe("2026-08-29");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0];
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(String(url)).toBe(
      "https://api.service.hmrc.gov.uk/organisations/cis/9876543210/verifications",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers.accept).toContain("application/vnd.hmrc.1.0+json");
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(JSON.parse(init.body as string)).toMatchObject({
      contractor: { utr: "9876543210", accountsOfficeReference: "123PA00012345" },
      subcontractor: { utr: "1234567890", name: "D J Smith Ltd" },
    });
  });

  it("maps net→standard_20 (20%), higher→higher_30 (30%), unmatched→failed (30%, the higher rate)", async () => {
    const cases = [
      { treatment: "net", status: "standard_20", rate: 20 },
      { treatment: "higher", status: "higher_30", rate: 30 },
      { treatment: "unmatched", status: "failed", rate: 30 },
    ] as const;
    for (const c of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          okResponse({ verificationNumber: "V1234567890A", taxTreatment: c.treatment }),
        ),
      );
      const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.receipt.status).toBe(c.status);
        expect(res.receipt.deductionRate).toBe(c.rate);
        // No date on the answer → null, NEVER a guessed date.
        expect(res.receipt.verifiedAt).toBeNull();
      }
      vi.unstubAllGlobals();
    }
  });

  it("REFUSES a 2xx with an unknown tax treatment — never a synthesised outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ verificationNumber: "V1234567890", taxTreatment: "sideways" })),
    );
    const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("error");
      expect(res.message).toContain("unknown tax treatment");
    }
  });

  it("REFUSES a 2xx without a usable verification number", async () => {
    for (const body of [{ taxTreatment: "net" }, { verificationNumber: "", taxTreatment: "net" }]) {
      vi.stubGlobal("fetch", vi.fn(async () => okResponse(body as Row)));
      const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("verification number");
      vi.unstubAllGlobals();
    }
  });

  it("classifies a 400/403 as a BUSINESS rejection (rejected, no retry)", async () => {
    for (const status of [400, 403]) {
      const fetchSpy = vi.fn(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
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
    const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
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
        return okResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      }
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer access-2");
      return okResponse({ verificationNumber: "V1234567890", taxTreatment: "net" });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.receipt.status).toBe("standard_20");
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
        if (call === 2) return okResponse({ access_token: "access-2", expires_in: 3600 });
        return new Response("{}", { status: 401 });
      }),
    );
    const res = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — dark refusal + preconditions (no fetch, nothing recorded)
// ---------------------------------------------------------------------------

const orchestratorParams = { orgId: "org-1", supplierId: "sup-1", actorId: "user-1" };

describe("requestHmrcCisVerification — dark refusal", () => {
  beforeEach(goDark);

  it("REFUSES while dark: no fetch, no reads, NOTHING recorded", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("not_configured");
      expect(res.message).toContain("not connected");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.getCisProfile).not.toHaveBeenCalled();
    expect(h.recordVerification).not.toHaveBeenCalled();
  });
});

describe("requestHmrcCisVerification — preconditions (forced connectable)", () => {
  beforeEach(goLive);

  it("refuses without a token-encryption key", async () => {
    h.state.cryptoConfigured = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.recordVerification).not.toHaveBeenCalled();
  });

  it("refuses without a profile / a UTR / the contractor's own identity — no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    h.state.profile = null;
    let res = await requestHmrcCisVerification(orchestratorParams);
    expect(!res.ok && res.reason).toBe("no_profile");

    h.state.profile = { ...baseProfile, utr: null };
    res = await requestHmrcCisVerification(orchestratorParams);
    expect(!res.ok && res.reason).toBe("no_utr");

    h.state.profile = { ...baseProfile };
    h.state.contractor = { ...contractorProfile, contractor_utr: null };
    res = await requestHmrcCisVerification(orchestratorParams);
    expect(!res.ok && res.reason).toBe("no_contractor_identity");

    h.state.contractor = { ...contractorProfile, accounts_office_reference: "  " };
    res = await requestHmrcCisVerification(orchestratorParams);
    expect(!res.ok && res.reason).toBe("no_contractor_identity");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.recordVerification).not.toHaveBeenCalled();
  });

  it("refuses when the org has no live HMRC connection — no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const connection of [null, { status: "error", access_token: "enc:a", refresh_token: null }]) {
      h.state.connection = connection;
      const res = await requestHmrcCisVerification(orchestratorParams);
      expect(!res.ok && res.reason).toBe("not_connected");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.recordVerification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — the SOURCE CONTRACT: one write authority, source='hmrc_api'
// ---------------------------------------------------------------------------

describe("requestHmrcCisVerification — records through recordVerification with source='hmrc_api'", () => {
  beforeEach(goLive);

  it("happy path: HMRC's answer is recorded via the single write authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          verificationNumber: "v1234567890",
          taxTreatment: "net",
          verificationDate: "2026-08-29",
        }),
      ),
    );
    const recordedRow = { ...baseProfile, cis_status: "standard_20", deduction_rate: 20 };
    h.state.recordResult = { ok: true, data: recordedRow };

    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok, !res.ok ? res.message : "").toBe(true);
    if (res.ok) {
      expect(res.profile).toBe(recordedRow);
      expect(res.receipt.status).toBe("standard_20");
      // The pre-existing verification was absent → this run WAS a due
      // (re-)verification, surfaced via the needsReverification passthrough.
      expect(res.wasStale).toBe(true);
    }

    expect(h.recordVerification).toHaveBeenCalledTimes(1);
    const [orgId, supplierId, input, actorId, source] = h.recordVerification.mock
      .calls[0] as unknown[];
    expect(orgId).toBe("org-1");
    expect(supplierId).toBe("sup-1");
    expect(actorId).toBe("user-1");
    expect(source).toBe("hmrc_api");
    expect(source).toBe(HMRC_API_VERIFICATION_SOURCE);
    expect(input).toMatchObject({
      cis_status: "standard_20",
      // HMRC's reference, canonicalised loss-free (upper-cased), never invented.
      verification_reference: "V1234567890",
      verified_at: "2026-08-29",
    });
  });

  it("when HMRC reports no date, verified_at is the OBSERVED request day (today)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ verificationNumber: "V1234567890", taxTreatment: "gross" })),
    );
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(true);
    const input = h.recordVerification.mock.calls[0]![2] as unknown as { verified_at: string };
    expect(input.verified_at).toBe(new Date().toISOString().slice(0, 10));
  });

  it("an HMRC rejection records NOTHING", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rejected");
    expect(h.recordVerification).not.toHaveBeenCalled();
  });

  it("a transient failure records NOTHING and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("error");
      expect(res.message).toContain("Nothing was recorded");
    }
    expect(h.recordVerification).not.toHaveBeenCalled();
  });

  it("a refused recordVerification write surfaces honestly (answered, not recorded)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ verificationNumber: "V1234567890", taxTreatment: "net" })),
    );
    h.state.recordResult = { ok: false, error: "Couldn't record the verification." };
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("could not be recorded");
  });

  it("a dead grant flips the connection to error and reports terminal", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 2) return okResponse({ access_token: "access-2", expires_in: 3600 });
        return new Response("{}", { status: 401 });
      }),
    );
    const res = await requestHmrcCisVerification(orchestratorParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
    const errorUpdate = h.state.adminUpdates.find(
      (u) => u.table === "hmrc_connections" && u.row.status === "error",
    );
    expect(errorUpdate, "the connection must be flipped to status='error'").toBeTruthy();
    expect(h.recordVerification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// needsReverification — the passthrough delegates to the ONE staleness authority
// ---------------------------------------------------------------------------

describe("needsReverification — passthrough over isVerificationStale", () => {
  const verified = {
    cis_status: "standard_20",
    verified_at: "2026-07-01",
    verification_expires_at: null,
  } as const;

  it("false while the verification is current, true once expired (boundary inclusive)", () => {
    // Verified 2026-07-01 → tax year 2026/27 → good THROUGH 2029-04-05.
    expect(needsReverification(verified, "2026-08-29")).toBe(false);
    expect(needsReverification(verified, "2029-04-05")).toBe(false);
    expect(needsReverification(verified, "2029-04-06")).toBe(true);
  });

  it("true for a profile with no outcome at all (fail-closed)", () => {
    expect(
      needsReverification(
        { cis_status: "unverified", verified_at: null, verification_expires_at: null },
        "2026-08-29",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source pins — the adapter never grows its own write path
// ---------------------------------------------------------------------------

describe("source contract — recordVerification stays the single write authority", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const codeOf = (ts: string) =>
    ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("cis-verify.ts never touches cis_subcontractors directly — it records via recordVerification", () => {
    const src = codeOf(
      readFileSync(resolve(ROOT, "lib/integrations/hmrc/cis-verify.ts"), "utf8"),
    );
    expect(src).not.toMatch(/from\(\s*["']cis_subcontractors["']/);
    expect(src).toMatch(/recordVerification\(/);
    expect(src).toMatch(/HMRC_API_VERIFICATION_SOURCE/);
  });

  it("recordVerification writes the source and defaults it to manual", () => {
    const src = codeOf(readFileSync(resolve(ROOT, "server/services/cis.ts"), "utf8"));
    expect(src).toMatch(/source:\s*CisVerificationSource\s*=\s*MANUAL_VERIFICATION_SOURCE/);
    expect(src).toMatch(/verification_source:\s*source/);
  });
});
