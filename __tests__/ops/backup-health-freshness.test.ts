/**
 * Unit coverage for the off-platform backup DR freshness classifier
 * (`classifyBackupHealth` in server/services/ops-snapshot.ts).
 *
 * This is the GREEN/AMBER/RED decision that drives the `/admin/ops` backup
 * tile AND folds into the overall ops traffic light — the single on-screen
 * signal that the off-platform encrypted backup (the defence against
 * account/project-level loss while PITR is OFF) is current. Before this file
 * the thresholds were only exercised indirectly; here we pin every branch and
 * every boundary with an injected clock so a future edit that silently relaxes
 * "stale" or lets a failed/absent backup read green is caught by CI.
 *
 * Invariant under test: the classifier fails toward red/amber, NEVER
 * false-green.
 */

import { describe, expect, it } from "vitest";
import {
  BACKUP_STALE_AGE_HOURS,
  BACKUP_STUCK_RUN_HOURS,
  BACKUP_WARN_AGE_HOURS,
  classifyBackupHealth,
  type BackupRunRow,
  type BackupSuccessRow,
} from "@/server/services/ops-snapshot";

// A fixed "now" so every age is deterministic.
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;

/** A successful-run row whose finished_at is `hoursAgo` before NOW. */
function successAt(hoursAgo: number): BackupSuccessRow {
  return {
    finished_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    migration_tip: "20261240000000",
    upload_status: "uploaded",
  };
}

/** A run row with a given status whose started_at is `hoursAgo` before NOW. */
function run(status: string, hoursAgo: number): BackupRunRow {
  return { status, started_at: new Date(NOW - hoursAgo * HOUR).toISOString() };
}

describe("classifyBackupHealth — threshold constants", () => {
  it("encodes the documented DR thresholds (7d warn / 10d stale / 6h stuck)", () => {
    expect(BACKUP_WARN_AGE_HOURS).toBe(7 * 24);
    expect(BACKUP_STALE_AGE_HOURS).toBe(10 * 24);
    expect(BACKUP_STUCK_RUN_HOURS).toBe(6);
  });
});

describe("classifyBackupHealth — green (fresh and healthy)", () => {
  it("is green when the last success is recent and the latest run succeeded", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", 2)],
      lastSuccess: successAt(2),
      now: NOW,
    });
    expect(r.status).toBe("green");
    expect(r.last_success_age_hours).toBe(2);
    expect(r.upload_status).toBe("uploaded");
    expect(r.migration_tip).toBe("20261240000000");
    expect(r.summary).toContain("upload: uploaded");
  });

  it("is still green exactly AT the 7-day warn boundary (strictly greater flips amber)", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", BACKUP_WARN_AGE_HOURS)],
      lastSuccess: successAt(BACKUP_WARN_AGE_HOURS),
      now: NOW,
    });
    expect(r.status).toBe("green");
  });

  it("surfaces 'n/a' upload status without crashing when it is null", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", 1)],
      lastSuccess: { finished_at: successAt(1).finished_at, migration_tip: null, upload_status: null },
      now: NOW,
    });
    expect(r.status).toBe("green");
    expect(r.upload_status).toBeNull();
    expect(r.summary).toContain("upload: n/a");
  });
});

describe("classifyBackupHealth — amber (degraded, not yet critical)", () => {
  it("is amber just PAST 7 days (one hour over the warn boundary)", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", BACKUP_WARN_AGE_HOURS + 1)],
      lastSuccess: successAt(BACKUP_WARN_AGE_HOURS + 1),
      now: NOW,
    });
    expect(r.status).toBe("amber");
    expect(r.summary).toContain(">7d");
  });

  it("is amber at exactly 10 days (stale is strictly GREATER than 10d)", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", BACKUP_STALE_AGE_HOURS)],
      lastSuccess: successAt(BACKUP_STALE_AGE_HOURS),
      now: NOW,
    });
    expect(r.status).toBe("amber");
  });

  it("is amber when a run is stuck 'running' > 6h but the last success is still fresh", () => {
    const r = classifyBackupHealth({
      // newest row is a stale 'running'; no terminal failure behind it
      recentRuns: [run("running", BACKUP_STUCK_RUN_HOURS + 1), run("success", 3)],
      lastSuccess: successAt(3),
      now: NOW,
    });
    expect(r.status).toBe("amber");
    expect(r.summary).toContain("stuck");
    expect(r.last_run_status).toBe("running");
  });

  it("does NOT flag a 'running' row younger than 6h as stuck (stays green)", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("running", BACKUP_STUCK_RUN_HOURS - 1), run("success", 2)],
      lastSuccess: successAt(2),
      now: NOW,
    });
    expect(r.status).toBe("green");
  });
});

describe("classifyBackupHealth — red (critical)", () => {
  it("is red when no successful backup is on record", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("running", 1)],
      lastSuccess: null,
      now: NOW,
    });
    expect(r.status).toBe("red");
    expect(r.last_success_at).toBeNull();
    expect(r.last_success_age_hours).toBeNull();
    expect(r.summary).toMatch(/No successful/i);
  });

  it("is red on a totally empty ledger", () => {
    const r = classifyBackupHealth({ recentRuns: [], lastSuccess: null, now: NOW });
    expect(r.status).toBe("red");
    expect(r.last_run_status).toBeNull();
  });

  it("is red past 10 days (stale) even though a success exists", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("success", BACKUP_STALE_AGE_HOURS + 1)],
      lastSuccess: successAt(BACKUP_STALE_AGE_HOURS + 1),
      now: NOW,
    });
    expect(r.status).toBe("red");
    expect(r.summary).toContain("STALE");
  });

  it("is red when the most recent COMPLETED run FAILED, outranking an old success", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("failed", 1), run("success", 48)],
      lastSuccess: successAt(48),
      now: NOW,
    });
    expect(r.status).toBe("red");
    expect(r.summary).toMatch(/FAILED/);
  });
});

describe("classifyBackupHealth — ordering invariants (the subtle bugs)", () => {
  it("a newer 'running' row does NOT mask an older FAILED run (still red)", () => {
    // Regression guard: last_run is 'running' (in-flight) but the last run that
    // actually completed failed — the DR posture is RED, not "in progress".
    const r = classifyBackupHealth({
      recentRuns: [run("running", 0.5), run("failed", 2), run("success", 50)],
      lastSuccess: successAt(50),
      now: NOW,
    });
    expect(r.status).toBe("red");
    expect(r.last_run_status).toBe("running");
    expect(r.summary).toMatch(/FAILED/);
  });

  it("a fresh success behind an in-flight 'running' stays green (nothing failed)", () => {
    const r = classifyBackupHealth({
      recentRuns: [run("running", 0.5), run("success", 2)],
      lastSuccess: successAt(2),
      now: NOW,
    });
    expect(r.status).toBe("green");
  });

  it("defaults `now` to the current time when omitted (very old success ⇒ red)", () => {
    const r = classifyBackupHealth({
      recentRuns: [{ status: "success", started_at: "2020-01-01T00:00:00.000Z" }],
      lastSuccess: {
        finished_at: "2020-01-01T00:00:00.000Z",
        migration_tip: null,
        upload_status: "uploaded",
      },
      // no `now` → Date.now()
    });
    expect(r.status).toBe("red");
    expect(r.summary).toContain("STALE");
  });
});
