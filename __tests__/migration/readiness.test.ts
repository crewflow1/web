import { afterEach, describe, expect, it, vi } from "vitest";
import { getMigrationReadiness } from "@/lib/migration/readiness";

afterEach(() => vi.unstubAllEnvs());

describe("getMigrationReadiness", () => {
  it("is dark when no operator allowlist is set", () => {
    vi.stubEnv("CREWFLOW_SUPERADMIN_EMAILS", "");
    expect(getMigrationReadiness()).toEqual({ operatorAllowlistConfigured: false });
  });

  it("reports configured when the allowlist names an operator", () => {
    vi.stubEnv("CREWFLOW_SUPERADMIN_EMAILS", "op@crewflow.uk");
    expect(getMigrationReadiness().operatorAllowlistConfigured).toBe(true);
  });

  it("treats whitespace-only as unconfigured", () => {
    vi.stubEnv("CREWFLOW_SUPERADMIN_EMAILS", "   ");
    expect(getMigrationReadiness().operatorAllowlistConfigured).toBe(false);
  });
});
