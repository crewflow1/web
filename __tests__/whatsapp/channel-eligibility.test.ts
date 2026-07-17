import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * canRunReceptionistChannel — the SINGLE fail-closed eligibility authority (Part 5).
 *
 * This is the one place a channel is cleared to reach the reasoning engine, so its
 * default-deny posture is a security boundary. phone is gated by the missed-call flag
 * ONLY (no per-org read, unchanged); whatsapp_msg needs BOTH the WhatsApp feature flag
 * AND the org's `ai_receptionist_setups` being enabled + fully provisioned (`live`);
 * every other channel — and every error path — is closed.
 *
 * The eligibility module reads the flags from `process.env` at call time (so vi.stubEnv
 * drives them) and the per-org row via the admin client (mocked here to a configurable
 * result). No real Postgres — the DB-backed continuation is proven in the integration tier.
 */

// Configurable fake for the ai_receptionist_setups per-org read.
let setupRow: { enabled: boolean | null; status: string | null } | null = null;
let setupError: { message: string } | null = null;
let throwOnRead = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (throwOnRead) throw new Error("connection reset");
            return { data: setupRow, error: setupError };
          },
        }),
      }),
    }),
  }),
}));

import { canRunReceptionistChannel } from "@/server/services/receptionist-channel-eligibility";

const TEXTBACK = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const WHATSAPP = "NEXT_PUBLIC_FEATURE_WHATSAPP";
const ORG = "org-eligibility-1";

beforeEach(() => {
  setupRow = null;
  setupError = null;
  throwOnRead = false;
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("canRunReceptionistChannel — phone (missed-call flag ONLY, no per-org read)", () => {
  it("true when the missed-call text-back flag is 'true'", async () => {
    vi.stubEnv(TEXTBACK, "true");
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "phone" })).toBe(true);
  });

  it("false when the flag is 'false' or absent (unchanged phone gate)", async () => {
    vi.stubEnv(TEXTBACK, "false");
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "phone" })).toBe(false);
    vi.stubEnv(TEXTBACK, "");
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "phone" })).toBe(false);
  });
});

describe("canRunReceptionistChannel — whatsapp_msg (WhatsApp flag AND org enabled+live)", () => {
  it("false (dark) when the WhatsApp feature flag is off — even for an enabled+live org", async () => {
    vi.stubEnv(WHATSAPP, "false");
    setupRow = { enabled: true, status: "live" };
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
  });

  it("true ONLY when the flag is on AND the org is enabled AND live", async () => {
    vi.stubEnv(WHATSAPP, "true");
    setupRow = { enabled: true, status: "live" };
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(true);
  });

  it("false when the org is enabled but NOT yet live (still provisioning)", async () => {
    vi.stubEnv(WHATSAPP, "true");
    for (const status of ["not_started", "in_progress", "testing"]) {
      setupRow = { enabled: true, status };
      expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
    }
  });

  it("false when the org is live but NOT enabled", async () => {
    vi.stubEnv(WHATSAPP, "true");
    setupRow = { enabled: false, status: "live" };
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
  });

  it("false (fail-closed) when the org has NO setup row", async () => {
    vi.stubEnv(WHATSAPP, "true");
    setupRow = null;
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
  });

  it("false (fail-closed) when the per-org read returns an ERROR", async () => {
    vi.stubEnv(WHATSAPP, "true");
    setupError = { message: "rls denied" };
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
  });

  it("false (fail-closed) when the per-org read THROWS — never propagates into ingestion", async () => {
    vi.stubEnv(WHATSAPP, "true");
    throwOnRead = true;
    expect(await canRunReceptionistChannel({ org_id: ORG, channel: "whatsapp_msg" })).toBe(false);
  });
});

describe("canRunReceptionistChannel — every other channel is fail-closed", () => {
  it("sms, whatsapp_call, instagram_dm, facebook_dm, manual → false even with all flags on", async () => {
    vi.stubEnv(TEXTBACK, "true");
    vi.stubEnv(WHATSAPP, "true");
    setupRow = { enabled: true, status: "live" };
    for (const channel of [
      "sms",
      "whatsapp_call",
      "instagram_dm",
      "facebook_dm",
      "manual",
    ] as const) {
      expect(await canRunReceptionistChannel({ org_id: ORG, channel })).toBe(false);
    }
  });
});
