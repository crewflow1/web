import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";

/**
 * Number onboarding server actions (Twilio receptionist PR 5). Hermetic: the
 * provisioning service, auth session, env, cache + audit are mocked. Pins: admin
 * gating, org-pinning, the honest "Twilio not connected" state (no_credentials is
 * NOT a hard failure), the success path, search mapping, and E.164 validation.
 */

let role = "owner";
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { role } },
    user: { id: "user-1", email: "owner@example.com" },
  })),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crewflow.uk" } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: vi.fn() }));

const searchAvailableNumbers = vi.fn();
const getNumberPricing = vi.fn();
const provisionNumber = vi.fn();
vi.mock("@/lib/telephony/provisioning", () => ({
  searchAvailableNumbers: (...a: unknown[]) => searchAvailableNumbers(...a),
  getNumberPricing: (...a: unknown[]) => getNumberPricing(...a),
  provisionNumber: (...a: unknown[]) => provisionNumber(...a),
}));

async function mod() {
  return import("@/app/(app)/settings/ai-receptionist/number-actions");
}
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("number onboarding actions", () => {
  beforeEach(() => {
    role = "owner";
    vi.clearAllMocks();
    searchAvailableNumbers.mockResolvedValue([
      { e164: "+441823589593", friendlyName: "x", locality: "Taunton", region: "England", type: "local", capabilities: { voice: true, sms: false, mms: false } },
    ]);
    getNumberPricing.mockResolvedValue({ country: "GB", currency: "GBP", monthlyPence: { local: 87 } });
    provisionNumber.mockResolvedValue({ ok: true, e164: "+441823589593", providerNumberSid: "PN1", phoneNumberId: "pn-1" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses a non-admin", async () => {
    role = "member";
    const { requestNewNumberAction, searchNumbersAction } = await mod();
    const r = await requestNewNumberAction(INITIAL_FORM_STATE, fd({ e164: "+441823589593" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/owners and admins/i);
    expect(provisionNumber).not.toHaveBeenCalled();
    const s = await searchNumbersAction(fd({ type: "local" }));
    expect(s.ok).toBe(false);
  });

  it("search returns mapped numbers + pricing", async () => {
    const { searchNumbersAction } = await mod();
    const r = await searchNumbersAction(fd({ type: "local", area_code: "1823" }));
    expect(r.ok).toBe(true);
    expect(r.numbers).toHaveLength(1);
    expect(r.pricing?.monthlyPence.local).toBe(87);
    expect(searchAvailableNumbers).toHaveBeenCalledWith(
      expect.objectContaining({ country: "GB", type: "local", areaCode: "1823", limit: 10 }),
    );
  });

  it("request: no_credentials returns the honest 'noted' state, not a hard failure", async () => {
    provisionNumber.mockResolvedValue({ ok: false, reason: "no_credentials", error: "no creds" });
    const { requestNewNumberAction } = await mod();
    const r = await requestNewNumberAction(INITIAL_FORM_STATE, fd({ e164: "+441823589593", type: "local" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't connected yet|noted/i);
  });

  it("request success: provisions approved + org-pinned, returns success", async () => {
    const { requestNewNumberAction } = await mod();
    const r = await requestNewNumberAction(
      INITIAL_FORM_STATE,
      fd({ e164: "+441823589593", type: "local", monthly_cost_pence: "87" }),
    );
    expect(r.ok).toBe(true);
    expect(r.successMessage).toMatch(/\+441823589593/);
    expect(provisionNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        e164: "+441823589593",
        approved: true,
        appBaseUrl: "https://crewflow.uk",
        monthlyCostPence: 87,
      }),
    );
  });

  it("request: rejects a non-E.164 number before provisioning", async () => {
    const { requestNewNumberAction } = await mod();
    const r = await requestNewNumberAction(INITIAL_FORM_STATE, fd({ e164: "07700900123" }));
    expect(r.ok).toBe(false);
    expect(provisionNumber).not.toHaveBeenCalled();
  });

  it("forwarding: rejects a bad existing number", async () => {
    const { setupForwardingAction } = await mod();
    const r = await setupForwardingAction(INITIAL_FORM_STATE, fd({ forwarding_from: "nope" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/international format/i);
    expect(provisionNumber).not.toHaveBeenCalled();
  });

  it("forwarding: no receiver available (no creds) → honest noted state", async () => {
    searchAvailableNumbers.mockResolvedValue([]);
    const { setupForwardingAction } = await mod();
    const r = await setupForwardingAction(INITIAL_FORM_STATE, fd({ forwarding_from: "+447700900123" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't connected yet|noted/i);
    expect(provisionNumber).not.toHaveBeenCalled();
  });

  it("forwarding success: provisions a receiver with onboarding_mode + forwardingFrom", async () => {
    const { setupForwardingAction } = await mod();
    const r = await setupForwardingAction(INITIAL_FORM_STATE, fd({ forwarding_from: "+44 7700 900123" }));
    expect(r.ok).toBe(true);
    expect(provisionNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        onboardingMode: "existing_number_forward",
        forwardingFrom: "+447700900123",
        approved: true,
      }),
    );
  });
});
