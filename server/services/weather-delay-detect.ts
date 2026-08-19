import "server-only";
import { createHash } from "node:crypto";

/**
 * Weather intelligence — AUTOMATIC weather → stoppage → delay-event detection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CLOSES — the last link of the chain
 * ═══════════════════════════════════════════════════════════════════════════
 * The manual lane already runs end to end: a human records a delay
 * (delay_events, 20261084) and the EOT pack / notice turn RECORDED weather
 * events into evidence, back-filling the observed readings from
 * weather_readings via buildWeatherSnapshot (server/services/eot-pack.ts). What
 * was missing is the FRONT of the chain: nothing turned "it actually froze /
 * blew a gale on site yesterday" into a delay event by itself. This service is
 * that producer. For the UK calendar day that just ended, for each live job
 * with a resolvable site district, it reads the day's OBSERVATIONS from the
 * global cache, runs the EXISTING pure decision layer (lib/weather/decision +
 * thresholds), and — when the layer returns a DEFINITIVE `not_viable` for at
 * least one activity — raises a DRAFT weather delay event linked to the
 * district it was derived from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAFT ONLY — the machine SURFACES a candidate; a human RECORDS it
 * ═══════════════════════════════════════════════════════════════════════════
 * Every row this writes is born `draft`, and the guard trigger
 * (tg_delay_event_guard, 20261084) enforces that for the service role too. A
 * draft carries NO evidential weight (the migration says so); it is a prompt.
 * The human reviewer, who knows the job's actual trade, either promotes it to
 * `recorded` (at which point the transition trigger pins THEIR provenance —
 * recorded_by/at — so the evidence is vouched for by a person, never by this
 * cron) or withdraws/deletes it. `working_days_lost` is left NULL and never
 * computed — deriving working time from a calendar day would put false
 * precision into evidence (20261084 header). `created_by` is NULL: no human
 * authored it, and the guard only checks membership when created_by is set.
 * The description states, in words, that it is machine-detected and awaiting
 * review, so the provenance can never be mistaken for a hand-written account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DARK-DEGRADATION — the whole point, achieved TWO ways
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. READINESS GATE FIRST. `runWeatherDelayDetection` checks
 *      `getWeatherReadiness().available` before it constructs a client or reads
 *      a row, exactly like buildWeatherSnapshot and runWeatherFetch. On every
 *      environment today (no OPEN_METEO_API_KEY) that is false, so the pass
 *      returns `{ ran: false }` having read nothing, written nothing, deleted
 *      nothing. The cron route repeats the gate before telemetry, so a dark
 *      tick is a pure 204 with zero DB access.
 *   2. THE DECISION LAYER'S OWN INVARIANT. Even if it ran, an empty window
 *      (which is EVERY window while the cache is dark) makes `assessWorkability`
 *      return `unknown` for every work type — NEVER `not_viable` — so the
 *      planner produces zero detections from no data. "No readings" can never
 *      manufacture a stoppage. This is belt-and-suspenders: the gate means we
 *      never even look; the invariant means that even if we did, nothing false
 *      would be written.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENT, AND IT NEVER TOUCHES A MANUAL DELAY
 * ═══════════════════════════════════════════════════════════════════════════
 * Before raising anything for (job, day) the pass reads every EXISTING weather
 * delay for the candidate jobs on that day — ANY status, ANY provenance — and
 * skips a job that already has one. That single check does three jobs at once:
 *   • idempotency: a re-run finds the draft it wrote last time and skips it;
 *   • manual respect: a human's weather delay for that day suppresses the auto
 *     one — the two never sit side by side;
 *   • withdrawal respect: a WITHDRAWN weather delay for that day (a human said
 *     "no, work didn't stop") keeps the cron from re-raising it every night.
 * A deterministic `client_write_key` (a UUIDv5 of the job+day+marker) is a
 * second, DB-level backstop: the existing partial unique index
 * `delay_events_client_write_key_uidx (org_id, client_write_key)` (20261101)
 * turns a concurrent double auto-insert into a 23505 we treat as done. NO
 * migration is needed — the dedupe rides the natural key plus that existing
 * index.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SERVICE ROLE, TENANT-SAFE, NO EGRESS
 * ═══════════════════════════════════════════════════════════════════════════
 * Runs as an internal cron over every org (createAdminClient), like the fetch
 * pipeline and the diary roll-up. Org scoping survives WITHOUT RLS: every write
 * pins the job's authoritative org_id (read from the job row), and the delay's
 * composite FK (job_id, org_id) → jobs makes a cross-tenant delay
 * unrepresentable for the service role too. It reads the weather CACHE directly
 * (the site-diary-rollup precedent — a cron uses the admin client, not the
 * tenant accessor buildWeatherSnapshot, which is RLS-scoped and needs a user
 * session); it NEVER calls a weather provider — no vendor is bound and none is
 * needed, because a stoppage is decided from cached observations. Every read is
 * paged (fetchAllRows) and LOUD (reportReadFailure): a truncated or failed read
 * must never read as "nothing stopped work".
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { resolveJobAddress } from "@/lib/address";
import { addDays } from "@/lib/schedule/window";
import { formatDayKeyUK } from "@/lib/time/format";
import { ukDayStartMs, ukDayEndMs } from "@/lib/schedule/window";
import {
  assessAll,
  districtForAddress,
  getWeatherReadiness,
  isPostcodeDistrict,
  isWeatherAvailable,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  type PostcodeDistrict,
  type WeatherReading,
  type WeatherWindow,
  type WorkabilityAssessment,
  type WorkType,
} from "@/lib/weather";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Job statuses whose site is worth assessing — the LIVE set the watch producer
 * keeps warm (server/services/weather-watch-sync.ts). A completed job needs no
 * forecast, and a blocked (on-hold) one has no work to stop; both are excluded,
 * and their districts are not watched either, so no reading would exist. */
