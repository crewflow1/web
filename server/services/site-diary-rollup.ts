import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { formatDayKeyUK } from "@/lib/time/format";
import { addDays, ukDayStartMs, ukDayEndMs } from "@/lib/schedule/window";
import { resolveJobAddress } from "@/lib/address";
import { districtForAddress, isPostcodeDistrict } from "@/lib/weather/postcode";
import type { PostcodeDistrict, WeatherReading, WeatherWindow } from "@/lib/weather/types";
import { summariseWindow } from "@/lib/weather/decision";
import { isWeatherAvailable, getWeatherReadiness } from "@/lib/weather/readiness";
import { weatherAttributionFor } from "@/lib/weather/index";
import { suggestWeatherText } from "@/lib/site-diary/weather";
import {
  aggregateDailyActivity,
  composeDiaryRollup,
  AUTO_ROLLUP_SOURCE,
  MANUAL_SOURCE,
  type DiaryRollupComposition,
  type RollupWeather,
} from "@/lib/site-diary/rollup";

/**
 * Automatic end-of-day Site Diary roll-up — the read/compose/write service
 * behind the `site-diary-rollup` cron.
 *
 * WHAT IT DOES. For the UK calendar day that just ended, and for each ACTIVE job
 * that had real activity that day, it composes ONE diary entry from the activity
 * already in the database — photos, snags raised/closed, goods received, and
 * time logged on site — plus a weather line when (and only when) the weather
 * provider is live. The pure grouping + wording lives in lib/site-diary/rollup.ts
 * so this module only FETCHES, resolves weather, and WRITES.
 *
 * THREE INVARIANTS, each load-bearing:
 *
 *   1. IDEMPOTENT. The write is keyed by (org_id, job_id, entry_date) via the
 *      partial unique index in 20261183000000 (`where source='auto_rollup'`).
 *      A re-run refreshes the existing auto entry in place; a concurrent double
 *      run is caught by a 23505 and treated as done. The day's set self-excludes,
 *      so a truncated pass is safe to resume — see the cron-fairness allowlist.
 *
 *   2. NEVER COLLIDES WITH A HUMAN ENTRY. If a MANUAL entry already exists for
 *      that job/day, the roll-up SKIPS entirely — it never overwrites, never
 *      duplicates the human's account, and never even sits beside it. The auto
 *      entry is marked `source='auto_rollup'`, distinct from `manual`, so the two
 *      provenances can never be confused.
 *
 *   3. TENANT-SAFE + DARK-SAFE. Runs on the service-role client (cron has no
 *      user session), so every write pins the job's authoritative `org_id`; a
 *      job_id resolves to exactly one org via its own row, so activity can never
 *      cross tenants. Weather is gated on `isWeatherAvailable()` FIRST — false on
 *      every build today — so the dark path reads no weather row and the weather
 *      line is simply absent, exactly as required.
 *
 * LOUD READS. Every gather binds its `error` and throws `readFailure` on a
 * rejected page — a partial roll-up that asserts "nothing else happened" is the
 * lie this codebase's loud-read discipline exists to prevent.
 */

type Row = Record<string, unknown>;

/** Minimal self-returning PostgREST view — none of these tables are in the generated types. */
type RollupBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => RollupBuilder;
  eq: (k: string, v: unknown) => RollupBuilder;
  gte: (k: string, v: unknown) => RollupBuilder;
  lt: (k: string, v: unknown) => RollupBuilder;
  in: (k: string, v: readonly unknown[]) => RollupBuilder;
  order: (k: string, o: { ascending: boolean }) => RollupBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};
export type RollupDb = { from: (t: string) => RollupBuilder };

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { code?: string; message: string } | null }>;
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

/** Postgres unique-violation — the concurrent-run idempotency signal. */
const UNIQUE_VIOLATION = "23505";

export type SiteDiaryRollupSummary = {
  ok: true;
  /** The UK day rolled up (YYYY-MM-DD). */
  date: string;
  /** Whether the weather provider was live for this run. */
  weather: boolean;
  jobsWithActivity: number;
  created: number;
  refreshed: number;
  skippedManual: number;
  skippedConflict: number;
};

/**
 * The UK calendar day to roll up: the day that has fully ENDED relative to `now`.
 * The cron runs in the small hours, so "yesterday" is complete — no late-evening
 * activity can still land in it. DST-safe: computed by stepping one whole
 * calendar day back from today's key, never by subtracting 24h.
 */
export function rollupTargetDate(now: Date): string {
  return addDays(formatDayKeyUK(now), -1);
}

// ── Row shapes (exactly the columns selected) ────────────────────────────────

