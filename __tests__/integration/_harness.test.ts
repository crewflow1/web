import { describe, expect, it } from "vitest";
import { hasLiveDb, ukTodayIso } from "./_harness";
import { formatDayKeyUK } from "@/lib/time/format";

/**
 * Wiring smoke test for the integration tier. Runs everywhere — no DB
 * required: it proves the integration vitest config + setup load and that
 * the live-DB guard resolves. The DB-dependent suites use
 * describeIntegration (see _harness.ts) and skip when no database is present.
 */
describe("integration harness wiring", () => {
  it("exposes a boolean live-DB guard", () => {
    expect(typeof hasLiveDb()).toBe("boolean");
  });

  it("agrees with the connection env it reads", () => {
    const configured =
      Boolean(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      Boolean(process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
      Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(hasLiveDb()).toBe(configured);
  });
});

/**
 * THE CLOCK PIN — deterministic, and runs with or without a database.
 *
 * `ukTodayIso()` exists so a suite can hand a UK-bucketing RPC the date the
 * DATABASE is in. `new Date().toISOString().slice(0, 10)` looks like the same
 * thing and IS the same thing for 23 hours a day, which is precisely why it
 * survived review: in BST the two disagree from 23:00 UTC, and on the last day
 * of a month they disagree by a WHOLE MONTH, so every month rollup the tier
 * reads comes back empty. That is what turned main red at 2026-07-31 23:05 UTC
 * with 17 failures across two AI files and nothing but the clock to blame.
 *
 * The instant below is frozen at the one the build died on, so this fails at
 * ANY hour if the derivation regresses — not only during the one hour a month
 * that makes the mistake visible.
 */
describe("integration harness · the UK day key", () => {
  it("reads Europe/London, not UTC — recomputed independently of the helper", () => {
    const independent = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    expect(ukTodayIso()).toBe(independent);
  });

  it("at the instant main went red, UK and UTC name DIFFERENT MONTHS", () => {
    // 23:07:48 UTC on 31 July 2026 — the timestamp on the first failing
    // assertion of run 30671912786.
    const wentRed = new Date("2026-07-31T23:07:48Z");
    expect(formatDayKeyUK(wentRed)).toBe("2026-08-01");
    expect(wentRed.toISOString().slice(0, 10)).toBe("2026-07-31");
    // The whole defect in one line: the discarded expression would have asked
    // the rollups for JULY while `now()` was already writing into AUGUST.
    expect(formatDayKeyUK(wentRed).slice(0, 7)).not.toBe(
      wentRed.toISOString().slice(0, 10).slice(0, 7),
    );
  });
});
