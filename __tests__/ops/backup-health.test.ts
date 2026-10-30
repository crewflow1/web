import { describe, it, expect } from "vitest";
import {
  classifyBackupHealth,
  type BackupRunRow,
} from "@/server/services/ops-snapshot";

/**
 * Off-platform backup (DR) health classifier — unit tests for the pure
 * traffic-light rules extracted from the ops-snapshot DB read.
 *
 * These lock the /admin/ops freshness tripwire thresholds so a missed or
 * failed backup can never silently read GREEN:
 *   GREEN ≤7d · AMBER >7d (or stuck "running" >6h) · RED >10d / failed / none.
 *
 * `now` is injected so age maths are deterministic.
 */

const NOW = Date.parse("2026-10-30T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

const success = (overrides: Partial<BackupRunRow> = {}): BackupRunRow => ({
  status: "success",
  started_at: overrides.finished_at ?? daysAgo(1),
  finished_at: daysAgo(1),
  upload_status: "uploaded",
  migration_tip: "20261240000000",
  ...overrides,
});

describe("classifyBackupHealth", () => {
  it("is GREEN when the last validated success is within 7 days", () => {
    const run = success({ finished_at: daysAgo(2) });
    const h = classifyBackupHealth([run], run, NOW);
    expect(h.status).toBe("green");
    expect(h.last_success_age_hours).toBe(48);
    expect(h.upload_status).toBe("uploaded");
    expect(h.migration_tip).toBe("20261240000000");
    expect(h.summary).toContain("upload: uploaded");
  });

  it("is AMBER when the last success is older than 7 days", () => {
    const run = success({ finished_at: daysAgo(8) });
    const h = classifyBackupHealth([run], run, NOW);
    expect(h.status).toBe("amber");
    expect(h.summary).toContain(">7d");
  });

  it("is RED when the last success is older than 10 days (stale)", () => {
    const run = success({ finished_at: daysAgo(12) });
    const h = classifyBackupHealth([run], run, NOW);
    expect(h.status).toBe("red");
    expect(h.summary).toContain("STALE");
  });

  it("is RED when there is no successful backup on record", () => {
    const h = classifyBackupHealth([], null, NOW);
    expect(h.status).toBe("red");
    expect(h.last_success_at).toBeNull();
    expect(h.last_success_age_hours).toBeNull();
    expect(h.summary).toContain("No successful off-platform backup");
  });

  it("is RED when the most recent COMPLETED run failed, even with a recent success before it", () => {
    const failed: BackupRunRow = {
      status: "failed",
      started_at: hoursAgo(2),
    };
    const ok = success({ finished_at: daysAgo(1) });
    // ordered started_at DESC: the failure is newest terminal.
    const h = classifyBackupHealth([failed, ok], ok, NOW);
    expect(h.status).toBe("red");
    expect(h.summary).toContain("FAILED");
  });

  it("does NOT let a newer 'running' row hide an older failure", () => {
    const running: BackupRunRow = { status: "running", started_at: hoursAgo(1) };
    const failed: BackupRunRow = { status: "failed", started_at: hoursAgo(3) };
    const ok = success({ finished_at: daysAgo(1) });
    const h = classifyBackupHealth([running, failed, ok], ok, NOW);
    expect(h.status).toBe("red");
    expect(h.last_run_status).toBe("running");
  });

  it("is AMBER when a run is stuck 'running' >6h while last success is fresh", () => {
    const running: BackupRunRow = { status: "running", started_at: hoursAgo(7) };
    const ok = success({ finished_at: daysAgo(1) });
    const h = classifyBackupHealth([running, ok], ok, NOW);
    expect(h.status).toBe("amber");
    expect(h.summary).toContain("stuck");
  });

  it("stays GREEN for a short-lived 'running' row (<6h) over a fresh success", () => {
    const running: BackupRunRow = { status: "running", started_at: hoursAgo(1) };
    const ok = success({ finished_at: daysAgo(1) });
    const h = classifyBackupHealth([running, ok], ok, NOW);
    expect(h.status).toBe("green");
  });

  it("reports GREEN exactly at the 7-day boundary (≤7d is fresh)", () => {
    const run = success({ finished_at: daysAgo(7) });
    const h = classifyBackupHealth([run], run, NOW);
    expect(h.status).toBe("green");
  });
});
