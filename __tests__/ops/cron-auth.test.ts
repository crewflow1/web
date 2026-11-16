import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * isCronAuthorised — the one chokepoint in front of all 48 scheduled endpoints.
 *
 * Behavioural: fail-closed when no secret is configured, exact-match only, and
 * suppressed in maintenance mode. Source pin: the comparison is constant-time
 * (no `===` on the secret), because a string compare that returns at the first
 * differing byte is a guessing oracle on a secret that gates provider spend.
 *
 * The "secret" here is an inert fixture string, never a real value.
 */

const state = vi.hoisted(() => ({ secret: undefined as string | undefined, maintenance: false }));
vi.mock("@/lib/env", () => ({
  env: {
    get CRON_SECRET() {
      return state.secret;
    },
  },
}));
vi.mock("@/lib/maintenance", () => ({ isMaintenanceMode: () => state.maintenance }));

import { isCronAuthorised } from "@/lib/cron/auth";

const FIXTURE = "fixture-cron-value-for-tests";
const req = (authorization?: string) =>
  new Request("https://crewflow.test/api/cron/x", {
    headers: authorization === undefined ? {} : { authorization },
  });

beforeEach(() => {
  state.secret = FIXTURE;
  state.maintenance = false;
});

describe("isCronAuthorised", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(isCronAuthorised(req(`Bearer ${FIXTURE}`))).toBe(true);
  });

  it("refuses a missing, empty, wrong, prefix, suffix, case-changed or scheme-less header", () => {
    for (const h of [
      undefined,
      "",
      "Bearer ",
      "Bearer wrong",
      `Bearer ${FIXTURE.slice(0, -1)}`,
      `Bearer ${FIXTURE}x`,
      `bearer ${FIXTURE}`,
      FIXTURE,
      `Bearer ${FIXTURE.toUpperCase()}`,
      `Basic ${FIXTURE}`,
    ]) {
      expect(isCronAuthorised(req(h)), String(h)).toBe(false);
    }
  });

  it("FAILS CLOSED when no secret is configured — even for `Bearer undefined` / `Bearer `", () => {
    state.secret = undefined;
    for (const h of [undefined, "Bearer ", "Bearer undefined", "Bearer null"]) {
      expect(isCronAuthorised(req(h)), String(h)).toBe(false);
    }
    state.secret = "";
    expect(isCronAuthorised(req("Bearer "))).toBe(false);
  });

  it("refuses everything during maintenance mode, valid secret included", () => {
    state.maintenance = true;
    expect(isCronAuthorised(req(`Bearer ${FIXTURE}`))).toBe(false);
  });

  it("compares in constant time — no `===` on the secret (source pin)", () => {
    const src = readFileSync(resolve(__dirname, "../../lib/cron/auth.ts"), "utf8");
    // The gate delegates to the shared digest-then-timingSafeEqual helper.
    expect(src).toMatch(/constantTimeEqual\(header, `Bearer \$\{secret\}`\)/);
    expect(src).not.toMatch(/header\s*===\s*`Bearer/);
    const helper = readFileSync(resolve(__dirname, "../../lib/security/constant-time.ts"), "utf8");
    expect(helper).toMatch(/timingSafeEqual\(/);
  });
});
