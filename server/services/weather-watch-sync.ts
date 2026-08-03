import "server-only";

/**
 * Weather intelligence — the WATCH PRODUCER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 * `weather_watches` (migration 20261074) is READ in two places — the fetch
 * pipeline (server/services/weather-fetch.ts selects the active districts) and
 * the tenant read path (server/services/weather.ts::readWeatherWatches) — and,
 * until this file, was WRITTEN by nothing. No cron, trigger, action or UI ever
 * created a watch, so `runWeatherFetch` short-circuited on "no active watches —
 * nothing to fetch", `weather_readings` stayed empty, and the whole feature was
 * inert even once a provider was bound. This is the producer that fills the gap.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO EXTERNAL DEPENDENCY — this is the DARK-SAFE half
 * ═══════════════════════════════════════════════════════════════════════════
 * A watch is derived ENTIRELY from data CrewFlow already holds: a live job's
 * postcode district, computed by `districtForAddress(resolveJobAddress(job,
 * customer))` — the same pure, network-free key derivation the rest of the
 * feature uses. It calls NO weather provider, puts NOTHING on any wire, and
 * spends no budget, so it runs regardless of whether a provider is configured.
 * That is deliberate and it is the point: watches must already exist so that on
 * the day a provider IS bound the fetch pipeline has districts to fetch, and so
 * `getWeatherReadiness({ hasActiveWatches })` can report the honest truth rather
 * than green-over-empty. The FETCH half stays dark; producing watches does not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SERVICE ROLE, because it writes across every tenant at once
 * ═══════════════════════════════════════════════════════════════════════════
 * Like the fetch pipeline, this runs as an internal cron over all orgs, so it
 * uses `createAdminClient` (RLS-bypassing). Org scoping is preserved WITHOUT
 * RLS's help: every watch's `org_id` is copied from the job it anchors, and the
 * migration's `tg_weather_watch_org_integrity` trigger still fires on the
 * service-role insert and refuses any watch whose job is not in that org — so a
 * bug here cannot manufacture a cross-tenant anchor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RECONCILIATION, not blind insert — and it handles CLOSING
 * ═══════════════════════════════════════════════════════════════════════════
 * The schema CASCADE-deletes an anchored watch when its job is DELETED
 * (weather_watches.job_id ... on delete cascade), so deletion cleans itself up
 * and this file deliberately builds none. But COMPLETING or BLOCKING a job does
 * not delete it — the row stays, its cascade never fires, and a stale active
 * watch would keep the district under watch forever. So this producer
 * reconciles: for each org's live jobs it keeps exactly one active watch per
 * resolvable district, DEACTIVATES watches whose job is no longer live (or
 * whose address moved districts), and REACTIVATES a matching paused one rather
 * than inserting a duplicate that would collide with the partial unique index
 * `weather_watches_org_job_district`. Deactivation (not deletion) mirrors the
 * migration's own "pause without forgetting" intent for the `active` flag.
 *
 * NEVER THROWS: every failure is a field in the summary, because a cron that
 * throws reports less than a cron that returns what happened.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { reportReadFailure } from "@/lib/supabase/read-failure";
import { resolveJobAddress } from "@/lib/address";
import { districtForAddress } from "@/lib/weather/postcode";
import type { PostcodeDistrict } from "@/lib/weather/types";

/** Job statuses whose site is "live" and therefore worth watching. Completed
 * and blocked jobs are NOT: a finished job needs no forecast, and a blocked
 * (on-hold) one should stop costing provider calls — both are deactivated. */
const LIVE_JOB_STATUSES = ["new", "in-progress"] as const;

// Untyped-table access uses the established Loose idiom (see
// server/services/weather-fetch.ts and cis-deduction.ts): the weather tables
// are deliberately absent from lib/supabase/types.ts.
type LooseRes<T> = { data: T | null; error: { message: string; code?: string } | null };
type SelectBuilder<T> = PromiseLike<LooseRes<T[]>> & {
  eq: (k: string, v: unknown) => SelectBuilder<T>;
  in: (k: string, v: readonly unknown[]) => SelectBuilder<T>;
};
type UpdateBuilder = {
  in: (k: string, v: readonly unknown[]) => PromiseLike<LooseRes<null>>;
};
type LooseTable = {
  select: <T>(cols: string) => SelectBuilder<T>;
  insert: (rows: ReadonlyArray<Record<string, unknown>>) => PromiseLike<LooseRes<null>>;
  update: (values: Record<string, unknown>) => UpdateBuilder;
};
type LooseAdmin = { from: (t: string) => unknown };
const table = (c: LooseAdmin, name: string): LooseTable => c.from(name) as LooseTable;

