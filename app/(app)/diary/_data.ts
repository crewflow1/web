import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { resolveJobAddress } from "@/lib/address";
import { ukDayStartMs, ukDayEndMs } from "@/lib/schedule/window";
import { summariseWindow } from "@/lib/weather/decision";
import { districtForAddress } from "@/lib/weather/postcode";
import { isWeatherAvailable } from "@/lib/weather/readiness";
import { suggestWeatherText } from "@/lib/site-diary/weather";
import { buildWeatherSnapshot } from "@/server/services/weather";

/**
 * Server-only data helpers for the diary pages.
 *
 * This used to rely on RLS alone ("fetched under the user JWT so RLS does the
 * org scoping"). That is wrong for a member of more than one organisation:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so the job picker
 * offered the OTHER company's jobs — and `site_diary_entries.job_id` has no
 * cross-org guard, so picking one filed this org's diary entry against another
 * org's job. Callers pass the ACTIVE org explicitly (#456 convention).
 */

export type JobOption = { id: string; label: string };

type JobPickerRow = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

/**
 * PAGED (F-1 picker-completion class). This feeds the diary job <select> on
 * both diary/new (preset) and diary/[id]/edit (re-render of the SAVED job_id).
 * The old 200-row cap silently dropped every job older than the 200 newest, so
 * an out-of-cap saved job was absent from the list — the picker then fell to the
 * empty "No job" option and an untouched save NULLed the diary entry's job link.
 * Page the complete set on a stable, unique order (created_at desc + id desc
 * tiebreaker) so no row shifts across a page boundary and every job is offered.
 * Mirrors delays/_data.ts (C70-E). (_form.tsx also preserve-injects the saved
 * job_id — belt-and-braces.)
 */
export async function listJobOptions(orgId: string): Promise<JobOption[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<JobPickerRow>((from, to) =>
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{ data: JobPickerRow[] | null; error: unknown }>,
  );
  if (error) throw readFailure("diary: job options", error as SupabaseReadError);
  return (data ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));
}

/**
 * The address columns needed to resolve a job to a postcode district — the job's
 * site-address override else the linked customer's address (resolveJobAddress).
 * Mirrors JOB_LOCATION_COLS in server/services/schedule-integrity.ts.
 */
type DiaryJobLocationRow = {
  id: string;
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

/**
 * Suggest the "weather" field for a NEW diary entry from the day's cached
 * `weather_readings` for the job's site location — the Master-Plan "automatic
 * diary". Returns a plain phrase (e.g. "4–11°C, gusts to 30 mph, 3.2 mm rain")
 * the form pre-fills as a default the author can overwrite, or `null` when there
 * is nothing honest to suggest.
 *
 * DARK-SAFE, ZERO-COST FIRST. The readiness short-circuit is taken here BEFORE
 * any read, mirroring buildWeatherSnapshot and the schedule signal: with no
 * provider bound — every environment today — this returns `null` without
 * touching a single row, so the diary is byte-identical to before this seam and
 * the field stays hand-typed. It NEVER fabricates weather: `null` on a dark
 * build, on a job with no resolvable postcode, and on a day the cache has no
 * reading for — in every one of those cases the caller falls back to the manual
 * field.
 *
 * `orgId` is the ACTIVE org, pinned with `.eq("org_id", ...)` ON TOP of RLS
 * (the #456 rule): a dual-org member must never be suggested another company's
 * weather against a job that isn't theirs, and job_id here comes straight from a
 * client-supplied query param.
 *
 * `date` is a `YYYY-MM-DD` day key; the window is that UK calendar day.
 *
 * On a hit the result carries the ACTIVE provider's licence `attribution` (the
 * CC-BY string), because the suggested phrase IS provider-derived data and that
 * string MUST be rendered wherever such data is shown — so the surface can
 * attribute the suggestion it pre-fills.
 */
export type DiaryWeatherSuggestion = {
  readonly text: string;
  readonly attribution: string | null;
};

export async function suggestDiaryWeather(input: {
  orgId: string;
  jobId: string | null | undefined;
  date: string | null | undefined;
}): Promise<DiaryWeatherSuggestion | null> {
  const jobId = (input.jobId ?? "").trim();
  const date = (input.date ?? "").trim();
  if (!jobId || !date) return null;

  // The dark short-circuit: no provider ⇒ provably no readings ⇒ nothing to
  // suggest, and not one row read. The common case, on every env today.
  if (!isWeatherAvailable()) return null;

  const from = ukDayStartMs(date);
  const to = ukDayEndMs(date);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null; // malformed date

  const supabase = await createClient();
  // Org-pinned on top of RLS (#456): resolve THIS org's job to its address. A
  // read failure or a missing/foreign job degrades to no suggestion, never a
  // throw — a hiccup must cost the pre-fill, never the new-entry page.
  const { data, error } = await (
    supabase
      .from("jobs")
      .select(
        "id, site_address_line1, site_address_line2, site_city, site_county, " +
          "site_postcode, site_country, " +
          "customer:customers ( address_line1, address_line2, city, county, postcode, country )",
      )
      .eq("org_id", input.orgId)
      .eq("id", jobId)
      .maybeSingle() as unknown as PromiseLike<{ data: DiaryJobLocationRow | null; error: unknown }>
  );
  if (error || !data) return null;

  const district = districtForAddress(resolveJobAddress(data, data.customer));
  if (district === null) return null; // no postcode ⇒ no location ⇒ no guess

  const snapshot = await buildWeatherSnapshot({
    orgId: input.orgId,
    district,
    // A description of the day's conditions, not a workability verdict.
    workTypes: [],
    from: new Date(from),
    to: new Date(to),
  });

  const window = snapshot.window;
  if (!window || window.readings.length === 0) return null; // no reading ⇒ manual field

  const { summary, coverage } = summariseWindow(window);
  const text = suggestWeatherText(summary, coverage);
  if (text === null) return null; // readings carried no describable metric

  return { text, attribution: snapshot.attribution };
}
