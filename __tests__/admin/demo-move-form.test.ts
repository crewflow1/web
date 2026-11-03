import { describe, it, expect } from "vitest";
import {
  ONBOARD_CONFIRM_TOKEN,
  parseMoveDemoFormData,
} from "@/app/admin/demos/_move-form";

/**
 * Regression for D-14 (found via real Chrome HQ testing, 2026-11-02): the demo
 * detail-panel "Confirm onboarding" button submits a hidden
 * `confirm="ONBOARD"`, but `moveDemoToStatus` used to parse the form WITHOUT
 * reading `confirm` — so the provisioning gate could never be satisfied from the
 * detail panel and a confirmed demo bounced to the interstitial forever, never
 * provisioning a workspace. These tests lock the form contract.
 */

const DEMO_ID = "6b892a1d-cc62-41f8-b4a3-9a430b4b04c1";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("parseMoveDemoFormData", () => {
  it("carries confirm=ONBOARD through the parse (the D-14 fix)", () => {
    const parsed = parseMoveDemoFormData(
      form({ demo_id: DEMO_ID, status: "active_onboarding", confirm: ONBOARD_CONFIRM_TOKEN }),
    );
    expect(parsed.success).toBe(true);
    // The bug: confirm was dropped here, so this used to be undefined.
    expect(parsed.success && parsed.data.confirm).toBe(ONBOARD_CONFIRM_TOKEN);
  });

  it("leaves confirm undefined when the UI did not confirm (gate must bounce)", () => {
    const parsed = parseMoveDemoFormData(
      form({ demo_id: DEMO_ID, status: "active_onboarding" }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.confirm).toBeUndefined();
  });

  it("parses a non-provisioning transition without a confirm token", () => {
    const parsed = parseMoveDemoFormData(
      form({ demo_id: DEMO_ID, status: "contacted" }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe("contacted");
  });

  it("rejects a non-uuid demo_id", () => {
    const parsed = parseMoveDemoFormData(form({ demo_id: "not-a-uuid", status: "contacted" }));
    expect(parsed.success).toBe(false);
  });
});
