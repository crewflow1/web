/**
 * Backup-freshness probe for `/api/health`.
 *
 * The problem it closes: the off-platform backup runs on the founder's Mac. When that Mac is
 * asleep, off or offline, NOTHING in production notices — `/admin/ops` only goes amber/red for
 * someone who opens it, and every scheduled 03:17 run in November 2026 failed for days without
 * an alert. This probe makes "no successful backup recently" OBSERVABLE from the outside, so
 * the independent monitor (`.github/workflows/outage-monitor.yml`, GitHub-hosted, no dependency
 * on the Mac or on Vercel) can raise an issue and email the founder.
 *
 * Same doctrine as `cron-freshness.ts`: reads `process.env` directly, imports no SDK, is
 * edge-safe, and CAN NEVER THROW. Every failure collapses to `{ ageHours: null }` ("unknown"),
 * which must never gate the endpoint's `ok` and never raise a stale alert by itself.
 *
 * Credential posture: `ops_backup_runs` is service-role-only. One indexed top-1 read
 * (`status = success`, newest `finished_at`), only `finished_at` is selected, and the ONLY
 * thing published is a BUCKETED integer age in hours (6-hour buckets, capped at 10 days). No
 * timestamps, no host names, no artefact names, no migration tip.
 */

export type BackupFreshness = {
  /**
   * Hours since the last SUCCESSFUL off-platform backup finished, floored to a 6-hour bucket
   * and capped at 240 (10 days). `null` = UNKNOWN (missing config, timeout, query failure, or
   * no successful run on record) — "cannot tell", never "stale".
   */
  ageHours: number | null;
};

const PROBE_TIMEOUT_MS = 2000;
const BUCKET_HOURS = 6;
const MAX_AGE_HOURS = 240;

/** Floor to 6-hour buckets, clamp to [0, 240]. Exported for unit tests; pure. */
export function bucketBackupAgeHours(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  const hours = Math.floor(ageMs / 3_600_000);
  return Math.min(Math.floor(hours / BUCKET_HOURS) * BUCKET_HOURS, MAX_AGE_HOURS);
}

/** Never throws, never rejects, never gates health `ok`. */
export async function probeBackupFreshness(): Promise<BackupFreshness> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { ageHours: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${url}/rest/v1/ops_backup_runs?select=finished_at&status=eq.success&order=finished_at.desc&limit=1`,
      {
        method: "GET",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (res.status !== 200) return { ageHours: null };
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return { ageHours: null };
    const finishedAt = (rows[0] as { finished_at?: unknown }).finished_at;
    if (typeof finishedAt !== "string") return { ageHours: null };
    const finishedMs = Date.parse(finishedAt);
    if (Number.isNaN(finishedMs)) return { ageHours: null };
    return { ageHours: bucketBackupAgeHours(Date.now() - finishedMs) };
  } catch {
    return { ageHours: null };
  } finally {
    clearTimeout(timer);
  }
}
