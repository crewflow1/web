import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-only data helpers for the diary pages. Jobs are fetched under the user
 * JWT so RLS does the org scoping.
 */

export type JobOption = { id: string; label: string };

export async function listJobOptions(): Promise<JobOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));
}