type JobRow = {
  id: string;
  org_id: string;
  customer_id: string | null;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};

type CustomerRow = {
  id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
};

type WatchRow = {
  id: string;
  job_id: string | null;
  postcode_district: string;
  active: boolean;
};

// ---------------------------------------------------------------------------
// The PURE reconciliation. No I/O — the interesting logic, hermetically testable.
// ---------------------------------------------------------------------------

/** A live job with its district already resolved (null ⇒ no derivable postcode). */
export type JobWatchInput = {
  readonly id: string;
  readonly org_id: string;
  readonly district: PostcodeDistrict | null;
};

/** An existing job-anchored `weather_watches` row (site/standing watches excluded). */
export type ExistingJobWatch = {
  readonly id: string;
  readonly job_id: string;
  readonly postcode_district: string;
  readonly active: boolean;
};

export type WatchInsert = {
  readonly org_id: string;
  readonly job_id: string;
  readonly postcode_district: PostcodeDistrict;
};

export type WatchSyncPlan = {
  /** Brand-new watches to create, active. */
  readonly inserts: ReadonlyArray<WatchInsert>;
  /** Watch ids to flip back to active (a paused watch whose job is live again). */
  readonly activate: ReadonlyArray<string>;
  /** Watch ids to pause (job no longer live, or its address moved districts). */
  readonly deactivate: ReadonlyArray<string>;
};

const NUL = " ";
const pairKey = (jobId: string, district: string): string => `${jobId}${NUL}${district}`;

/**
 * Compute the minimal set of writes that makes the watch table match reality:
 * exactly one active watch per (live job, resolvable district), stale ones
 * paused, matching paused ones reactivated. Pure and order-independent.
 */
