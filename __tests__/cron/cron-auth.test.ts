import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Direct unit coverage for the cron authorisation chokepoint (lib/cron/auth.ts).
 *
 * Every one of the 47 Vercel cron routes gates on `isCronAuthorised` before it
 * does any work, yet until now the function's own logic (secret match, missing
 * secret, maintenance suppression, and the constant-time compare) was only ever
 * exercised through mocks in the per-route tests — the chokepoint itself was
 * untested. These tests pin its four branches so a regression in the one gate
 * protecting the whole cron estate fails loudly.
 */

const envMock: { CRON_SECRET?: string } = {};
const isMaintenanceMode = vi.fn(() => false);

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/maintenance", () => ({ isMaintenanceMode }));

const { isCronAuthorised } = await import("@/lib/cron/auth");

function requestWith(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request("http://localhost/api/cron/sms-drain", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  isMaintenanceMode.mockReturnValue(false);
  envMock.CRON_SECRET = "s3cr3t-cron-token";
});

describe("isCronAuthorised", () => {
  it("accepts the exact Bearer CRON_SECRET header", () => {
    expect(isCronAuthorised(requestWith("Bearer s3cr3t-cron-token"))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(isCronAuthorised(requestWith("Bearer wrong-token"))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    expect(isCronAuthorised(requestWith(undefined))).toBe(false);
  });

  it("rejects a correct secret without the 'Bearer ' scheme", () => {
    expect(isCronAuthorised(requestWith("s3cr3t-cron-token"))).toBe(false);
  });

  it("rejects a prefix of the valid header (length mismatch is not a pass)", () => {
    expect(isCronAuthorised(requestWith("Bearer s3cr3t-cron-toke"))).toBe(false);
  });

  it("fails CLOSED when no CRON_SECRET is configured, even with an empty Bearer", () => {
    envMock.CRON_SECRET = undefined;
    expect(isCronAuthorised(requestWith("Bearer "))).toBe(false);
    expect(isCronAuthorised(requestWith("Bearer undefined"))).toBe(false);
  });

  it("suppresses ALL crons during a maintenance window, even with a valid secret", () => {
    isMaintenanceMode.mockReturnValue(true);
    expect(isCronAuthorised(requestWith("Bearer s3cr3t-cron-token"))).toBe(false);
  });
});
