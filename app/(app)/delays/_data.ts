import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { DelayEventRow } from "@/lib/eot/pack";

/**
 * Delays & EOT — the register's read layer.
 *
 * Every query runs on the tenant (user-JWT) client; the service-role client
 * is never used here.
 *
 * ACTIVE-ORG PINNING. RLS is the OUTER boundary, not the scope:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so an unpinned
 * read blends a dual-org member's two companies (#456/#463/#468). Every read
 * below carries its own `.eq("org_id", orgId)` predicate, supplied by the
 * caller so the scope is visible at the call site.
 *
 * LOUD READS. A rejected query must never render as "no delays recorded" —
 * on an EVIDENCE surface an empty register asserts the job ran clean, which
 * is a claim, not a fallback. Every read THROWS via
 * @/lib/supabase/read-failure on error; `[]`/`null` mean genuinely empty and
 * genuinely missing, nothing else. (The quality/_data.ts contract, verbatim.)
 */

const DELAY_COLS =
  "id, org_id, job_id, category, status, started_on, ended_on, working_days_lost, description, " +
  "diary_entry_id, variation_quote_id, weather_district, recorded_at, recorded_by, withdrawn_at, " +
  "withdrawn_by, created_by, created_at, updated_at";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFrom = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; extracting it unbound makes
// `this` undefined and supabase-js throws on the first call.
const tbl = (c: unknown) => (c as AnyFrom).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

export type DelayListRow = DelayEventRow & {
  org_id: string;
  withdrawn_by: string | null;
  created_by: string | null;
  updated_at: string;
};

export type DelayListItem = DelayListRow & { jobLabel: string | null };

/** The register: every delay event in the ACTIVE org, newest stoppage first. */
export async function listDelayEvents(orgId: string): Promise<DelayListItem[]> {
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("delay_events")
    .select(DELAY_COLS)
    .eq("org_id", orgId)
    .order("started_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw readFailure("delays: register", error as SupabaseReadError);
  const rows = (data ?? []) as DelayListRow[];
  if (rows.length === 0) return [];
  const labels = await loadJobLabels(orgId, rows.map((r) => r.job_id));
  return rows.map((r) => ({ ...r, jobLabel: labels.get(r.job_id) ?? null }));
}

/**
 * One delay event, pinned to the ACTIVE org. An event in a non-active org is
 * deliberately INDISTINGUISHABLE from a missing one: callers notFound() on null.
 */
export async function getDelayEvent(
  orgId: string,
  id: string,
): Promise<DelayListItem | null> {
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("delay_events")
    .select(DELAY_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("delays: event", error as SupabaseReadError);
  if (!data) return null;
  const row = data as DelayListRow;
  const labels = await loadJobLabels(orgId, [row.job_id]);
  return { ...row, jobLabel: labels.get(row.job_id) ?? null };
}

/** Batched job labels (customer name + scheduled date) — never one query per row. */
async function loadJobLabels(
  orgId: string,
  jobIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(jobIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw readFailure("delays: job labels", error);
  for (const j of data ?? []) {
    const customer = (j as unknown as { customer: { name: string | null } | null }).customer;
    const parts = [customer?.name ?? "Job", j.scheduled_date ?? null].filter(Boolean);
    out.set(j.id, parts.join(" · "));
  }
  return out;
}

type JobPickerRow = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

/**
 * Jobs the ACTIVE org can log a delay against (the quality job-picker idiom).
 *
 * PAGED (F-1 picker-completion class). This feeds the delay/EOT create form's
 * REQUIRED job <select>, and `jobs/[id]` deep-links `/delays/new?jobId=<id>` for
 * any job on the register. The old 200-row cap silently dropped every job older
 * than the 200 newest, so a deep-linked job past the cap had NO matching
 * <option> — the required select then discarded the preset and fell to the first
 * enabled option, a DIFFERENT job, and an untouched submit mis-attributed the
 * delay. Page the complete set on a stable, unique order (created_at desc + id
 * desc tiebreaker) so no row shifts across a page boundary and every job is
 * offered.
 */
export async function listJobOptions(
  orgId: string,
): Promise<Array<{ id: string; label: string }>> {
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
  if (error) throw readFailure("delays: job picker", error as SupabaseReadError);
  return (data ?? []).map((j) => {
    const customer = (j as unknown as { customer: { name: string | null } | null }).customer;
    const parts = [
      customer?.name ?? "Job",
      j.scheduled_date ?? null,
      j.status ? `(${j.status})` : null,
    ].filter(Boolean);
    return { id: j.id, label: parts.join(" · ") };
  });
}

/**
 * Diary entries that can EVIDENCE a delay on this job — the guard trigger
 * refuses any entry not filed against the same job, so only those are offered.
 */
export async function listDiaryOptionsForJob(
  orgId: string,
  jobId: string,
): Promise<Array<{ id: string; label: string }>> {
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("site_diary_entries")
    .select("id, entry_date, delays, work_summary")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("entry_date", { ascending: false })
    .limit(200);
  if (error) throw readFailure("delays: diary picker", error as SupabaseReadError);
  return ((data ?? []) as Array<{
    id: string;
    entry_date: string;
    delays: string | null;
    work_summary: string | null;
  }>).map((d) => {
    const summary = (d.delays || d.work_summary || "").slice(0, 60);
    return { id: d.id, label: summary ? `${d.entry_date} — ${summary}` : d.entry_date };
  });
}

/**
 * Variations on this job that a delay can point at. All of them are offered
 * (a delay often precedes the EoT ask); the pack separates EoT-carrying ones.
 */
export async function listVariationOptionsForJob(
  orgId: string,
  jobId: string,
): Promise<Array<{ id: string; label: string }>> {
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("quotes")
    .select("id, variation_number, title, eot_requested_completion_date")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .not("variation_number", "is", null)
    .order("variation_number", { ascending: true })
    .limit(200);
  if (error) throw readFailure("delays: variation picker", error as SupabaseReadError);
  return ((data ?? []) as Array<{
    id: string;
    variation_number: number | null;
    title: string | null;
    eot_requested_completion_date: string | null;
  }>).map((v) => ({
    id: v.id,
    label: `Variation #${String(v.variation_number ?? 0).padStart(3, "0")}${
      v.title ? ` — ${v.title}` : ""
    }${v.eot_requested_completion_date ? " (EoT requested)" : ""}`,
  }));
}