type SnagRow = { id: string; job_id: string | null };
type ResolvedSnagRow = { id: string; job_id: string | null };
type LabourRow = {
  id: string;
  job_id: string | null;
  user_id: string;
  started_at: string;
  ended_at: string | null;
};
type GrnRow = { id: string; purchase_order_id: string; number: string; delivery_note_reference: string | null };
type PoRow = { id: string; job_id: string | null };
type PhotoRow = { id: string; target_id: string; mime_type: string | null };
type JobRow = {
  id: string;
  org_id: string;
  status: string;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
  customer: {
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    county: string | null;
    postcode: string | null;
    country: string | null;
  } | null;
};

/** Statuses that mean a job is still worth a diary. A completed job gets none. */
const ACTIVE_JOB_STATUSES = ["new", "in-progress", "blocked"] as const;

/**
 * Page a read to completion, binding + throwing on a rejected page (LOUD). All
 * high-value tables (snags, time_entries, goods_received_notes, purchase_orders,
 * jobs) are read this way so PostgREST's 1000-row clamp can never truncate a
 * day's activity into a partial, falsely-complete roll-up (F-1).
 */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<PageResult<Row>>,
  context: string,
): Promise<T[]> {
  const { data, error } = await fetchAllRows<Row>(build);
  if (error) throw readFailure(`site-diary-rollup: ${context}`, error as SupabaseReadError);
  return (data ?? []) as unknown as T[];
}

/**
 * Read a day's weather suggestion for one district, or null.
 *
 * DARK-FIRST: the caller gates the WHOLE weather pass on `isWeatherAvailable()`
 * before this runs, so on every build today it is never reached and no
 * weather_readings row is touched. When a provider is live, this reads the
 * shared district cache (no org_id — weather_readings is a cross-tenant cache
 * keyed by outward code, with a PII-safe district CHECK) for the day's window,
 * paged, and reduces it to a single honest phrase. Any read failure degrades to
 * null — a missing suggestion costs the weather line, never the roll-up.
 */
async function weatherForDistrict(
  db: RollupDb,
  district: PostcodeDistrict,
  date: string,
  attribution: string | null,
): Promise<RollupWeather | null> {
  const from = ukDayStartMs(date);
  const to = ukDayEndMs(date);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  let rows: WeatherRow[];
  try {
    rows = await pageAll<WeatherRow>(
      (f, t) =>
        db
          .from("weather_readings")
          .select(
            "id, postcode_district, kind, valid_at, air_temp_c, wind_speed_ms, " +
              "wind_gust_ms, precip_rate_mm_h, precip_total_mm, precip_prob_pct, " +
              "humidity_pct, visibility_m",
          )
          .eq("postcode_district", district)
          .gte("valid_at", new Date(from).toISOString())
          .lt("valid_at", new Date(to).toISOString())
          .order("valid_at", { ascending: true })
          .order("id", { ascending: true })
          .range(f, t),
      "weather readings",
    );
  } catch {
    return null; // a weather blip must never fail the whole run
  }

  const readings = rows.map(toReading).filter((r): r is WeatherReading => r !== null);
  if (readings.length === 0) return null;
  const window: WeatherWindow = { district, readings };
  const { summary, coverage } = summariseWindow(window);
  const text = suggestWeatherText(summary, coverage);
  if (text === null) return null;
  return { text, attribution };
}

type WeatherRow = {
  postcode_district: string;
  kind: string;
  valid_at: string;
  air_temp_c: number | null;
  wind_speed_ms: number | null;
  wind_gust_ms: number | null;
  precip_rate_mm_h: number | null;
  precip_total_mm: number | null;
  precip_prob_pct: number | null;
  humidity_pct: number | null;
  visibility_m: number | null;
};

