import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Control cron auth per-test (env.CRON_SECRET is frozen at import in this env).
vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised: vi.fn() }));

import { isCronAuthorised } from "@/lib/cron/auth";
import { GET } from "@/app/api/cron/bank-sync/route";

/**
 * Bank-feed cron seam — auth + dark no-op proofs.
 *
 * The route pulls each connected org's transactions on a schedule. While dark
 * (always today) a tick is an empty 204 with ZERO database access — the readiness
 * gate sits before telemetry. It is CRON_SECRET-gated (401 otherwise).
 */

const mockAuth = vi.mocked(isCronAuthorised);

const BANKING_ENV = [
  "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
  "BANKING_PROVIDER",
  "BANKING_CLIENT_ID",
  "BANKING_CLIENT_SECRET",
];

beforeEach(() => {
  for (const k of BANKING_ENV) delete process.env[k];
  vi.restoreAllMocks();
});
afterEach(() => {
  for (const k of BANKING_ENV) delete process.env[k];
});

function req(): Request {
  return new Request("https://app.example/api/cron/bank-sync");
}

describe("GET /api/cron/bank-sync", () => {
  it("401s when the cron secret is not presented", async () => {
    mockAuth.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("204 no-op with zero DB access while dark (authorised but no provider ready)", async () => {
    mockAuth.mockReturnValue(true);
    // No BANKING_* env ⇒ no bound provider ⇒ dark.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET(req());
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