const LIVE_JOB_STATUSES = ["new", "in-progress"] as const;

/** How far back the antecedent-rainfall lookback runs, for the groundworks
 * saturation rules. Observations BEFORE the day are summed into
 * `antecedentPrecipMm`; without them those rules stay `unknown` (never assumed
 * dry). 48 h matches the cache's observation lookback horizon. */
const ANTECEDENT_WINDOW_HOURS = 48;

/** Chunk size for `.in()` id lists — the request-line-safe idiom used across the
 * weather crons (a wide `.in()` serialises every id into the GET query string
 * and 414s). Each chunk is still paged. */
const IN_CHUNK = 200;

/** A recorded description must be 1..4000 chars (delay_events CHECK). We compose
 * well under this; the cap is a defensive trim so a pathological breach list can
 * never make the insert violate the CHECK. */
const DESCRIPTION_MAX = 4000;

/** UUID namespace for the deterministic auto-delay idempotency key. A fixed,
 * arbitrary constant so the same (job, day) always hashes to the same UUID on
 * every machine. */
const AUTO_DELAY_KEY_NAMESPACE = "crewflow.weather-delay-detect.v1";

/** Postgres unique-violation — the deterministic-key idempotency signal. */
const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Untyped-table access — the established Loose idiom (weather tables and
// delay_events are deliberately absent from lib/supabase/types.ts).
// ---------------------------------------------------------------------------

type LooseRes<T> = { data: T | null; error: { message: string; code?: string } | null };
type SelectBuilder<T> = PromiseLike<LooseRes<T[]>> & {
  eq: (k: string, v: unknown) => SelectBuilder<T>;
  in: (k: string, v: readonly unknown[]) => SelectBuilder<T>;
  gte: (k: string, v: unknown) => SelectBuilder<T>;
  lt: (k: string, v: unknown) => SelectBuilder<T>;
  order: (k: string, o: { ascending: boolean }) => SelectBuilder<T>;
  range: (from: number, to: number) => PromiseLike<PageResult<T>>;
};
type LooseTable<T> = {
  select: (cols: string) => SelectBuilder<T>;
  insert: (row: Record<string, unknown>) => PromiseLike<LooseRes<null>>;
};
type LooseAdmin = { from: (t: string) => unknown };
const table = <T>(c: LooseAdmin, name: string): LooseTable<T> =>
  c.from(name) as unknown as LooseTable<T>;

type JobRow = {
  id: string;
  org_id: string;
  status: string;
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

type ExistingDelayRow = { job_id: string | null };

type ReadingRow = {
  postcode_district: string;
  kind: string;
  valid_at: string;
  air_temp_c: number | string | null;
  wind_speed_ms: number | string | null;
  wind_gust_ms: number | string | null;
  precip_rate_mm_h: number | string | null;
  precip_total_mm: number | string | null;
  precip_prob_pct: number | null;
  humidity_pct: number | null;
  visibility_m: number | null;
};

/** Postgres `numeric` arrives as a STRING over PostgREST; coerce at the boundary
 * (mirrors server/services/weather.ts::num). */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a weather_readings row to a decision-layer reading (mirrors the reader). */
function toReading(row: ReadingRow): WeatherReading | null {
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
    precipProbPct: row.precip_prob_pct,
    humidityPct: row.humidity_pct,
    visibilityM: row.visibility_m,
  };
}

// ---------------------------------------------------------------------------
// PURE core — the interesting logic, hermetically testable.
// ---------------------------------------------------------------------------

/**
 * The UK calendar day to assess: the day that has fully ENDED relative to `now`.
 * The cron runs in the small hours, so "yesterday" is complete and its
 * observations are a record of fact, not a prediction. DST-safe (steps one whole
 * calendar day back from today's key). Mirrors site-diary-rollup's
 * `rollupTargetDate`.
 */
export function detectionTargetDate(now: Date): string {
  return addDays(formatDayKeyUK(now), -1);
}

/**
 * A DETERMINISTIC uuid identifying one auto-raised weather delay for a (job,
 * day). Same construction as automation-schedules `occurrenceId`: SHA-1 over a
 * stable seed, formatted as a UUIDv5. Same (job, day) → same key on every
 * machine, so a concurrent double insert collides on the partial unique index
 * `delay_events_client_write_key_uidx (org_id, client_write_key)` and produces
 * exactly one row.
 */
export function weatherAutoDelayKey(jobId: string, date: string): string {
  const bytes = createHash("sha1")
    .update(`${AUTO_DELAY_KEY_NAMESPACE}:${jobId}:${date}`)
    .digest();
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A job with its site district already resolved (null ⇒ no derivable postcode). */
export type JobDetectionInput = {
  readonly id: string;
  readonly org_id: string;
  readonly district: PostcodeDistrict | null;
};

/** What a stoppage detection carries into the write. */
export type WeatherDelayDetection = {
  readonly orgId: string;
  readonly jobId: string;
  readonly district: PostcodeDistrict;
  readonly date: string;
  /** The work types the decision layer returned `not_viable` for. Never empty. */
  readonly blockedWorkTypes: ReadonlyArray<WorkType>;
  /** The composed, human-readable, machine-provenanced draft description. */
  readonly description: string;
};

/**
 * Round to at most one decimal for display in the description (the SI value the
 * threshold is compared against; the rule text already carries the human units).
 */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Assess a window and return the work types that came back `not_viable` — the
 * DEFINITIVE stoppages (a blocking breach on real observed data). `unknown`
 * (missing data — including EVERY empty, dark window) and `caution` never count:
 * only a proven blocking breach raises a delay. This is what makes the whole
 * feature dark-degrading with no special-casing — an empty window yields no
 * blocked work types at all.
 */
export function detectStoppage(window: WeatherWindow): {
  readonly assessments: ReadonlyArray<WorkabilityAssessment>;
  readonly blocked: ReadonlyArray<WorkabilityAssessment>;
} {
  const assessments = assessAll(window, WORK_TYPES);
  const blocked = assessments.filter((a) => a.verdict === "not_viable");
  return { assessments, blocked };
}

/**
 * Compose the draft description from the blocking breaches. Honest and
 * machine-provenanced: it names the district, the day, every activity assessed
 * unworkable with the leading blocking rule and the observed figure, and states
 * plainly that it is an auto-detected draft for review. Trimmed to the CHECK's
 * 4000-char ceiling.
 */
export function composeDelayDescription(input: {
  readonly district: PostcodeDistrict;
  readonly date: string;
  readonly blocked: ReadonlyArray<WorkabilityAssessment>;
}): string {
  const lines: string[] = [];
  lines.push(
    `Automatic weather detection — work-stoppage conditions were observed in postcode ` +
      `district ${input.district} on ${input.date}.`,
  );
  lines.push("");
  lines.push("Activities assessed as NOT VIABLE from cached weather observations:");
  for (const a of input.blocked) {
    const lead = a.breaches.find((b) => b.severity === "blocking") ?? a.breaches[0];
    const label = WORK_TYPE_LABELS[a.workType];
    if (lead) {
      const observed =
        lead.observed !== null ? ` (observed ${fmt(lead.observed)} ${lead.unit})` : "";
      lines.push(`- ${label}: ${lead.rule}${observed}`);
    } else {
      lines.push(`- ${label}: ${a.headline}`);
    }
  }
  lines.push("");
  lines.push(
    "This is a DRAFT raised automatically for review — it carries no evidential weight " +
      "until a person records it. Confirm the trade actually affected on this job and " +
      "record the delay, or withdraw it. Working days lost is not computed: it must be " +
      "assessed by a competent person against the site's working calendar. Advisory only " +
      "— this does not discharge any duty under CDM 2015, the Work at Height Regulations " +
      "2005 or LOLER 1998.",
  );
  const text = lines.join("\n");
  return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX) : text;
}

/**
 * The PURE planner: given the resolved jobs, the per-district windows and the
 * set of jobs that ALREADY have a weather delay on the day, compute exactly the
 * draft delays to raise. No I/O, order-independent, fully testable.
 *
 * A job is skipped when it has no resolvable district (nothing to assess), when
 * it already has a weather delay for the day (idempotency + manual/withdrawal
 * respect), or when the decision layer returns no `not_viable` verdict (no
 * proven stoppage — the dark/empty-window case included).
 */
export function planWeatherDelayDetections(input: {
  readonly date: string;
  readonly jobs: ReadonlyArray<JobDetectionInput>;
  readonly windowByDistrict: ReadonlyMap<string, WeatherWindow>;
  readonly jobsWithExistingWeatherDelay: ReadonlySet<string>;
}): ReadonlyArray<WeatherDelayDetection> {
  const out: WeatherDelayDetection[] = [];
  for (const job of input.jobs) {
    if (job.district === null) continue;
    if (input.jobsWithExistingWeatherDelay.has(job.id)) continue;

    const window: WeatherWindow =
      input.windowByDistrict.get(job.district) ??
      // No cached readings for this district ⇒ an empty window, which the
      // decision layer answers `unknown` to, so it raises nothing. Explicit so
      // the assessment always runs against a real window shape.
      { district: job.district, readings: [], antecedentPrecipMm: null, antecedentWindowHours: null };

    const { blocked } = detectStoppage(window);
    if (blocked.length === 0) continue;

    out.push({
      orgId: job.org_id,
      jobId: job.id,
      district: job.district,
      date: input.date,
      blockedWorkTypes: blocked.map((a) => a.workType),
      description: composeDelayDescription({ district: job.district, date: input.date, blocked }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

export type WeatherDelayDetectSummary = {
  /** False when any read or write failed loudly. */
  readonly ok: boolean;
  /** False when the dark short-circuit returned before any work. */
  readonly ran: boolean;
  /** The UK day assessed (YYYY-MM-DD), or null on the dark path. */
  readonly date: string | null;
  readonly jobsConsidered: number;
  readonly districtsResolved: number;
  /** Jobs skipped because a weather delay already existed for the day. */
  readonly skippedExisting: number;
  /** Detections the planner produced (a stoppage was proven). */
  readonly detected: number;
  /** Draft delays actually inserted. */
  readonly created: number;
  /** Inserts that collided with the deterministic key (concurrent/idempotent). */
  readonly deduped: number;
  readonly note: string | null;
};

const emptySummary = (
  extra: Partial<WeatherDelayDetectSummary> & { ok: boolean; ran: boolean; note: string | null },
): WeatherDelayDetectSummary => ({
  date: null,
  jobsConsidered: 0,
  districtsResolved: 0,
  skippedExisting: 0,
  detected: 0,
  created: 0,
  deduped: 0,
  ...extra,
});

export type WeatherDelayDetectOptions = {
  /** Injected clock — deterministic target day in tests. */
  readonly now?: Date;
  /** Injected admin client — tests drive the exact query shapes. */
  readonly db?: LooseAdmin;
};

/**
 * Run one detection pass over the day that just ended. NEVER THROWS: every
 * failure is a field in the summary (the weather-cron posture), because a cron
 * that throws reports less than a cron that returns what happened.
 */
export async function runWeatherDelayDetection(
  options: WeatherDelayDetectOptions = {},
): Promise<WeatherDelayDetectSummary> {
  // ── THE DARK SHORT-CIRCUIT. Before any client, any read, any write. ────────
  if (!isWeatherAvailable()) {
    return emptySummary({
      ok: true,
      ran: false,
      note: "weather is not available in this environment — nothing detected, nothing read",
    });
  }

  const now = options.now ?? new Date();
  const date = detectionTargetDate(now);
  const admin = options.db ?? (createAdminClient() as unknown as LooseAdmin);

  const dayStart = ukDayStartMs(date);
  const dayEnd = ukDayEndMs(date);
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) {
    return emptySummary({ ok: false, ran: true, date, note: `unusable target day ${date}` });
  }
  const antecedentStart = dayStart - ANTECEDENT_WINDOW_HOURS * 60 * 60 * 1000;

  // ── 1. Live jobs across every tenant (paged, LOUD). ────────────────────────
  const jobsRes = await fetchAllRows<JobRow>((from, to) =>
    table<JobRow>(admin, "jobs")
      .select(
        "id, org_id, status, customer_id, site_address_line1, site_address_line2, " +
          "site_city, site_county, site_postcode, site_country",
      )
      .in("status", LIVE_JOB_STATUSES)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (jobsRes.error) {
    const err = jobsRes.error as SupabaseReadError;
    reportReadFailure("jobs (weather delay detect)", err);
    return emptySummary({ ok: false, ran: true, date, note: `jobs read failed: ${err.message ?? "unknown"}` });
  }
  const jobs = jobsRes.data;
  if (jobs.length === 0) {
    return emptySummary({ ok: true, ran: true, date, note: "no live jobs — nothing to assess" });
  }

  // ── 2. Customers those jobs inherit an address from (chunked + paged). ─────
  const customerIds = [
    ...new Set(jobs.map((j) => j.customer_id).filter((id): id is string => id !== null)),
  ];
  const customerById = new Map<string, CustomerRow>();
  for (let i = 0; i < customerIds.length; i += IN_CHUNK) {
    const batch = customerIds.slice(i, i + IN_CHUNK);
    const custRes = await fetchAllRows<CustomerRow>((from, to) =>
      table<CustomerRow>(admin, "customers")
        .select("id, address_line1, address_line2, city, county, postcode, country")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (custRes.error) {
      const err = custRes.error as SupabaseReadError;
      reportReadFailure("customers (weather delay detect)", err);
      return emptySummary({ ok: false, ran: true, date, note: `customers read failed: ${err.message ?? "unknown"}` });
    }
    for (const c of custRes.data) customerById.set(c.id, c);
  }

  // ── 3. Resolve each job's district (site override else customer). ──────────
  const resolved: JobDetectionInput[] = jobs.map((j) => {
    const customer = j.customer_id ? customerById.get(j.customer_id) ?? null : null;
    const district = districtForAddress(resolveJobAddress(j, customer));
    return { id: j.id, org_id: j.org_id, district };
  });
  const jobsWithDistrict = resolved.filter(
    (r): r is JobDetectionInput & { district: PostcodeDistrict } => r.district !== null,
  );
  const districtsResolved = jobsWithDistrict.length;

  if (jobsWithDistrict.length === 0) {
    return emptySummary({
      ok: true,
      ran: true,
      date,
      jobsConsidered: jobs.length,
      note: "no live job resolved to a postcode district",
    });
  }

  // ── 4. Existing weather delays for these jobs on this day (paged, LOUD). ────
  // ANY status, ANY provenance — a manual, a prior auto, or a WITHDRAWN weather
  // delay all suppress a (re-)raise. This is the whole idempotency + manual +
  // withdrawal contract in one read.
  const candidateJobIds = jobsWithDistrict.map((j) => j.id);
  const jobsWithExistingWeatherDelay = new Set<string>();
  for (let i = 0; i < candidateJobIds.length; i += IN_CHUNK) {
    const batch = candidateJobIds.slice(i, i + IN_CHUNK);
    const existRes = await fetchAllRows<ExistingDelayRow>((from, to) =>
      table<ExistingDelayRow>(admin, "delay_events")
        .select("job_id")
        .eq("category", "weather")
        .eq("started_on", date)
        .in("job_id", batch)
        .order("job_id", { ascending: true })
        .range(from, to),
    );
    if (existRes.error) {
      // LOUD + FAIL CLOSED: a failed existence read must never read as "no delay
      // exists" and let the cron double-raise or overwrite a human's record.
      const err = existRes.error as SupabaseReadError;
      reportReadFailure("existing weather delays (weather delay detect)", err);
      return emptySummary({
        ok: false,
        ran: true,
        date,
        jobsConsidered: jobs.length,
        districtsResolved,
        note: `existing-delay read failed: ${err.message ?? "unknown"}`,
      });
    }
    for (const r of existRes.data) if (r.job_id) jobsWithExistingWeatherDelay.add(r.job_id);
  }

  // ── 5. The day's observations per district (one read per district). ────────
  const districts = [...new Set(jobsWithDistrict.map((j) => j.district))];
  const windowByDistrict = new Map<string, WeatherWindow>();
  for (const district of districts) {
    const readRes = await fetchAllRows<ReadingRow>((from, to) =>
      table<ReadingRow>(admin, "weather_readings")
        .select(
          "postcode_district, kind, valid_at, air_temp_c, wind_speed_ms, wind_gust_ms, " +
            "precip_rate_mm_h, precip_total_mm, precip_prob_pct, humidity_pct, visibility_m",
        )
        .eq("postcode_district", district)
        .eq("kind", "observation")
        .gte("valid_at", new Date(antecedentStart).toISOString())
        .lt("valid_at", new Date(dayEnd).toISOString())
        .order("valid_at", { ascending: true })
        .range(from, to),
    );
    if (readRes.error) {
      // LOUD + FAIL CLOSED: a partial reading set could under-report the day and
      // MISS a stoppage — an empty forecast masquerading as fair weather is the
      // exact class the loud-read rule exists to stop.
      const err = readRes.error as SupabaseReadError;
      reportReadFailure("weather readings (weather delay detect)", err);
      return emptySummary({
        ok: false,
        ran: true,
        date,
        jobsConsidered: jobs.length,
        districtsResolved,
        note: `readings read failed for ${district}: ${err.message ?? "unknown"}`,
      });
    }

    const all = readRes.data.map(toReading).filter((r): r is WeatherReading => r !== null);
    // The decision window is the DAY's observations; earlier ones feed antecedent
    // rainfall (ground-saturation rules) rather than the day's verdict.
    const dayReadings = all.filter((r) => r.validAt.getTime() >= dayStart);
    const antecedentReadings = all.filter((r) => r.validAt.getTime() < dayStart);
    const antecedentPrecipMm = antecedentReadings.reduce((sum, r) => {
      const mm = typeof r.precipTotalMm === "number" && Number.isFinite(r.precipTotalMm) ? r.precipTotalMm : 0;
      return sum + mm;
    }, 0);
    windowByDistrict.set(district, {
      district: district as PostcodeDistrict,
      readings: dayReadings,
      // Only claim antecedent rainfall when we actually have earlier readings —
      // else null (unknown), never assumed dry.
      antecedentPrecipMm: antecedentReadings.length > 0 ? antecedentPrecipMm : null,
      antecedentWindowHours: antecedentReadings.length > 0 ? ANTECEDENT_WINDOW_HOURS : null,
    });
  }

  // ── 6. Plan (pure) then write the drafts. ──────────────────────────────────
  const detections = planWeatherDelayDetections({
    date,
    jobs: jobsWithDistrict,
    windowByDistrict,
    jobsWithExistingWeatherDelay,
  });
  const skippedExisting = jobsWithDistrict.filter((j) =>
    jobsWithExistingWeatherDelay.has(j.id),
  ).length;

  let ok = true;
  let created = 0;
  let deduped = 0;

  for (const d of detections) {
    const clientKey = weatherAutoDelayKey(d.jobId, d.date);
    const { error } = await table<null>(admin, "delay_events").insert({
      org_id: d.orgId,
      job_id: d.jobId,
      category: "weather",
      started_on: d.date,
      // A closed past day — the stoppage began and ended on it. A human can
      // widen the range on review. working_days_lost stays NULL (never computed).
      ended_on: d.date,
      working_days_lost: null,
      description: d.description,
      // THE EVIDENCE SEAM (20261084): the district the verdict was derived from,
      // the join key the EOT pack uses to back-fill observed readings once a
      // human records this event.
      weather_district: d.district,
      // created_by NULL — no human authored it (the guard only checks membership
      // when created_by is set). status defaults to 'draft'; the guard forces it.
      created_by: null,
      // Deterministic idempotency key — a concurrent double insert collides on
      // delay_events_client_write_key_uidx (20261101).
      client_write_key: clientKey,
    });

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        // A concurrent pass already raised this exact (job, day) draft — done.
        deduped += 1;
        continue;
      }
      ok = false;
      console.error("[weather-delay-detect] draft insert failed", {
        jobId: d.jobId,
        date: d.date,
        error: error.message,
      });
      continue;
    }
    created += 1;
  }

  return {
    ok,
    ran: true,
    date,
    jobsConsidered: jobs.length,
    districtsResolved,
    skippedExisting,
    detected: detections.length,
    created,
    deduped,
    note: null,
  };
}