const num = (v: number | null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Map a weather_readings row to a decision-layer reading (mirrors server/services/weather.ts). */
function toReading(row: WeatherRow): WeatherReading | null {
  const district = row.postcode_district;
  if (!isPostcodeDistrict(district)) return null;
  if (row.kind !== "forecast" && row.kind !== "observation") return null;
  const validAt = new Date(row.valid_at);
  if (Number.isNaN(validAt.getTime())) return null;
  return {
    district,
    kind: row.kind,
    validAt,
    airTempC: num(row.air_temp_c),
    windSpeedMs: num(row.wind_speed_ms),
    windGustMs: num(row.wind_gust_ms),
    precipRateMmH: num(row.precip_rate_mm_h),
    precipTotalMm: num(row.precip_total_mm),
    precipProbPct: num(row.precip_prob_pct),
    humidityPct: num(row.humidity_pct),
    visibilityM: num(row.visibility_m),
  };
}

/**
 * Compose and persist auto roll-ups for the day that just ended.
 *
 * `db` is injectable so a test can drive the exact query shapes; production
 * passes the service-role client. `now` is injectable so the target day is
 * reproducible.
 */
export async function runSiteDiaryRollup(options?: {
  db?: RollupDb;
  now?: Date;
}): Promise<SiteDiaryRollupSummary> {
  const now = options?.now ?? new Date();
  const date = rollupTargetDate(now);
  const db = options?.db ?? (createAdminClient() as unknown as RollupDb);

  const dayStart = ukDayStartMs(date);
  const dayEnd = ukDayEndMs(date);
  const startIso = new Date(dayStart).toISOString();
  const endIso = new Date(dayEnd).toISOString();

  // ── Gather the day's activity (each read paged + loud) ──────────────────────
  const [snagsRaised, snagsResolved, labour, grns, photosRaw] = await Promise.all([
    pageAll<SnagRow>(
      (f, t) =>
        db
          .from("snags")
          .select("id, job_id")
          .gte("created_at", startIso)
          .lt("created_at", endIso)
          .order("id", { ascending: true })
          .range(f, t),
      "snags raised",
    ),
    pageAll<ResolvedSnagRow>(
      (f, t) =>
        db
          .from("snags")
          .select("id, job_id")
          .gte("resolved_at", startIso)
          .lt("resolved_at", endIso)
          .order("id", { ascending: true })
          .range(f, t),
      "snags resolved",
    ),
    pageAll<LabourRow>(
      (f, t) =>
        db
          .from("time_entries")
          .select("id, job_id, user_id, started_at, ended_at")
          .gte("started_at", startIso)
          .lt("started_at", endIso)
          .order("id", { ascending: true })
          .range(f, t),
      "time entries",
    ),
    pageAll<GrnRow>(
      (f, t) =>
        db
          .from("goods_received_notes")
          .select("id, purchase_order_id, number, delivery_note_reference")
          .eq("status", "posted")
          .eq("delivery_date", date)
          .order("id", { ascending: true })
          .range(f, t),
      "goods received notes",
    ),
    pageAll<PhotoRow>(
      (f, t) =>
        db
          .from("tenant_attachments")
          .select("id, target_id, mime_type")
          .eq("target_table", "jobs")
          .gte("created_at", startIso)
          .lt("created_at", endIso)
          .order("id", { ascending: true })
          .range(f, t),
      "job attachments",
    ),
  ]);

  // A GRN reaches a job only through its purchase order — resolve that link.
  const poIds = [...new Set(grns.map((g) => g.purchase_order_id).filter(Boolean))];
  const purchaseOrders =
    poIds.length === 0
      ? []
      : await pageAll<PoRow>(
          (f, t) =>
            db
              .from("purchase_orders")
              .select("id, job_id")
              .in("id", poIds)
              .order("id", { ascending: true })
              .range(f, t),
          "purchase orders",
        );
  const poToJob = new Map(purchaseOrders.map((p) => [p.id, p.job_id]));

  // Only IMAGE attachments count as photos; the job id is the attachment target.
  const photos = photosRaw
    .filter((p) => typeof p.mime_type === "string" && p.mime_type.toLowerCase().startsWith("image/"))
    .map((p) => ({ job_id: p.target_id }));

  const deliveries = grns.map((g) => ({
    job_id: poToJob.get(g.purchase_order_id) ?? null,
    reference: (g.delivery_note_reference && g.delivery_note_reference.trim()) || g.number,
  }));

  // ── Resolve the candidate jobs and keep only the ACTIVE ones ────────────────
  const candidateJobIds = [
    ...new Set(
      [
        ...snagsRaised.map((s) => s.job_id),
        ...snagsResolved.map((s) => s.job_id),
        ...labour.map((l) => l.job_id),
        ...deliveries.map((d) => d.job_id),
        ...photos.map((p) => p.job_id),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  if (candidateJobIds.length === 0) {
    return summaryOf(date, isWeatherAvailable(), 0, 0, 0, 0, 0);
  }

  const jobs = await pageAll<JobRow>(
    (f, t) =>
      db
        .from("jobs")
        .select(
          "id, org_id, status, site_address_line1, site_address_line2, site_city, " +
            "site_county, site_postcode, site_country, " +
            "customer:customers ( address_line1, address_line2, city, county, postcode, country )",
        )
        .in("id", candidateJobIds)
        .order("id", { ascending: true })
        .range(f, t),
    "jobs",
  );

  const activeJobs = new Map<string, JobRow>();
  for (const j of jobs) {
    if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status)) activeJobs.set(j.id, j);
  }
  const activeJobIds = new Set(activeJobs.keys());

  const perJob = aggregateDailyActivity({
    activeJobIds,
    snagsRaised: snagsRaised.map((s) => ({ job_id: s.job_id })),
    snagsResolved: snagsResolved.map((s) => ({ job_id: s.job_id })),
    labour: labour.map((l) => ({
      job_id: l.job_id,
      user_id: l.user_id,
      started_at: l.started_at,
      ended_at: l.ended_at,
    })),
    deliveries,
    photos,
  });

  // ── Weather (dark-gated once for the whole run) ─────────────────────────────
  const weatherOn = isWeatherAvailable();
  const attribution = weatherOn ? weatherAttributionFor(getWeatherReadiness().provider) : null;
  const weatherByDistrict = new Map<string, RollupWeather | null>();

  let created = 0;
  let refreshed = 0;
  let skippedManual = 0;
  let skippedConflict = 0;

  for (const [jobId, facts] of perJob) {
    const job = activeJobs.get(jobId);
    if (!job) continue; // aggregate already restricts to active, but stay defensive
    const orgId = job.org_id;

    let weather: RollupWeather | null = null;
    if (weatherOn) {
      const district = districtForAddress(resolveJobAddress(job, job.customer));
      if (district !== null) {
        if (!weatherByDistrict.has(district)) {
          weatherByDistrict.set(district, await weatherForDistrict(db, district, date, attribution));
        }
        weather = weatherByDistrict.get(district) ?? null;
      }
    }

    const composition = composeDiaryRollup(facts, { date, weather });
    if (!composition) continue;

    const outcome = await upsertRollup(db, orgId, jobId, date, composition);
    if (outcome === "created") created++;
    else if (outcome === "refreshed") refreshed++;
    else if (outcome === "manual") skippedManual++;
    else if (outcome === "conflict") skippedConflict++;
  }

  return summaryOf(date, weatherOn, perJob.size, created, refreshed, skippedManual, skippedConflict);
}

function summaryOf(
  date: string,
  weather: boolean,
  jobsWithActivity: number,
  created: number,
  refreshed: number,
  skippedManual: number,
  skippedConflict: number,
): SiteDiaryRollupSummary {
  return {
    ok: true,
    date,
    weather,
    jobsWithActivity,
    created,
    refreshed,
    skippedManual,
    skippedConflict,
  };
}

type UpsertOutcome = "created" | "refreshed" | "manual" | "conflict";

type ExistingRow = { id: string; source: string };

/**
 * Idempotent, human-respecting write of ONE auto entry.
 *
 *   - a MANUAL entry for the day exists  → skip ("manual"), never touch it;
 *   - an AUTO entry exists               → refresh it in place ("refreshed");
 *   - neither                            → insert ("created"), and a concurrent
 *                                          double-insert surfaces as 23505 which
 *                                          we treat as done ("conflict").
 */
async function upsertRollup(
  db: RollupDb,
  orgId: string,
  jobId: string,
  date: string,
  composition: DiaryRollupComposition,
): Promise<UpsertOutcome> {
  const existing = await pageAll<ExistingRow>(
    (f, t) =>
      db
        .from("site_diary_entries")
        .select("id, source")
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .eq("entry_date", date)
        .order("id", { ascending: true })
        .range(f, t),
    "existing diary entries",
  );

  if (existing.some((e) => e.source === MANUAL_SOURCE)) return "manual";
  const auto = existing.find((e) => e.source === AUTO_ROLLUP_SOURCE);

  const fields = {
    weather: composition.weather,
    labour_count: composition.labour_count,
    work_summary: composition.work_summary,
    notes: composition.notes,
  };

  if (auto) {
    const { error, count } = await (
      db.from("site_diary_entries" as never) as unknown as UpdateChain
    )
      .update(fields, { count: "exact" })
      .eq("id", auto.id)
      .eq("org_id", orgId);
    if (error) throw readFailure("site-diary-rollup: refresh auto entry", error as SupabaseReadError);
    // count 0 ⇒ the row vanished between read and write; nothing to refresh.
    return count && count > 0 ? "refreshed" : "conflict";
  }

  const { error } = await (
    db.from("site_diary_entries" as never) as unknown as InsertChain
  ).insert({
    org_id: orgId,
    job_id: jobId,
    entry_date: date,
    source: AUTO_ROLLUP_SOURCE,
    ...fields,
  });
  if (error) {
    // The partial unique index (org_id, job_id, entry_date where source=auto_rollup)
    // is the real idempotency guard; a 23505 means a concurrent pass won the race.
    if (error.code === UNIQUE_VIOLATION) return "conflict";
    throw readFailure("site-diary-rollup: insert auto entry", error as SupabaseReadError);
  }
  return "created";
}
