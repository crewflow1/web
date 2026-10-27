import { describe, it, expect } from "vitest";
import { hashOrgId } from "@/lib/analytics/identity";

/**
 * The analytics distinct id must be a stable, one-way, de-identified token —
 * never the raw org UUID (which would make the org the canonical PostHog person).
 */
describe("hashOrgId", () => {
  it("is stable for the same org", () => {
    expect(hashOrgId("org-123")).toBe(hashOrgId("org-123"));
  });

  it("differs per org and never contains / equals the raw id", () => {
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(hashOrgId("org-a")).not.toBe(hashOrgId("org-b"));
    expect(hashOrgId(uuid)).not.toBe(uuid);
    expect(hashOrgId(uuid)).not.toContain(uuid);
  });

  it("is an opaque org_<32 hex> token", () => {
    expect(hashOrgId("org-123")).toMatch(/^org_[0-9a-f]{32}$/);
  });

  it("falls back to the non-identifying 'server' for empty/blank/nullish", () => {
    expect(hashOrgId("")).toBe("server");
    expect(hashOrgId("   ")).toBe("server");
    expect(hashOrgId(null)).toBe("server");
    expect(hashOrgId(undefined)).toBe("server");
  });
});
