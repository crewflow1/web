import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Twilio number provisioning service (Twilio receptionist PR 4). Hermetic: the
 * Twilio SDK + the admin client are mocked. Pins: read-only search/pricing degrade
 * safely without credentials; BUY + RELEASE refuse without approval or credentials;
 * a successful buy wires the voice webhooks and records org-pinned ownership; a
 * forwarding receiver (Option A) is recorded as number_type 'forwarding'.
 */

const incomingCreate = vi.fn();
const incomingUpdate = vi.fn();
const incomingRemove = vi.fn();
const localList = vi.fn();
const nationalList = vi.fn();
const pricingFetch = vi.fn();

const incomingPhoneNumbers = Object.assign(
  vi.fn(() => ({ update: incomingUpdate, remove: incomingRemove })),
  { create: incomingCreate },
);
const fakeClient = {
  availablePhoneNumbers: vi.fn(() => ({
    local: { list: localList },
    national: { list: nationalList },
    mobile: { list: vi.fn().mockResolvedValue([]) },
    tollFree: { list: vi.fn().mockResolvedValue([]) },
  })),
  incomingPhoneNumbers,
  pricing: { v1: { phoneNumbers: { countries: vi.fn(() => ({ fetch: pricingFetch })) } } },
};
vi.mock("twilio", () => ({ default: vi.fn(() => fakeClient) }));

const insertSingle = vi.fn();
const updateEqEq = vi.fn();
const captured: { insert: Record<string, unknown> | null } = { insert: null };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        captured.insert = row;
        return { select: () => ({ single: insertSingle }) };
      },
      update: () => ({ eq: () => ({ eq: updateEqEq }) }),
    }),
  }),
}));

async function mod() {
  return import("@/lib/telephony/provisioning");
}

describe("number provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.insert = null;
    localList.mockResolvedValue([
      {
        phoneNumber: "+441823589593",
        friendlyName: "+44 1823 589593",
        locality: "Taunton",
        region: "England",
        capabilities: { voice: true, SMS: true, MMS: false },
      },
      { phoneNumber: "not-e164" }, // filtered out
    ]);
    pricingFetch.mockResolvedValue({
      priceUnit: "GBP",
      phoneNumberPrices: [
        { number_type: "local", current_price: "0.86917" },
        { number_type: "national", current_price: "1.00" },
      ],
    });
    incomingCreate.mockResolvedValue({ sid: "PN123", phoneNumber: "+441823589593" });
    incomingRemove.mockResolvedValue(true);
    insertSingle.mockResolvedValue({ data: { id: "pn-1" }, error: null });
    updateEqEq.mockResolvedValue({ error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("voiceWebhookUrls builds the three POST endpoints off a base URL", async () => {
    const { voiceWebhookUrls } = await mod();
    expect(voiceWebhookUrls("https://crewflow.uk/")).toEqual({
      voiceUrl: "https://crewflow.uk/api/webhooks/twilio/voice",
      voiceFallbackUrl: "https://crewflow.uk/api/webhooks/twilio/voice",
      statusCallback: "https://crewflow.uk/api/webhooks/twilio/voice/status",
    });
  });

  it("search returns [] with no credentials (safe, non-throwing)", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_API_KEY_SID", "");
    const { searchAvailableNumbers } = await mod();
    expect(await searchAvailableNumbers({ type: "local" })).toEqual([]);
  });

  it("search maps + filters the inventory when credentialed", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { searchAvailableNumbers } = await mod();
    const rows = await searchAvailableNumbers({ type: "local", limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ e164: "+441823589593", locality: "Taunton", type: "local" });
    expect(rows[0]?.capabilities.voice).toBe(true);
  });

  it("pricing maps local/national prices to pence", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { getNumberPricing } = await mod();
    const p = await getNumberPricing("GB");
    expect(p?.currency).toBe("GBP");
    expect(p?.monthlyPence.local).toBe(87); // 0.86917 → 87p
    expect(p?.monthlyPence.national).toBe(100);
  });

  it("provision REFUSES without approval (no provider call)", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { provisionNumber } = await mod();
    const r = await provisionNumber({
      orgId: "org-1",
      e164: "+441823589593",
      type: "local",
      appBaseUrl: "https://crewflow.uk",
      approved: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_approved");
    expect(incomingCreate).not.toHaveBeenCalled();
  });

  it("provision REFUSES without credentials", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_API_KEY_SID", "");
    const { provisionNumber } = await mod();
    const r = await provisionNumber({
      orgId: "org-1",
      e164: "+441823589593",
      type: "local",
      appBaseUrl: "https://crewflow.uk",
      approved: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_credentials");
  });

  it("provision buys, wires webhooks and records org-pinned ownership", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { provisionNumber } = await mod();
    const r = await provisionNumber({
      orgId: "org-7",
      e164: "+441823589593",
      type: "local",
      appBaseUrl: "https://crewflow.uk",
      approved: true,
      monthlyCostPence: 87,
      bundleSid: "BU123",
      emergencyAddressSid: "AD123",
      createdBy: "user-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.providerNumberSid).toBe("PN123");
      expect(r.phoneNumberId).toBe("pn-1");
    }
    // The buy wired the voice webhooks + attached bundle/emergency address.
    expect(incomingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: "+441823589593",
        voiceUrl: "https://crewflow.uk/api/webhooks/twilio/voice",
        statusCallback: "https://crewflow.uk/api/webhooks/twilio/voice/status",
        bundleSid: "BU123",
        emergencyAddressSid: "AD123",
      }),
    );
    expect(insertSingle).toHaveBeenCalled();
  });

  it("forwarding receiver (Option A) is recorded as type 'forwarding'", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { provisionNumber } = await mod();
    const r = await provisionNumber({
      orgId: "org-7",
      e164: "+441823589593",
      type: "local",
      appBaseUrl: "https://crewflow.uk",
      approved: true,
      onboardingMode: "existing_number_forward",
      forwardingFrom: "+441611234567",
    });
    expect(r.ok).toBe(true);
    expect(captured.insert).toMatchObject({
      number_type: "forwarding",
      onboarding_mode: "existing_number_forward",
      forwarding_from: "+441611234567",
    });
  });

  it("release REFUSES without approval, and on approval removes + deactivates", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    const { releaseNumber } = await mod();

    const refused = await releaseNumber({ orgId: "org-1", providerNumberSid: "PN123", approved: false });
    expect(refused.ok).toBe(false);
    expect(incomingRemove).not.toHaveBeenCalled();

    const ok = await releaseNumber({ orgId: "org-1", providerNumberSid: "PN123", approved: true });
    expect(ok.ok).toBe(true);
    expect(incomingRemove).toHaveBeenCalled();
    expect(updateEqEq).toHaveBeenCalled();
  });
});
