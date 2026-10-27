import { describe, it, expect } from "vitest";
import { maskUuidsInUrl, sanitizeAnalyticsProperties } from "@/lib/analytics/sanitize-url";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("maskUuidsInUrl", () => {
  it("masks a UUID in a path", () => {
    expect(maskUuidsInUrl(`https://crewflow.uk/jobs/${UUID}`)).toBe("https://crewflow.uk/jobs/:id");
  });

  it("masks multiple UUIDs including query values", () => {
    expect(maskUuidsInUrl(`/customers/${UUID}?org=${UUID}&tab=invoices`)).toBe(
      "/customers/:id?org=:id&tab=invoices",
    );
  });

  it("leaves a UUID-free URL untouched", () => {
    expect(maskUuidsInUrl("https://crewflow.uk/dashboard?page=2")).toBe(
      "https://crewflow.uk/dashboard?page=2",
    );
  });
});

describe("sanitizeAnalyticsProperties", () => {
  it("masks URL-bearing properties and leaves others untouched", () => {
    const out = sanitizeAnalyticsProperties({
      $current_url: `https://crewflow.uk/jobs/${UUID}`,
      $pathname: `/jobs/${UUID}`,
      $referrer: `https://crewflow.uk/customers/${UUID}`,
      org_id: UUID, // not a URL key → left as-is (grouping dimension)
      $screen_height: 800,
    });
    expect(out.$current_url).toBe("https://crewflow.uk/jobs/:id");
    expect(out.$pathname).toBe("/jobs/:id");
    expect(out.$referrer).toBe("https://crewflow.uk/customers/:id");
    expect(out.org_id).toBe(UUID);
    expect(out.$screen_height).toBe(800);
  });

  it("is a no-op when no URL property is present", () => {
    expect(sanitizeAnalyticsProperties({ $screen_width: 1024 })).toEqual({ $screen_width: 1024 });
  });
});
