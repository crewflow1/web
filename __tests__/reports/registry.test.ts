import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPORT_KEYS,
  isReportKey,
  isReportFormat,
  isReportCadence,
} from "@/lib/reports/registry";

/**
 * REPORT REGISTRY — lock-step with the DB CHECK, the DSAR census, and the cron
 * wiring. A report key exists in ONE place (the registry); these pins prove the
 * rest of the system agrees, so a new report can't be half-wired.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("registry type guards", () => {
  it("accepts known values and rejects impostors", () => {
    expect(isReportKey("profit")).toBe(true);
    expect(isReportKey("nope")).toBe(false);
    expect(isReportFormat("pdf")).toBe(true);
    expect(isReportFormat("xlsx")).toBe(false);
    expect(isReportCadence("weekly")).toBe(true);
    expect(isReportCadence("hourly")).toBe(false);
  });
});

describe("report_subscriptions migration mirrors the registry", () => {
  const migration = read("supabase/migrations/20261134000000_report_subscriptions.sql");

  it("the report_key CHECK names EXACTLY the registry keys", () => {
    for (const key of REPORT_KEYS) {
      expect(migration.includes(`'${key}'`), `CHECK missing report key ${key}`).toBe(true);
    }
  });

  it("enables RLS with member-read / admin-write policies", () => {
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/current_org_ids\(\)/); // member select
    expect(migration).toMatch(/is_org_admin\(org_id\)/); // admin write
    expect(migration).toMatch(/for insert to authenticated/);
    expect(migration).toMatch(/for delete to authenticated/);
  });
});

describe("report_subscriptions is registered for the DSAR export census", () => {
  it("appears in the org-scoped tables snapshot", () => {
    const json = JSON.parse(read("lib/gdpr/org-tables.json")) as { known: string[] };
    expect(json.known).toContain("report_subscriptions");
  });
});

describe("the delivery cron is registered", () => {
  it("vercel.json schedules /api/cron/report-delivery", () => {
    const vercel = read("vercel.json");
    expect(vercel).toContain("/api/cron/report-delivery");
  });

  it("the cron is classified in the fairness allowlist", () => {
    const guard = read("__tests__/security/cron-fairness-guard.test.ts");
    expect(guard).toMatch(/"report-delivery":/);
  });
});
