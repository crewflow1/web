import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { loadJobProgress } from "@/server/services/job-progress";
import { buildWeatherSnapshot } from "@/server/services/weather";
import {
  isWeatherAvailable,
  isPostcodeDistrict,
  summariseWindow,
  type PostcodeDistrict,
} from "@/lib/weather";
import {
  assembleEotPack,
  type DelayEventRow,
  type DiaryEvidenceRow,
  type EotEvidencePack,
  type EotWeatherEvidence,
  type VariationEvidenceRow,
} from "@/lib/eot/pack";

/**
 * EOT evidence pack — the READ LAYER.
 *
 * FETCHES; does not decide. Every grouping, total, ordering and gap rule
 * lives in lib/eot/pack.ts (pure, unit-tested without a database). The same
 * split — and the same three scoping belts — as server/services/
 * job-progress.ts:
 *
 *   1. RLS — every read runs on the caller's tenant client (their JWT).
 *   2. `org_id` PINNED EXPLICITLY on every query. `current_org_ids()`
 *      returns EVERY org the viewer belongs to, so an RLS-only read blends a
 *      dual-org member's companies (the shipped-twice P0 class, #456/#468).
 *   3. `job_id` pinned wherever the table carries one.
 *
 * LOUD READS. Nothing here swallows a failure: each gather returns rows AND
 * error; `loadEotEvidencePack` folds them into a single `failed` flag the
 * caller MUST surface. An empty pack that means "the query was rejected" and
 * one that means "no delays were ever recorded" are different facts, and on
 * an evidence surface conflating them is the control failing open.
 *
 * PROGRESS is COMPOSED from server/services/job-progress.ts — the one
 * existing owner of the series merge — never re-implemented. If its reads
 * fail, the pack ships with progress:null and failed:true.
 *
 * WEATHER is READ THROUGH THE GOVERNED ACCESSOR, never a raw table query.
 * This service NEVER touches weather_readings / weather_watches directly; it
 * calls server/services/weather.ts → buildWeatherSnapshot, which owns the
 * readiness short-circuit and the watch-gated, org-scoped RLS read. Today that
 * accessor is dark (no provider, empty cache): `isWeatherAvailable()` is false,
 * so this service issues ZERO weather work, `weatherEvidenceAvailable` resolves
 * to false, and the pack is BYTE-IDENTICAL to before this seam was wired. When
 * a provider is activated the same code path resolves real observed readings for
 * each weather event's window and attaches them as evidence — no engineering
 * change required. A reading is never invented: an empty window yields no
 * evidence and the pack keeps its honest "provider dark" gap.
 *
 * PAGING via fetchAllRows (unique total order on `id`); chronology is the
 * pure lib's job.
 */

type Row = Record<string, unknown>;

/** Minimal self-returning builder view — the job-progress.ts idiom. */
export type EotClient = {
  from: (t: string) => EotBuilder;
};
type EotBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => EotBuilder;
  eq: (k: string, v: unknown) => EotBuilder;
  in: (k: string, v: readonly unknown[]) => EotBuilder;
  not: (k: string, op: string, v: unknown) => EotBuilder;
  order: (k: string, o: { ascending: boolean }) => EotBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

const DELAY_EVENT_COLS =
  "id, job_id, category, status, started_on, ended_on, working_days_lost, description, " +
  "diary_entry_id, variation_quote_id, weather_district, recorded_at, recorded_by, withdrawn_at, created_at";

/** Evidence columns only — diary `notes` (free internal commentary) stays out of the pack. */
const DIARY_COLS = "id, entry_date, weather, labour_count, work_summary, delays";

/**
 * No money columns. The pack is about TIME: the variation's identity, its
 * lifecycle position and its EoT dates. subtotal/total/cost_* are the
 * commercial lane's and have no place in a delay record.
 */
const VARIATION_COLS =
  "id, variation_number, title, status, accepted_at, " +
  "eot_requested_completion_date, eot_agreed_completion_date, eot_agreed_at";

export interface EotRead<T> {
  rows: T[];
  /** Non-null when the read failed; the caller MUST surface it. */
  error: unknown;
}

/** Every delay event on this job (all statuses — the pure lib files them). */
export async function gatherDelayEvents(
  db: EotClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<EotRead<DelayEventRow>> {
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("delay_events")
        .select(DELAY_EVENT_COLS)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return { rows: data as unknown as DelayEventRow[], error };
}

/**
 * The diary entries the events link to — fetched BY ID, org-pinned. The ids
 * come from rows RLS already admitted, and the org pin means a stale or
 * hostile id from another tenant resolves to nothing rather than to a page
 * of someone else's site record.
 */
export async function gatherLinkedDiaryEntries(
  db: EotClient,
  orgId: string,
  diaryEntryIds: readonly string[],
): Promise<EotRead<DiaryEvidenceRow>> {
  const ids = [...new Set(diaryEntryIds)];
  if (ids.length === 0) return { rows: [], error: null };
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("site_diary_entries")
        .select(DIARY_COLS)
        .eq("org_id", orgId)
        .in("id", ids)
        .order("id", { ascending: true })
        .range(from, to),
  );
  return { rows: data as unknown as DiaryEvidenceRow[], error };
}

