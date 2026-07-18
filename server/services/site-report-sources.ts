import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  DiaryLite,
  RawSources,
  SnagLite,
  ToolboxLite,
} from "@/lib/site-reports/aggregate";

/**
 * Site Reports — fetch the source records a report may aggregate, scoped to a
 * job and a reporting period. Runs on the tenant (user-JWT) client so RLS scopes
 * every read to the caller's org; the `.eq("job_id", …)` narrows to the site.
 *
 * Performance: job + period scoped, selective columns, capped — never "load
 * every historical record". Three indexed reads (site management tables all
 * carry a per-job index).
 */

type Chain<T> = Promise<{ data: T[] | null }> & {
  eq: (k: string, v: unknown) => Chain<T>;
  gte: (k: string, v: unknown) => Chain<T>;
  lte: (k: string, v: unknown) => Chain<T>;
  order: (k: string, o: { ascending: boolean }) => Chain<T>;
  limit: (n: number) => Chain<T>;
};

function table<T>(client: unknown, name: string): { select: (c: string) => Chain<T> } {
  return (client as { from: (n: string) => unknown }).from(name) as unknown as {
    select: (c: string) => Chain<T>;
  };
}

export async function gatherReportSources(
  jobId: string,
  from: string,
  to: string,
): Promise<RawSources> {
  const supabase = await createClient();

  const [diaryRes, snagRes, toolboxRes] = await Promise.all([
    table<DiaryLite>(supabase, "site_diary_entries")
      .select("id, entry_date, weather, labour_count, work_summary, delays")
      .eq("job_id", jobId)
      .gte("entry_date", from)
      .lte("entry_date", to)
      .order("entry_date", { ascending: false })
      .limit(500),
    // Snags aren't period-bound the same way; a progress report shows the defect
    // state for the site, so we take the job's snags (capped) and let the author
    // curate. Their current status is what the client cares about.
    table<SnagLite>(supabase, "snags")
      .select("id, title, status, priority, location, trade, due_date")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(500),
    table<ToolboxLite>(supabase, "toolbox_talks")
      .select("id, talk_date, topic, presenter, attendee_count")
      .eq("job_id", jobId)
      .gte("talk_date", from)
      .lte("talk_date", to)
      .order("talk_date", { ascending: false })
      .limit(500),
  ]);

  return {
    diary: diaryRes.data ?? [],
    snags: snagRes.data ?? [],
    toolbox: toolboxRes.data ?? [],
  };
}