export function planWatchSync(
  jobs: ReadonlyArray<JobWatchInput>,
  existing: ReadonlyArray<ExistingJobWatch>,
): WatchSyncPlan {
  // What SHOULD be watched: live jobs with a resolvable district.
  const desired = new Map<string, { org_id: string; district: PostcodeDistrict }>();
  for (const j of jobs) {
    if (j.district !== null) desired.set(j.id, { org_id: j.org_id, district: j.district });
  }

  const inserts: WatchInsert[] = [];
  const activate: string[] = [];
  const deactivate: string[] = [];
  const covered = new Set<string>();

  for (const w of existing) {
    const want = desired.get(w.job_id);
    const wanted = want !== undefined && want.district === w.postcode_district;
    if (wanted) {
      covered.add(pairKey(w.job_id, w.postcode_district));
      if (!w.active) activate.push(w.id);
    } else if (w.active) {
      // Job no longer live, or its district changed under it: stop watching.
      deactivate.push(w.id);
    }
  }

  for (const [jobId, want] of desired) {
    if (!covered.has(pairKey(jobId, want.district))) {
      inserts.push({ org_id: want.org_id, job_id: jobId, postcode_district: want.district });
    }
  }

  return { inserts, activate, deactivate };
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

export type WeatherWatchSyncSummary = {
  /** False when any read or write failed loudly. */
  readonly ok: boolean;
  /** Always true here — there is no dark short-circuit; the producer is provider-independent. */
  readonly ran: boolean;
  readonly jobsConsidered: number;
  readonly districtsResolved: number;
  readonly inserted: number;
  readonly activated: number;
  readonly deactivated: number;
  readonly note: string | null;
};

/**
 * Run one reconciliation pass over every org's live jobs. Never throws.
 */
export async function runWeatherWatchSync(): Promise<WeatherWatchSyncSummary> {
  const empty = {
    ran: true as const,
    jobsConsidered: 0,
    districtsResolved: 0,
    inserted: 0,
    activated: 0,
    deactivated: 0,
  };

  const admin = createAdminClient() as unknown as LooseAdmin;

  // ── 1. The live jobs across every tenant. ─────────────────────────────────
  const jobsRes = await table(admin, "jobs")
    .select<JobRow>(
      "id, org_id, customer_id, site_address_line1, site_address_line2, " +
        "site_city, site_county, site_postcode, site_country",
    )
    .in("status", LIVE_JOB_STATUSES);
  if (jobsRes.error) {
    // LOUD READS: a failed job read must never read as "no live jobs", which
    // would deactivate every watch on the platform.
    reportReadFailure("jobs (weather watch sync)", jobsRes.error);
    return { ...empty, ok: false, note: `jobs read failed: ${jobsRes.error.message}` };
  }
  const jobs = jobsRes.data ?? [];

  // ── 2. The customers those jobs may inherit an address from. ──────────────
  const customerIds = [
    ...new Set(jobs.map((j) => j.customer_id).filter((id): id is string => id !== null)),
  ];
  const customerById = new Map<string, CustomerRow>();
  if (customerIds.length > 0) {
    const custRes = await table(admin, "customers")
      .select<CustomerRow>("id, address_line1, address_line2, city, county, postcode, country")
      .in("id", customerIds);
    if (custRes.error) {
      reportReadFailure("customers (weather watch sync)", custRes.error);
      return { ...empty, ok: false, note: `customers read failed: ${custRes.error.message}` };
    }
    for (const c of custRes.data ?? []) customerById.set(c.id, c);
  }

  // ── 3. Resolve each job's district — the site override, else the customer. ─
  const resolved: JobWatchInput[] = jobs.map((j) => {
    const customer = j.customer_id ? customerById.get(j.customer_id) ?? null : null;
    const district = districtForAddress(resolveJobAddress(j, customer));
    return { id: j.id, org_id: j.org_id, district };
  });
  const districtsResolved = resolved.filter((r) => r.district !== null).length;

  // ── 4. Existing job-anchored watches (site/standing watches are left alone). ─
  const watchRes = await table(admin, "weather_watches").select<WatchRow>(
    "id, job_id, postcode_district, active",
  );
  if (watchRes.error) {
    reportReadFailure("weather watches (watch sync)", watchRes.error);
    return { ...empty, ok: false, note: `watch read failed: ${watchRes.error.message}` };
  }
  const existing: ExistingJobWatch[] = (watchRes.data ?? [])
    .filter((w): w is WatchRow & { job_id: string } => w.job_id !== null)
    .map((w) => ({
      id: w.id,
      job_id: w.job_id,
      postcode_district: w.postcode_district,
      active: w.active,
    }));

  // ── 5. Plan and apply. ────────────────────────────────────────────────────
  const plan = planWatchSync(resolved, existing);

  let ok = true;
  let inserted = 0;
  let activated = 0;
  let deactivated = 0;

  if (plan.inserts.length > 0) {
    const rows = plan.inserts.map((i) => ({
      org_id: i.org_id,
      job_id: i.job_id,
      postcode_district: i.postcode_district,
      active: true,
    }));
    const res = await table(admin, "weather_watches").insert(rows);
    if (res.error) {
      ok = false;
      console.error("[weather-watch-sync] insert failed", { error: res.error.message });
    } else {
      inserted = rows.length;
    }
  }

  if (plan.activate.length > 0) {
    const res = await table(admin, "weather_watches")
      .update({ active: true })
      .in("id", plan.activate);
    if (res.error) {
      ok = false;
      console.error("[weather-watch-sync] reactivate failed", { error: res.error.message });
    } else {
      activated = plan.activate.length;
    }
  }

  if (plan.deactivate.length > 0) {
    const res = await table(admin, "weather_watches")
      .update({ active: false })
      .in("id", plan.deactivate);
    if (res.error) {
      ok = false;
      console.error("[weather-watch-sync] deactivate failed", { error: res.error.message });
    } else {
      deactivated = plan.deactivate.length;
    }
  }

  return {
    ok,
    ran: true,
    jobsConsidered: jobs.length,
    districtsResolved,
    inserted,
    activated,
    deactivated,
    note: null,
  };
}