/** Every variation on this job (quotes with variation_number set). */
export async function gatherJobVariations(
  db: EotClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<EotRead<VariationEvidenceRow>> {
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("quotes")
        .select(VARIATION_COLS)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .not("variation_number", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return { rows: data as unknown as VariationEvidenceRow[], error };
}

export interface EotPackView {
  pack: EotEvidencePack;
  /** True when ANY read failed — render the error state, never a thin pack. */
  failed: boolean;
}

/**
 * One inclusive UK-day window covering a delay event, as the half-open
 * `[from, to)` instant range the accessor expects. Dates are stored as plain
 * `YYYY-MM-DD`; the window runs from the START of `started_on` to the END of
 * `ended_on` (or `started_on` when the delay is still open / single-day). Pure
 * date arithmetic — no clock — so the same event always resolves the same
 * window.
 */
function delayWindow(startedOn: string, endedOn: string | null): { from: Date; to: Date } | null {
  const startMs = Date.parse(`${startedOn}T00:00:00Z`);
  const endDay = endedOn ?? startedOn;
  const endStartMs = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endStartMs)) return null;
  // Exclusive upper bound = start of the day AFTER the last delay day.
  return { from: new Date(startMs), to: new Date(endStartMs + 86_400_000) };
}

/**
 * Resolve observed-weather evidence for the recorded weather events on a job.
 *
 * DARK-SAFE BY CONSTRUCTION. When weather is not activated (every environment
 * today) this returns an empty map WITHOUT calling the accessor at all — so the
 * pack is byte-identical to before this seam existed. When activated, it reads
 * each weather event's window through the governed accessor (org-scoped,
 * watch-gated RLS) and reduces the readings to a deterministic evidence summary.
 * An event whose window holds no readings contributes NOTHING to the map — it
 * keeps its honest "provider dark" gap rather than a fabricated corroboration.
 */
async function resolveWeatherEvidence(
  orgId: string,
  events: readonly DelayEventRow[],
): Promise<Map<string, EotWeatherEvidence>> {
  const evidence = new Map<string, EotWeatherEvidence>();
  // The readiness short-circuit, taken here too so the dark build does zero
  // weather work (the accessor would also short-circuit, but skipping the loop
  // keeps the common case a single boolean check).
  if (!isWeatherAvailable()) return evidence;

  for (const e of events) {
    if (e.status !== "recorded" || e.category !== "weather") continue;
    if (!isPostcodeDistrict(e.weather_district)) continue;
    const window = delayWindow(e.started_on, e.ended_on);
    if (window === null) continue;

    const snapshot = await buildWeatherSnapshot({
      orgId,
      district: e.weather_district as PostcodeDistrict,
      // Evidence is the OBSERVED conditions, not a workability verdict — no work
      // types requested, just the raw readings for the window.
      workTypes: [],
      from: window.from,
      to: window.to,
    });

    const readings = snapshot.window?.readings ?? [];
    if (readings.length === 0) continue; // No reading ⇒ no evidence, never a guess.

    const { summary, coverage } = summariseWindow(snapshot.window!);
    evidence.set(e.id, {
      district: e.weather_district,
      readingCount: coverage.readingCount,
      minAirTempC: summary.minAirTempC,
      maxWindSpeedMs: summary.maxWindSpeedMs,
      maxWindGustMs: summary.maxWindGustMs,
      maxPrecipRateMmH: summary.maxPrecipRateMmH,
      totalPrecipMm: summary.totalPrecipMm,
    });
  }
  return evidence;
}

/**
 * Load one job's full evidence pack: delay events, linked diary entries,
 * variations, and progress context — assembled by the pure lib.
 *
 * `now` is injected for reproducibility; it stamps the pack header and feeds
 * the composed progress summary.
 */
export async function loadEotEvidencePack(
  orgId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<EotPackView> {
  const supabase = (await createClient()) as unknown as EotClient;

  const [events, variations, progress] = await Promise.all([
    gatherDelayEvents(supabase, orgId, jobId),
    gatherJobVariations(supabase, orgId, jobId),
    loadJobProgress(orgId, jobId, now),
  ]);

  const diaryIds = events.rows
    .map((e) => e.diary_entry_id)
    .filter((id): id is string => id !== null);
  const diary = await gatherLinkedDiaryEntries(supabase, orgId, diaryIds);

  // Dark-safe: an empty map in every environment today (provider unbound), so
  // `weatherEvidenceAvailable` is false and the pack keeps its honest gaps.
  const weatherEvidenceByEvent = await resolveWeatherEvidence(orgId, events.rows);

  const pack = assembleEotPack({
    jobId,
    events: events.rows,
    diaryEntries: diary.rows,
    variations: variations.rows,
    // A failed progress read must not masquerade as "no readings": null +
    // failed:true, and the pure lib emits no progress gap for null.
    progress: progress.failed ? null : progress.summary,
    // TRUE IFF the governed accessor returned real observed readings for at
    // least one weather event. False in every environment today (dark cache).
    weatherEvidenceAvailable: weatherEvidenceByEvent.size > 0,
    weatherEvidenceByEvent,
    generatedAt: now.toISOString(),
  });

  return {
    pack,
    failed:
      Boolean(events.error) ||
      Boolean(variations.error) ||
      Boolean(diary.error) ||
      progress.failed,
  };
}
