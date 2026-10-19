/**
 * Cron-freshness probe for `/api/health`.
 *
 * The problem it closes: production was DOWN for five days (Vercel billing
 * suspension — HTTP 402 on everything) and nobody was notified. The external
 * outage monitor (`.github/workflows/outage-monitor.yml`) catches the
 * hard-down case by status code, but a subtler failure mode remains: the page
 * serves fine while the Vercel cron scheduler has silently stopped (crons
 * disabled, scheduler outage, deploy with a broken cron auth). Nothing
 * user-facing goes red, yet notifications stop draining, webhooks stop
 * dispatching and reminders stop sending. This probe makes that failure
 * OBSERVABLE from the outside: it reports how long ago the last SUCCESSFUL
 * cron run started, bucketed, so the monitor can alert on staleness.
 *
 * Same doctrine as `db-probe.ts`: reads `process.env` DIRECTLY, imports no
 * SDK and no `@/lib/supabase` module, carries no `import "server-only"` — so
 * it is edge-safe (the health route runs on the edge runtime),
 * dependency-free, and CAN NEVER THROW. Every failure mode collapses to
 * `{ ageMinutes: null }` ("unknown"), never a rejection, and unknown must
 * NEVER gate the endpoint's `ok` — a probe that cannot answer is not an
 * outage.
 *
 * Credential posture: `cron_runs` is service-role-only (RLS enabled, no
 * policies), so this is the one read in the health path that uses
 * `SUPABASE_SERVICE_ROLE_KEY`. The key never leaves the server: the query is
 * a single indexed top-1 read (`ok = true` + `started_at desc` — exactly the
 * existing `cron_runs_ok_started_idx`), only `started_at` is selected, and
 * the ONLY thing serialised to the public response is a BUCKETED integer age
 * in minutes (5-minute buckets, capped at 24h). No timestamps, no route
 * names, no summaries, no env-var names — nothing an attacker can use beyond
 * "crons ran recently", which is precisely the signal being published.
 */

export type CronFreshness = {
  /**
   * Minutes since the last successful cron run started, floored to a 5-minute
   * bucket and capped at 1440 (24h). `null` means UNKNOWN — missing config,
   * timeout, query failure, or no successful run in the retained window — and
   * must be treated as "cannot tell", never as "stale" and never as an outage.
   */
  ageMinutes: number | null;
};

/** Fail closed if the DB has not answered within this budget. Health checks must stay snappy. */
const PROBE_TIMEOUT_MS = 2000;

/** Bucket granularity — coarse enough to publish, fine enough to alert on. */
const BUCKET_MINUTES = 5;

/** Everything older than a day reads the same: unambiguously stale. */
const MAX_AGE_MINUTES = 1440;

/**
 * Bucket a raw age into the published value: floor to 5-minute buckets, clamp
 * to [0, 1440]. Exported for unit tests; pure.
 */
export function bucketCronAgeMinutes(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  const minutes = Math.floor(ageMs / 60_000);
  const bucketed = Math.floor(minutes / BUCKET_MINUTES) * BUCKET_MINUTES;
  return Math.min(bucketed, MAX_AGE_MINUTES);
}

/**
 * Read the most recent successful cron run's start time and return its
 * bucketed age. Never throws, never rejects, never gates health `ok`.
 */
export async function probeCronFreshness(): Promise<CronFreshness> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Missing config ⇒ unknown. Local dev and preview builds land here.
  if (!url || !serviceKey) return { ageMinutes: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Top-1 on (ok = true, started_at desc) — served whole by the existing
    // `cron_runs_ok_started_idx` index, so the health path stays cheap however
    // large the retained window grows. "Last SUCCESSFUL run" is deliberate:
    // a scheduler that fires but whose every run fails is also an incident.
    const res = await fetch(
      `${url}/rest/v1/cron_runs?select=started_at&ok=eq.true&order=started_at.desc&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (res.status !== 200) return { ageMinutes: null };

    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return { ageMinutes: null };
    const startedAt = (rows[0] as { started_at?: unknown }).started_at;
    if (typeof startedAt !== "string") return { ageMinutes: null };

    const startedMs = Date.parse(startedAt);
    if (Number.isNaN(startedMs)) return { ageMinutes: null };

    return { ageMinutes: bucketCronAgeMinutes(Date.now() - startedMs) };
  } catch {
    // Abort (timeout) or any network/DNS/TLS/parse error: unknown, not stale.
    return { ageMinutes: null };
  } finally {
    clearTimeout(timer);
  }
}
