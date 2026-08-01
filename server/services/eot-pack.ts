import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { loadJobProgress } from "@/server/services/job-progress";
import {
  assembleEotPack,
  type DelayEventRow,
  type DiaryEvidenceRow,
  type EotEvidencePack,
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
 * NO WEATHER READS. weather_readings / weather_watches (20261074) are dark
 * and empty; this service never queries them. The pack's
 * weatherEvidenceAvailable flag is HARD FALSE here — flipping it is the
 * weather activation lane's change, made when there is a provider to read.
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

  const pack = assembleEotPack({
    jobId,
    events: events.rows,
    diaryEntries: diary.rows,
    variations: variations.rows,
    // A failed progress read must not masquerade as "no readings": null +
    // failed:true, and the pure lib emits no progress gap for null.
    progress: progress.failed ? null : progress.summary,
    // HARD FALSE until the weather lane activates a provider (20261074).
    weatherEvidenceAvailable: false,
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
