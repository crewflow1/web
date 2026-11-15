import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bucketBackupAgeHours, probeBackupFreshness } from "@/lib/health/backup-freshness";

/**
 * Backup freshness — the independent "the Mac stopped backing up" signal.
 * Pure bucketing, a probe that can never throw, and the monitor job that alerts on it.
 */
function fetchReturning(rows: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(rows) });
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const H = 3_600_000;

describe("bucketBackupAgeHours — the only value that may be published", () => {
  it("floors to 6-hour buckets and caps at 240", () => {
    expect(bucketBackupAgeHours(0)).toBe(0);
    expect(bucketBackupAgeHours(5 * H)).toBe(0);
    expect(bucketBackupAgeHours(6 * H)).toBe(6);
    expect(bucketBackupAgeHours(41 * H)).toBe(36);
    expect(bucketBackupAgeHours(43 * H)).toBe(42);
    expect(bucketBackupAgeHours(30 * 24 * H)).toBe(240);
  });
  it("clock skew and garbage collapse to 0, never negative or NaN", () => {
    expect(bucketBackupAgeHours(-5 * H)).toBe(0);
    expect(bucketBackupAgeHours(Number.NaN)).toBe(0);
  });
});

describe("probeBackupFreshness — never throws, unknown is null", () => {
  it("missing config → null (local / preview)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await probeBackupFreshness()).toEqual({ ageHours: null });
  });
  it("reads only the newest SUCCESSFUL run and publishes a bucketed age", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const f = fetchReturning([{ finished_at: "2026-11-15T20:17:00Z" }]);
    vi.stubGlobal("fetch", f);
    expect(await probeBackupFreshness()).toEqual({ ageHours: 36 }); // 39h43m → 36
    const url = String(f.mock.calls[0]![0]);
    expect(url).toContain("ops_backup_runs?select=finished_at&status=eq.success&order=finished_at.desc&limit=1");
  });
  it.each([
    ["non-200", fetchReturning([], 500)],
    ["no successful run on record", fetchReturning([])],
    ["malformed row", fetchReturning([{ finished_at: 12 }])],
    ["unparseable timestamp", fetchReturning([{ finished_at: "not-a-date" }])],
    ["network error", vi.fn().mockRejectedValue(new Error("boom"))],
  ])("%s → null, never a rejection", async (_label, f) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", f);
    await expect(probeBackupFreshness()).resolves.toEqual({ ageHours: null });
  });
});

describe("the monitor alerts on a stale backup with no new provider", () => {
  const yml = readFileSync(resolve(__dirname, "../../.github/workflows/outage-monitor.yml"), "utf8");
  const job = yml.slice(yml.indexOf("  backup-freshness:"));
  it("has a separate backup-freshness job reading the published field", () => {
    expect(job).toContain(".backups.lastSuccessAgeHours");
    expect(job).toMatch(/BACKUP_STALE_AFTER_HOURS: "36"/);
  });
  it("null / unknown warns but never alerts", () => {
    expect(job).toMatch(/lastSuccessAgeHours is null[^\n]*unobservable/);
    expect(job.match(/stale=false/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("raises ONE deduped issue, fails the run (GitHub emails it) and closes the issue on recovery", () => {
    expect(job).toContain("--label backup-stale");
    expect(job).toContain("gh issue close");
    expect(job).toMatch(/BACKUP STALE[\s\S]*exit 1/);
  });
  it("uses only the workflow's own token and never interpolates response text into a script", () => {
    expect(job).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(job).not.toMatch(/run:[^\n]*\$\{\{/);
  });
  it("the health route publishes the bucketed integer only", () => {
    const route = readFileSync(resolve(__dirname, "../../app/api/health/route.ts"), "utf8");
    expect(route).toContain("lastSuccessAgeHours: backup.ageHours");
  });
});
