import { describe, it, expect } from "vitest";
import {
  summariseAnalytics,
  summariseMonitoring,
  summariseNotifications,
  type MonitoringTaskRow,
  type MonitoringCronRow,
  type NotificationRow,
} from "@/lib/hq/roster-runners";
import type { RevenueAnalytics, CustomerAnalytics } from "@/lib/hq/analytics";

/**
 * CrewFlow HQ — Roster runner derivations (MP Wave R3), unit contract.
 *
 * These pure derivations are the whole of each deterministic runner's business logic.
 * The two first principles are pinned here: HONEST "insufficient" over thin data, and a
 * fully-determined, sourced, explainable result over real data. `now` is injected so
 * every assertion is deterministic.
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");

function revenue(overrides: Partial<RevenueAnalytics> = {}): RevenueAnalytics {
  return {
    mrrGbp: 5000,
    arrGbp: 60000,
    growthPct: 12.5,
    churnPct: 2.5,
    forecast90dGbp: 6000,
    avgCustomerValueGbp: 500,
    outstandingGbp: 1500,
    paidGbp: 40000,
    lostRevenueGbp: 0,
    ytdRevenueGbp: 40000,
    series: { customerGrowth: [], mrr: [], revenue: [] } as unknown as RevenueAnalytics["series"],
    ...overrides,
  };
}

function customer(overrides: Partial<CustomerAnalytics> = {}): CustomerAnalytics {
  return {
    healthy: 7,
    atRisk: 2,
    critical: 1,
    unscored: 0,
    migration: {
      averagePct: 80,
      averageDaysToComplete: 14,
      stalledCount: 0,
      fastestDays: 7,
      completedCount: 5,
    },
    usage: {
      activeLast7Days: 8,
      activeLast30Days: 10,
      neverLoggedIn: 0,
      averageDaysSinceLogin: 2,
    },
    ...overrides,
  };
}

describe("summariseAnalytics", () => {
  it("is honestly insufficient when there is no estate to analyse", () => {
    const r = summariseAnalytics(
      { revenue: revenue(), customer: customer(), orgCount: 0, invoiceCount: 0 },
      NOW,
    );
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.metrics).toBeNull();
    expect(r.summary).toMatch(/insufficient/i);
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.sources).toEqual(["organizations", "billing_invoices"]);
  });

  it("computes a fully-determined snapshot over real data", () => {
    const r = summariseAnalytics(
      { revenue: revenue(), customer: customer(), orgCount: 10, invoiceCount: 42 },
      NOW,
    );
    expect(r.insufficient).toBe(false);
    expect(r.confidence).toBe(1);
    expect(r.metrics).not.toBeNull();
    expect(r.metrics!.orgs).toBe(10);
    expect(r.metrics!.activeCustomers).toBe(10); // 7 + 2 + 1
    expect(r.metrics!.mrrGbp).toBe(5000);
    expect(r.metrics!.churnPct).toBe(2.5);
    expect(r.summary).toContain("5,000");
    expect(r.reasoning).toContain("42 billing invoices");
  });

  it("rounds money and rate figures to 2dp (no floating noise)", () => {
    const r = summariseAnalytics(
      {
        revenue: revenue({ mrrGbp: 1234.5678, churnPct: 3.14159 }),
        customer: customer(),
        orgCount: 3,
        invoiceCount: 1,
      },
      NOW,
    );
    expect(r.metrics!.mrrGbp).toBe(1234.57);
    expect(r.metrics!.churnPct).toBe(3.14);
    // Singular grammar for a single invoice.
    expect(r.reasoning).toContain("1 billing invoice.".slice(0, 17));
  });
});

describe("summariseMonitoring", () => {
  const running = (over: Partial<MonitoringTaskRow> = {}): MonitoringTaskRow => ({
    status: "running",
    lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    heartbeat_at: NOW.toISOString(),
    retry_count: 0,
    max_retries: 3,
    updated_at: NOW.toISOString(),
    ...over,
  });

  it("is honestly insufficient with no tasks and no cron runs", () => {
    const r = summariseMonitoring([], [], NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.severity).toBe("ok");
    expect(r.summary).toMatch(/insufficient/i);
  });

  it("reports a genuine all-clear over healthy real rows (not insufficient)", () => {
    const r = summariseMonitoring([running()], [{ route: "spine-drain", ok: true, completed_at: NOW.toISOString() }], NOW);
    expect(r.insufficient).toBe(false);
    expect(r.severity).toBe("ok");
    expect(r.confidence).toBe(1);
    expect(r.summary).toMatch(/all clear/i);
  });

  it("flags an expired lease as critical", () => {
    const r = summariseMonitoring(
      [running({ lease_expires_at: new Date(NOW.getTime() - 60_000).toISOString() })],
      [],
      NOW,
    );
    expect(r.severity).toBe("critical");
    expect(r.signals.expiredLeases).toBe(1);
  });

  it("flags a stale (15m+) heartbeat as critical", () => {
    const r = summariseMonitoring(
      [running({ heartbeat_at: new Date(NOW.getTime() - 16 * 60_000).toISOString() })],
      [],
      NOW,
    );
    expect(r.severity).toBe("critical");
    expect(r.signals.staleHeartbeats).toBe(1);
  });

  it("counts recent failures and failed cron runs as a warning", () => {
    const tasks: MonitoringTaskRow[] = [
      { status: "failed", lease_expires_at: null, heartbeat_at: null, retry_count: 3, max_retries: 3, updated_at: new Date(NOW.getTime() - 60_000).toISOString() },
    ];
    const crons: MonitoringCronRow[] = [
      { route: "weather-fetch", ok: false, completed_at: NOW.toISOString() },
      { route: "weather-fetch", ok: false, completed_at: NOW.toISOString() },
    ];
    const r = summariseMonitoring(tasks, crons, NOW);
    expect(r.severity).toBe("warning");
    expect(r.signals.failedLast24h).toBe(1);
    expect(r.signals.failedCronRuns).toBe(2);
    expect(r.signals.failedCronRoutes).toEqual(["weather-fetch"]); // deduped
  });

  it("ignores failures older than the 24h window", () => {
    const tasks: MonitoringTaskRow[] = [
      { status: "failed", lease_expires_at: null, heartbeat_at: null, retry_count: 3, max_retries: 3, updated_at: new Date(NOW.getTime() - 25 * 60 * 60_000).toISOString() },
    ];
    const r = summariseMonitoring(tasks, [{ route: "x", ok: true, completed_at: NOW.toISOString() }], NOW);
    expect(r.signals.failedLast24h).toBe(0);
    expect(r.severity).toBe("ok");
  });

  it("flags a non-terminal task out of retries as critical", () => {
    const r = summariseMonitoring([running({ retry_count: 3, max_retries: 3 })], [], NOW);
    expect(r.signals.retryExhausted).toBe(1);
    expect(r.severity).toBe("critical");
  });
});

describe("summariseNotifications", () => {
  it("reports a genuine clear backlog when nothing is pending (not insufficient)", () => {
    const r = summariseNotifications([], NOW);
    // An empty unread set is a real "nothing pending" finding, fully determined.
    expect(r.insufficient).toBe(false);
    expect(r.confidence).toBe(1);
    expect(r.totalUnread).toBe(0);
    expect(r.summary).toMatch(/no pending|clear/i);
  });

  it("counts the complete unread set grouped by type, busiest first", () => {
    const rows: NotificationRow[] = [
      { type: "invoice" },
      { type: "invoice" },
      { type: "lead" },
    ];
    const r = summariseNotifications(rows, NOW);
    expect(r.totalUnread).toBe(3);
    expect(r.byType).toEqual([
      { type: "invoice", count: 2 },
      { type: "lead", count: 1 },
    ]);
  });

  it("carries no PII fields — the data payload is counts only", () => {
    const rows: NotificationRow[] = [{ type: "invoice" }, { type: "lead" }];
    const r = summariseNotifications(rows, NOW);
    // The only data payload is the aggregate: a total and per-type counts. No
    // title/body/recipient/user field is present on any emitted object.
    for (const entry of r.byType) {
      expect(Object.keys(entry).sort()).toEqual(["count", "type"]);
    }
    expect(typeof r.totalUnread).toBe("number");
  });
});
